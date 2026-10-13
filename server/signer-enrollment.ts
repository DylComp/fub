import {matchesFubOrigin} from '../src/fub-origin.js';
import { createPublicKey, randomUUID, verify } from "node:crypto";
import bs58 from "bs58";
import { enrollmentMessage, type EnrollmentChallenge } from "../src/signer-enrollment-model.js";
import { EnrollmentRefused, EnrollmentDelegationRequired, type OwnerBinding, type SignerPolicy } from "./privy-owner.js";
import type { SignerEnrollmentStore, EnrollmentRecord } from "./signer-enrollment-store.js";
import { isMint } from "../src/assets.js";

export function verifyEnrollmentSignature(c: EnrollmentChallenge, signature: string) {
  try {
    if (typeof signature !== "string" || signature.length > 88) throw Error();
    const bytes = bs58.decode(signature);
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bs58.decode(c.wallet)]), format: "der", type: "spki" });
    if (bytes.length !== 64 || bs58.encode(bytes) !== signature || !verify(null, Buffer.from(enrollmentMessage(c)), key, bytes)) throw Error();
  } catch { throw new EnrollmentRefused(); }
}
export type EnrolledWallet = { walletId: string; check: (signal: AbortSignal) => Promise<void> };
// Service layer, not a public web API. Tokens are used only to authenticate the
// owner, never exchanged for Privy authorization keys or persisted in storage.
export function signerEnrollment(options: {
  appId: string; origin: string; policy: SignerPolicy; store: SignerEnrollmentStore;
  authenticate: (accessToken: string) => Promise<string>;
  ownership: (binding: Omit<OwnerBinding, "ownerId">, delegated: boolean, signal: AbortSignal) => Promise<OwnerBinding>;
}) {
  const { store } = options, config = structuredClone({ appId: options.appId, origin: options.origin, policy: options.policy });
  function sameConfig(c: EnrollmentChallenge) {
    if (c.appId !== config.appId || !matchesFubOrigin(c.origin, config.origin) || c.signerId !== config.policy.signerId ||
        c.policyId !== config.policy.policyId || c.policyDigest !== config.policy.policyDigest) throw new EnrollmentRefused();
  }
  async function readOwner(c: EnrollmentChallenge, signal: AbortSignal) {
    const owner = await options.ownership({ wallet: c.wallet, walletId: c.walletId, userId: c.userId }, true, signal);
    if (owner.ownerId !== c.ownerId) throw new EnrollmentRefused();
  }
  function validActive(record: EnrollmentRecord, wallet: string, permissionIssuedAt: number) {
    const c = record.challenge;
    sameConfig(c);
    if (record.state !== "active" || c.wallet !== wallet || !record.signature || !record.activatedAt ||
        !Number.isSafeInteger(permissionIssuedAt) || permissionIssuedAt < record.activatedAt ||
        permissionIssuedAt > Date.now() || c.expiresAt <= Date.now()) throw new EnrollmentRefused();
    verifyEnrollmentSignature(c, record.signature);
  }
  function publicStatus(row: EnrollmentRecord) {
    let compatible = true;
    try { sameConfig(row.challenge); } catch { compatible = false; }
    return { id: row.challenge.id, wallet: row.challenge.wallet,
      state: row.state === "revoked" ? "revoked" : (row.challenge.expiresAt <= Date.now() || (row.state === "pending" && row.challenge.challengeExpiresAt <= Date.now())) ? "expired" : !compatible ? "outdated" : row.state,
      expiresAt: row.challenge.expiresAt, providerAccess: "unchecked" as const };
  }
  return {
    async access(accessToken: string, wallet: string, walletId: string, signal: AbortSignal) {
      const userId = await options.authenticate(accessToken);
      await options.ownership({ wallet, walletId, userId }, false, signal);
      let state: 'ready' | 'approval-required' = 'ready';
      try { await options.ownership({ wallet, walletId, userId }, true, signal); }
      catch (error) { if (!(error instanceof EnrollmentDelegationRequired)) throw error; state = 'approval-required'; }
      signal.throwIfAborted();
      return { wallet, walletId, userId, appId: config.appId, signerId: config.policy.signerId,
        policyId: config.policy.policyId, policyDigest: config.policy.policyDigest, state, checkedAt: Date.now() };
    },
    async list(accessToken: string, wallet: string) {
      if (!isMint(wallet)) throw new EnrollmentRefused();
      const userId = await options.authenticate(accessToken);
      return { wallet, permissions: (await store.list(wallet, userId)).map(publicStatus) };
    },
    async prepare(accessToken: string, wallet: string, walletId: string, durationMs: number, signal: AbortSignal, requestOrigin = config.origin) {
      if (!matchesFubOrigin(requestOrigin, config.origin)) throw new EnrollmentRefused();
      if (!Number.isSafeInteger(durationMs) || durationMs < 600000 || durationMs > 7 * 86400000) throw new EnrollmentRefused();
      signal.throwIfAborted();
      const userId = await options.authenticate(accessToken);
      const binding = await options.ownership({ wallet, walletId, userId }, false, signal);
      signal.throwIfAborted();
      const now = Date.now();
      const base = { version: 1 as const, id: randomUUID(), ...binding, appId: config.appId, origin: requestOrigin,
        signerId: config.policy.signerId, policyId: config.policy.policyId, policyDigest: config.policy.policyDigest,
        issuedAt: now, challengeExpiresAt: now + 300000, expiresAt: now + durationMs };
      enrollmentMessage({ ...base, epoch: 0 });
      const challenge = await store.issue(base);
      return { challenge, message: enrollmentMessage(challenge) };
    },
    async activate(accessToken: string, id: string, signature: string, signal: AbortSignal, requestOrigin?: string) {
      const userId = await options.authenticate(accessToken), row = await store.get(id, userId), c = row.challenge;
      sameConfig(c);
      if (requestOrigin !== undefined && (requestOrigin !== c.origin || !matchesFubOrigin(requestOrigin, config.origin))) throw new EnrollmentRefused();
      verifyEnrollmentSignature(c, signature);
      if (row.state === "revoked" || c.expiresAt <= Date.now() ||
          (row.state === "pending" && c.challengeExpiresAt <= Date.now())) throw new EnrollmentRefused();
      await readOwner(c, signal);
      signal.throwIfAborted();
      await store.activate(c, signature);
    },
    async status(accessToken: string, id: string) {
      const userId = await options.authenticate(accessToken), row = await store.get(id, userId);
      return publicStatus(row);
    },
    async stop(accessToken: string, id: string) {
      // Works during a provider metadata outage. JWT validation may need JWKS
      // refresh, but neither signing nor a provider mutation is needed to stop.
      const userId = await options.authenticate(accessToken);
      await store.stop(id, userId);
    },
    async resolve(wallet: string, permissionIssuedAt: number, signal: AbortSignal): Promise<EnrolledWallet> {
      signal.throwIfAborted();
      const first = await store.active(wallet);
      validActive(first, wallet, permissionIssuedAt);
      async function check(active: AbortSignal) {
        active.throwIfAborted();
        const row = await store.active(wallet);
        validActive(row, wallet, permissionIssuedAt);
        if (row.challenge.id !== first.challenge.id) throw new EnrollmentRefused();
        await readOwner(row.challenge, active);
        // Re-read after network work: a stop during provider lookup wins.
        const after = await store.active(wallet);
        validActive(after, wallet, permissionIssuedAt);
        if (after.challenge.id !== first.challenge.id) throw new EnrollmentRefused();
        active.throwIfAborted();
      }
      await check(signal);
      return { walletId: first.challenge.walletId, check };
    },
  };
}
