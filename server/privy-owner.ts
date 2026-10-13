import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import canonicalize from "canonicalize";
import { isMint } from "../src/assets.js";

export class EnrollmentRefused extends Error {
  constructor() { super("Wallet ownership or background permission could not be verified."); }
}
// Only a verified wallet missing this signer is an invitation to delegate.
// Provider outages, changed policies and malformed replies are not.
export class EnrollmentDelegationRequired extends EnrollmentRefused {}
export const providerId = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9]{20,40}$/.test(value);
export const privyDid = (value: unknown): value is string => typeof value === "string" && /^did:privy:[a-z0-9]{20,40}$/.test(value);
export type SignerPolicy = { signerId: string; policyId: string; policyDigest: string; publicKey: string };
export type OwnerBinding = { wallet: string; walletId: string; userId: string; ownerId: string };
export function policyDigest(policy: Record<string, unknown>) {
  // Fingerprint the complete effective rules, including conditions and owner.
  const body = { version: policy.version, chain_type: policy.chain_type, rules: policy.rules, owner_id: policy.owner_id };
  if (body.version !== "1.0" || body.chain_type !== "solana" || !Array.isArray(body.rules) || !providerId(body.owner_id)) throw new EnrollmentRefused();
  return createHash("sha256").update(canonicalize(body)!).digest("hex");
}
export function privyAccessVerifier(appId: string, keys?: JWTVerifyGetKey) {
  if (!providerId(appId)) throw new EnrollmentRefused();
  const jwks = keys ?? createRemoteJWKSet(new URL(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`), { timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 600000 });
  return async (token: string): Promise<string> => {
    try {
      if (typeof token !== "string" || token.length > 8192) throw Error();
      const { payload, protectedHeader } = await jwtVerify(token, jwks, {
        algorithms: ["ES256"], issuer: "privy.io", audience: appId,
        requiredClaims: ["sub", "iss", "aud", "iat", "exp", "sid"], maxTokenAge: "1h", clockTolerance: 0,
      });
      if (!privyDid(payload.sub) || typeof payload.sid !== "string" || !payload.sid ||
          payload.aud !== appId || "linked_accounts" in payload || protectedHeader.typ === "id+jwt" ||
          !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat) ||
          payload.exp! <= payload.iat! || payload.exp! - payload.iat! > 3600) throw Error();
      return payload.sub;
    } catch { throw new EnrollmentRefused(); }
  };
}
// Read-only provider access for the isolated service. No export, signing, user
// authentication-key retrieval, wallet mutation, redirect, or dynamic host.
export function privyOwnershipReader(config: { appId: string; appSecret: string; policy: SignerPolicy; fetcher?: typeof fetch }) {
  if (!providerId(config.appId) || !config.appSecret || /[\s:]/.test(config.appSecret) ||
      !providerId(config.policy.signerId) || !providerId(config.policy.policyId) ||
      !/^[0-9a-f]{64}$/.test(config.policy.policyDigest) || !config.policy.publicKey) throw new EnrollmentRefused();
  const auth = `Basic ${Buffer.from(`${config.appId}:${config.appSecret}`).toString("base64")}`;
  const expected = structuredClone(config.policy), fetcher = config.fetcher ?? fetch;
  async function read(path: string, signal: AbortSignal): Promise<Record<string, any>> {
    signal.throwIfAborted();
    const response = await fetcher(`https://api.privy.io/v1/${path}`, {
      headers: { Authorization: auth, "privy-app-id": config.appId }, redirect: "error", cache: "no-store", signal,
    });
    if (!response.ok || !response.body || Number(response.headers.get("content-length")) > 65536) { await response.body?.cancel(); throw new EnrollmentRefused(); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 65536) throw new EnrollmentRefused(); chunks.push(part.value); }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    signal.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  return async (input: Omit<OwnerBinding, "ownerId">, delegated: boolean, external: AbortSignal): Promise<OwnerBinding> => {
    try {
      if (!privyDid(input.userId) || !providerId(input.walletId) || !isMint(input.wallet)) throw Error();
      const signal = AbortSignal.any([external, AbortSignal.timeout(8000)]);
      const w = await read(`wallets/${input.walletId}`, signal);
      if (w.id !== input.walletId || w.address !== input.wallet || w.chain_type !== "solana" ||
          w.archived_at !== null || !Number.isSafeInteger(w.imported_at) || w.imported_at <= 0 ||
          !providerId(w.owner_id)) throw Error();
      const owner = await read(`key_quorums/${w.owner_id}`, signal);
      // Entity/profile association is not ownership. Require the actual owner
      // quorum to contain this authenticated user alone, with no service key.
      if (owner.id !== w.owner_id || owner.authorization_threshold !== 1 ||
          !Array.isArray(owner.user_ids) || owner.user_ids.length !== 1 || owner.user_ids[0] !== input.userId ||
          !Array.isArray(owner.authorization_keys) || owner.authorization_keys.length !== 0 ||
          !Array.isArray(owner.key_quorum_ids) || owner.key_quorum_ids.length !== 0) throw Error();
      if (delegated) {
        if (!Array.isArray(w.additional_signers)) throw Error();
        const matches = w.additional_signers.filter((s: any) => s.signer_id === expected.signerId);
        if (matches.length === 0) throw new EnrollmentDelegationRequired();
        if (matches.length !== 1 || !Array.isArray(matches[0].override_policy_ids) ||
            matches[0].override_policy_ids.length !== 1 || matches[0].override_policy_ids[0] !== expected.policyId) throw Error();
        const quorum = await read(`key_quorums/${expected.signerId}`, signal);
        if (quorum.id !== expected.signerId || quorum.authorization_threshold !== 1 ||
            (quorum.user_ids !== null && (!Array.isArray(quorum.user_ids) || quorum.user_ids.length !== 0)) ||
            !Array.isArray(quorum.authorization_keys) || quorum.authorization_keys.length !== 1 ||
            quorum.authorization_keys[0].public_key !== expected.publicKey ||
            !Array.isArray(quorum.key_quorum_ids) || quorum.key_quorum_ids.length !== 0) throw Error();
        const policy = await read(`policies/${expected.policyId}`, signal);
        if (policy.id !== expected.policyId || policyDigest(policy) !== expected.policyDigest) throw Error();
      }
      signal.throwIfAborted();
      return { ...input, ownerId: w.owner_id };
    } catch (error) { if (error instanceof EnrollmentDelegationRequired) throw error; throw new EnrollmentRefused(); }
  };
}
