import { createHash } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import canonicalize from "canonicalize";
import bs58 from "bs58";
import { operationId, USDC } from "../src/funding-model.js";
import { verifyCopyPermission } from "./copy-permission-model.js";
import { verifyCopySwapMessageSignature } from "./copy-swap.js";
import type { CopySigningRequest } from "./copy-dispatch-worker.js";

export class IsolatedSigningRefused extends Error {
  constructor() { super("Independent signing budget or request identity refused."); }
}
export function isolatedSigningIdentity(request: CopySigningRequest, leaderSignature: string, now = Date.now(), allowSell = false) {
  const p = request.permission.scope;
  const selling = allowSell && p.copySells && request.review.intent.outputMint === USDC && request.review.intent.inputMint !== USDC;
  if (verifyCopyPermission(p, request.permission.signature) !== request.permission.hash ||
      !Number.isSafeInteger(now) || !Number.isSafeInteger(request.expiresAt) ||
      !Number.isSafeInteger(request.review.expiresAt) ||
      !operationId(request.attemptId) || request.wallet !== p.wallet ||
      p.issuedAt > now || p.expiresAt <= now || request.expiresAt <= now ||
      request.expiresAt > Math.min(p.expiresAt, request.review.expiresAt) ||
      request.review.intent.wallet !== p.wallet ||
      (!selling && (request.review.intent.inputMint !== USDC ||
      request.review.intent.inputRaw !== String(BigInt(p.buyCents) * 10000n))) ||
      request.review.intent.slippageBps > p.slippageBps ||
      request.idempotencyKey !== `${request.attemptId}:${request.review.messageHash}` ||
      !/^[0-9a-f]{64}$/.test(request.review.messageHash) ||
      !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(leaderSignature) ||
      bs58.decode(leaderSignature).length !== 64 ||
      bs58.encode(bs58.decode(leaderSignature)) !== leaderSignature)
    throw new IsolatedSigningRefused();
  // Reserve the complete possible buy spend for this UTC day. Only private
  // unsigned-expiry proof can remove an unsent reservation. Application claims
  // that an uncertain signature failed are never sufficient.
  // Sells require the separate independent inventory ledger; this buy-budget
  // store never accepts a zero-cent sell reservation.
  const day = new Date(now).toISOString().slice(0, 10);
  if (new Date(request.review.expiresAt).toISOString().slice(0, 10) !== day)
    throw new IsolatedSigningRefused();
  const requestHash = createHash("sha256").update(canonicalize({
    version: 1, wallet: request.wallet, attemptId: request.attemptId,
    planId: p.planId, leaderSignature, permissionHash: request.permission.hash,
    unsigned: request.review.unsigned, messageHash: request.review.messageHash,
    expiresAt: request.review.expiresAt,
  })!).digest("hex");
  return { wallet: p.wallet, attemptId: request.attemptId, planId: p.planId,
    permissionHash: request.permission.hash, leaderSignature, requestHash,
    day, cents: selling ? 0 : p.buyCents, cap: p.dailyCents, expiresAt: request.review.expiresAt };
}
export type IsolatedSigningIdentity = ReturnType<typeof isolatedSigningIdentity>;
export function isolatedSigningBudget(databaseUrl: string) {
  const sql = () => neon(databaseUrl, { fetchOptions: { signal: AbortSignal.timeout(5000) } });
  return {
    async claim(i: IsolatedSigningIdentity): Promise<{ kind: "new" } | { kind: "signed"; signed: string }> {
      const db = sql();
      const [, inserted] = await db.transaction([
        db`SELECT pg_advisory_xact_lock(hashtextextended(${`${i.wallet}:${i.planId}`},0))`,
        db`INSERT INTO signer_copy_requests(attempt_id,wallet,plan_id,leader_signature,permission_hash,request_hash,day,reserved_cents,expires_at,unsigned_recovery)
          SELECT ${i.attemptId},${i.wallet},${i.planId},${i.leaderSignature},${i.permissionHash},${i.requestHash},${i.day}::date,${i.cents},to_timestamp(${i.expiresAt}/1000.0),true
          WHERE (clock_timestamp() AT TIME ZONE 'UTC')::date=${i.day}::date
            AND to_timestamp(${i.expiresAt}/1000.0)>clock_timestamp()
            AND COALESCE((SELECT sum(reserved_cents) FROM signer_copy_requests WHERE wallet=${i.wallet} AND plan_id=${i.planId} AND day=${i.day}::date AND unsigned_expired_at IS NULL),0)+${i.cents}<=${i.cap}
          ON CONFLICT DO NOTHING RETURNING attempt_id`,
      ]);
      if (inserted.length) return { kind: "new" };
      const rows = await db`SELECT signed_transaction FROM signer_copy_requests WHERE attempt_id=${i.attemptId} AND wallet=${i.wallet}
        AND request_hash=${i.requestHash} AND permission_hash=${i.permissionHash} AND state='signed' AND unsigned_expired_at IS NULL AND expires_at>clock_timestamp()`;
      if (rows.length) return { kind: "signed", signed: rows[0].signed_transaction as string };
      throw new IsolatedSigningRefused();
    },
    async complete(i: IsolatedSigningIdentity, signed: string) {
      const db = sql();
      const rows = await db`UPDATE signer_copy_requests SET state='signed',signed_transaction=${signed},updated_at=clock_timestamp()
        WHERE attempt_id=${i.attemptId} AND request_hash=${i.requestHash} AND state IN ('requested','uncertain') AND signed_transaction IS NULL RETURNING attempt_id,unsigned_expired_at`;
      if (rows.length !== 1 || rows[0].unsigned_expired_at) throw new IsolatedSigningRefused();
    },
    async uncertain(i: IsolatedSigningIdentity) {
      await sql()`UPDATE signer_copy_requests SET state='uncertain',updated_at=clock_timestamp()
        WHERE attempt_id=${i.attemptId} AND request_hash=${i.requestHash} AND state='requested'`;
    },
  };
}
export type IsolatedSigningBudget = ReturnType<typeof isolatedSigningBudget>;
// Invoke ONLY inside the isolated service's permission/chain gate. The budget
// does not verify leader activity, grant revocation, route simulation or holdings.
export async function independentlyBudgetedSignature(options: {
  request: CopySigningRequest; leaderSignature: string; budget: IsolatedSigningBudget;
  sign: () => Promise<string>; signal: AbortSignal;
}) {
  const r = structuredClone(options.request);
  const identity = isolatedSigningIdentity(r, options.leaderSignature);
  options.signal.throwIfAborted();
  const claim = await options.budget.claim(identity);
  if (claim.kind === "signed") {
    options.signal.throwIfAborted();
    if (r.expiresAt <= Date.now()) throw new IsolatedSigningRefused();
    verifyCopySwapMessageSignature(r.review, claim.signed);
    return claim.signed;
  }
  try {
    options.signal.throwIfAborted();
    if (r.expiresAt <= Date.now()) throw new IsolatedSigningRefused();
    const signed = await options.sign();
    verifyCopySwapMessageSignature(r.review, signed);
    await options.budget.complete(identity, signed);
    options.signal.throwIfAborted();
    if (r.expiresAt <= Date.now()) throw new IsolatedSigningRefused();
    return signed;
  } catch {
    await options.budget.uncertain(identity).catch(() => {});
    throw new IsolatedSigningRefused();
  }
}
