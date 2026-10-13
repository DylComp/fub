import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { isEvmAddress } from '../src/networks.js';
import { EnrollmentRefused, providerId, privyDid, type OwnerBinding, type SignerPolicy } from './privy-owner.js';
export function cashPolicyDigest(policy: Record<string, unknown>) {
 const body = {version:policy.version, chain_type:policy.chain_type, rules:policy.rules, owner_id:policy.owner_id};
 if (body.version !== '1.0' || body.chain_type !== 'ethereum' || !Array.isArray(body.rules) || !providerId(body.owner_id)) throw new EnrollmentRefused();
 return createHash('sha256').update(canonicalize(body)!).digest('hex');
}
// Read-only provider access for the isolated service. No export, signing, user
// authentication-key retrieval, wallet mutation, redirect, or dynamic host.
export function privyCashOwnershipReader(config: { appId: string; appSecret: string; policy: SignerPolicy; fetcher?: typeof fetch }) {
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
    if (!response.ok || !response.body || Number(response.headers.get("content-length")) > 65536) { void response.body?.cancel().catch(() => {}); throw new EnrollmentRefused(); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    const cancel=()=>{void reader.cancel().catch(()=>{});};
    signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
    try {
      for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 65536) throw new EnrollmentRefused(); chunks.push(part.value); }
    } finally { signal.removeEventListener('abort',cancel);cancel();reader.releaseLock(); }
    signal.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  return async (input: Omit<OwnerBinding, "ownerId">, delegated: boolean, external: AbortSignal): Promise<OwnerBinding> => {
    try {
      if (!privyDid(input.userId) || !providerId(input.walletId) || !isEvmAddress(input.wallet) || input.wallet !== input.wallet.toLowerCase()) throw Error();
      const signal = AbortSignal.any([external, AbortSignal.timeout(8000)]);
      const w = await read(`wallets/${input.walletId}`, signal);
      if (w.id !== input.walletId || typeof w.address !== "string" || w.address.toLowerCase() !== input.wallet || w.chain_type !== "ethereum" ||
          w.archived_at !== null || w.imported_at !== null ||
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
        if (matches.length !== 1 || !Array.isArray(matches[0].override_policy_ids) ||
            matches[0].override_policy_ids.length !== 1 || matches[0].override_policy_ids[0] !== expected.policyId) throw Error();
        const quorum = await read(`key_quorums/${expected.signerId}`, signal);
        if (quorum.id !== expected.signerId || quorum.authorization_threshold !== 1 ||
            (quorum.user_ids !== null && (!Array.isArray(quorum.user_ids) || quorum.user_ids.length !== 0)) ||
            !Array.isArray(quorum.authorization_keys) || quorum.authorization_keys.length !== 1 ||
            quorum.authorization_keys[0].public_key !== expected.publicKey ||
            !Array.isArray(quorum.key_quorum_ids) || quorum.key_quorum_ids.length !== 0) throw Error();
        const policy = await read(`policies/${expected.policyId}`, signal);
        if (policy.id !== expected.policyId || cashPolicyDigest(policy) !== expected.policyDigest) throw Error();
      }
      signal.throwIfAborted();
      return { ...input, ownerId: w.owner_id };
    } catch { throw new EnrollmentRefused(); }
  };
}
