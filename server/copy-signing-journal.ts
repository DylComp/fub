import { createHash, randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { operationId } from "../src/funding-model.js";
import { isMint } from "../src/assets.js";
import {
  verifyCopySwapSignature,
  verifyCopySwapMessageSignature,
} from "./copy-swap.js";
import type {
  CopySigningAdapter,
  CopySigningRequest,
} from "./copy-dispatch-worker.js";

type Identity = {
  attemptId: string;
  wallet: string;
  messageHash: string;
  permissionHash: string;
  requestHash: string;
  unsigned: string;
  expiresAt: number;
};
type Claim =
  | { kind: "new"; claimId: string }
  | { kind: "signed"; signed: string }
  | { kind: "blocked" };
type Failure =
  | "canceled"
  | "provider_error"
  | "invalid_signature"
  | "storage_error";
export type SigningJournal = {
  begin(identity: Identity): Promise<Claim>;
  complete(
    identity: Identity,
    claimId: string,
    signed: string,
  ): Promise<boolean>;
  fail(
    identity: Identity,
    claimId: string,
    reason: Failure,
    called: boolean,
  ): Promise<void>;
};
export class CopySigningJournalBlocked extends Error {
  constructor() {
    super(
      "Signing request is unresolved or changed. Provider access is blocked.",
    );
  }
}
function signingIdentity(request: CopySigningRequest): Identity {
  const hash = /^[0-9a-f]{64}$/;
  if (
    !operationId(request.attemptId) ||
    !isMint(request.wallet) ||
    !hash.test(request.review.messageHash) ||
    !hash.test(request.permission.hash) ||
    request.idempotencyKey !==
      `${request.attemptId}:${request.review.messageHash}` ||
    !Number.isSafeInteger(request.expiresAt) ||
    request.expiresAt <= Date.now() ||
    request.expiresAt > request.review.expiresAt ||
    typeof request.review.unsigned !== "string" ||
    request.review.unsigned.length > 1644
  )
    throw new CopySigningJournalBlocked();
  // Fixed array order survives JSONB object-key reordering. A new dispatch lease
  // may reuse the same signed message only after the outer gate reauthorizes it.
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify([
        1,
        request.attemptId,
        request.wallet,
        request.permission.hash,
        request.review.messageHash,
        request.review.unsigned,
        request.review.expiresAt,
      ]),
    )
    .digest("hex");
  return {
    attemptId: request.attemptId,
    wallet: request.wallet,
    messageHash: request.review.messageHash,
    permissionHash: request.permission.hash,
    requestHash,
    unsigned: request.review.unsigned,
    expiresAt: request.review.expiresAt,
  };
}

export function signingJournal(url: string): SigningJournal {
  const client = () =>
    neon(url, { fetchOptions: { signal: AbortSignal.timeout(5000) } });
  return {
    async begin(i) {
      const sql = client(),
        claimId = randomUUID();
      const inserted =
        await sql`INSERT INTO fomo_copy_signing_requests(attempt_id,wallet,message_hash,permission_hash,request_hash,claim_id,expires_at)
        SELECT a.id,a.wallet,${i.messageHash},${i.permissionHash},${i.requestHash},${claimId},to_timestamp(${i.expiresAt}/1000.0)
        FROM fomo_copy_attempts a JOIN fomo_copy_permissions g ON g.id::text=a.data->>'permissionId'
        WHERE a.id=${i.attemptId} AND a.wallet=${i.wallet} AND a.state='reserved' AND a.signature IS NULL
          AND a.expires_at>statement_timestamp() AND g.scope_hash=${i.permissionHash}
          AND a.data->'prepared'->'review'->>'messageHash'=${i.messageHash}
          AND a.data->'prepared'->'review'->>'unsigned'=${i.unsigned}
          AND (a.data->'prepared'->'review'->>'expiresAt')::bigint=${i.expiresAt}
        ON CONFLICT(attempt_id) DO NOTHING RETURNING claim_id`;
      if (inserted.length) return { kind: "new", claimId };
      const rows =
        await sql`SELECT state,signed_transaction FROM fomo_copy_signing_requests
        WHERE attempt_id=${i.attemptId} AND wallet=${i.wallet} AND request_hash=${i.requestHash}
          AND message_hash=${i.messageHash} AND permission_hash=${i.permissionHash} AND expires_at>statement_timestamp()`;
      if (rows[0]?.state === "signed")
        return { kind: "signed", signed: rows[0].signed_transaction };
      return { kind: "blocked" };
    },
    async complete(i, claimId, signed) {
      const sql = client();
      // Preserve late valid results for audit/reconciliation, including after a
      // stop. The caller still checks cancellation/expiry and the gate rechecks
      // authority before these bytes can reach submission.
      const rows =
        await sql`UPDATE fomo_copy_signing_requests SET state='signed',signed_transaction=${signed},updated_at=statement_timestamp()
        WHERE attempt_id=${i.attemptId} AND wallet=${i.wallet} AND claim_id=${claimId}
          AND request_hash=${i.requestHash} AND state='requested' RETURNING attempt_id`;
      return rows.length === 1;
    },
    async fail(i, claimId, reason, called) {
      const sql = client();
      await sql`UPDATE fomo_copy_signing_requests SET state=${called ? "uncertain" : "abandoned"},reason=${reason},updated_at=statement_timestamp()
        WHERE attempt_id=${i.attemptId} AND wallet=${i.wallet} AND claim_id=${claimId}
          AND request_hash=${i.requestHash} AND state='requested'`;
    },
  };
}

// This is deduplication and durable evidence, not authorization or custody policy.
// Dispatch MUST put it inside copySigningGate. Cached bytes take the same fresh
// owner/plan/lease/RPC checks as a new provider response. No broadcasting here.
export function journaledCopySigner(
  store: SigningJournal,
  provider: CopySigningAdapter,
): CopySigningAdapter {
  return async (request, signal) => {
    signal.throwIfAborted();
    const input = structuredClone(request),
      identity = signingIdentity(input);
    const claim = await store.begin(identity);
    if (claim.kind === "blocked") throw new CopySigningJournalBlocked();
    if (claim.kind === "signed") {
      signal.throwIfAborted();
      if (Date.now() >= input.expiresAt) throw new CopySigningJournalBlocked();
      verifyCopySwapSignature(input.review, claim.signed);
      return claim.signed;
    }
    let called = false,
      reason: Failure = "canceled";
    try {
      signal.throwIfAborted();
      if (Date.now() >= input.expiresAt) throw new CopySigningJournalBlocked();
      reason = "provider_error";
      called = true;
      const signed = await provider(structuredClone(input), signal);
      reason = "invalid_signature";
      verifyCopySwapMessageSignature(input.review, signed);
      reason = "storage_error";
      if (!(await store.complete(identity, claim.claimId, signed)))
        throw new CopySigningJournalBlocked();
      signal.throwIfAborted();
      if (Date.now() >= input.expiresAt) throw new CopySigningJournalBlocked();
      return signed;
    } catch {
      // If persistence is unavailable, 'requested' itself prevents retries.
      // Never replace a verified signed record with an uncertainty marker.
      await store.fail(identity, claim.claimId, reason, called).catch(() => {});
      throw new CopySigningJournalBlocked();
    }
  };
}
