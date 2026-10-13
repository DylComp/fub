import {validateSignedNativeExpiry,type SignedNativeExpiry} from './native-expiry-proof.js';
import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { isMint } from "../src/assets.js";
import { operationId } from "../src/funding-model.js";
import { token22SigningAuthority } from "./token2022-authority.js";
import type { Rpc } from "./funding.js";
import {
  raydium22ReviewHash,
  verifyRaydium22Review,
  verifyRaydium22SignedMessage,
  recoverRaydium22Execution,
  type Raydium22ExecutionReview,
  type Raydium22SignedExecution,
} from "./native-copy-review.js";

// No public API accepts these reviews. The caller must run the verified server
// simulation first. A journal claim is NOT owner consent or permission to send.
export type Token22Record = {
  id: string;
  wallet: string;
  state:
    | "prepared"
    | "signing"
    | "signed"
    | "confirmed"
    | "failed"
    | "canceled";
  review: Raydium22ExecutionReview;
  reviewHash: string;
  execution: Raydium22SignedExecution | null;
  signedExpiry?: SignedNativeExpiry;
};
export type Token22RecoveryClaim = {
  id: string;
  wallet: string;
  leaseId: string;
};
type Deferred = "busy" | "pending" | "unavailable" | "inconsistent";
function rowRecord(row: Record<string, any>): Token22Record {
  const review = row.review as Raydium22ExecutionReview;
  verifyRaydium22Review(review, row.review_hash);
  if (
    review.accounts.wallet !== row.wallet ||
    review.messageHash !== row.message_hash
  )
    throw Error("Token-2022 journal identity changed.");
  if(row.signed_expiry)validateSignedNativeExpiry(row.signed_expiry,{wallet:row.wallet,executionId:row.id,claimId:row.signing_claim,reviewHash:row.review_hash},review,row.signature);
  return {
    ...(row.signed_expiry?{signedExpiry:row.signed_expiry}:{}),
    id: row.id,
    wallet: row.wallet,
    state: row.state,
    review,
    reviewHash: row.review_hash,
    execution: row.signature
      ? {
          version: 1,
          reviewHash: row.review_hash,
          signed: row.signed_transaction,
          signature: row.signature,
        }
      : null,
  };
}
function identity(wallet: string, id: string) {
  if (!isMint(wallet) || !operationId(id))
    throw Error("Invalid execution identity.");
}

export function token22Journal(url: string) {
  const client = () =>
    neon(url, { fetchOptions: { signal: AbortSignal.timeout(8000) } });
  async function get(wallet: string, id: string) {
    identity(wallet, id);
    const sql = client(),
      rows =
        await sql`SELECT * FROM fomo_token22_executions WHERE id=${id} AND wallet=${wallet}`;
    return rows[0] ? rowRecord(rows[0]) : null;
  }
  async function defer(claim: Token22RecoveryClaim, outcome: Deferred) {
    identity(claim.wallet, claim.id);
    if (
      !operationId(claim.leaseId) ||
      !["busy", "pending", "unavailable", "inconsistent"].includes(outcome)
    )
      throw Error("Invalid recovery claim.");
    const sql = client();
    const rows =
      await sql`UPDATE fomo_token22_executions SET lease_id=NULL,lease_until=NULL,last_outcome=${outcome},
      last_checked_at=CASE WHEN ${outcome}='busy' THEN last_checked_at ELSE clock_timestamp() END,
      checks=CASE WHEN ${outcome}='busy' THEN checks ELSE LEAST(checks::bigint+1,2147483647)::integer END,
      next_check_at=clock_timestamp()+CASE WHEN ${outcome}='busy' THEN interval '20 seconds'
        ELSE LEAST(power(2,LEAST(checks,5)),30)*interval '1 minute' END,
      updated_at=clock_timestamp()
      WHERE id=${claim.id} AND wallet=${claim.wallet} AND state='signed' AND signed_expiry IS NULL AND lease_id=${claim.leaseId}
        AND lease_until>clock_timestamp() RETURNING id`;
    return rows.length === 1;
  }
  return {
    get,
    defer,
    async prepare(id: string, review: Raydium22ExecutionReview) {
      const wallet = review.accounts.wallet;
      identity(wallet, id);
      const digest = raydium22ReviewHash(review);
      verifyRaydium22Review(review, digest);
      if (review.reviewedAt > Date.now() || review.expiresAt <= Date.now())
        throw Error("Execution review is stale.");
      const sql = client();
      await sql`INSERT INTO fomo_token22_executions(id,wallet,message_hash,review_hash,review,expires_at)
        SELECT ${id},${wallet},${review.messageHash},${digest},${JSON.stringify(review)}::jsonb,to_timestamp(${review.expiresAt}/1000.0)
        WHERE to_timestamp(${review.expiresAt}/1000.0)>statement_timestamp()
        ON CONFLICT DO NOTHING`;
      const found = await get(wallet, id);
      return found?.reviewHash === digest ? found : null;
    },
    async beginSigning(wallet: string, id: string, reviewHash: string) {
      const saved = await get(wallet, id);
      if (
        !saved ||
        saved.reviewHash !== reviewHash ||
        saved.state !== "prepared" ||
        saved.review.expiresAt <= Date.now()
      )
        return null;
      const sql = client(),
        claim = randomUUID(),
        scopeHash = await token22SigningAuthority(
          url,
          wallet,
          id,
          saved.review,
        );
      const [, rows] = await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${wallet},0))`,
        sql`UPDATE fomo_token22_executions SET state='signing',signing_claim=${claim},updated_at=clock_timestamp()
        WHERE id=${id} AND wallet=${wallet} AND state='prepared' AND review_hash=${reviewHash}
          AND review=${JSON.stringify(saved.review)}::jsonb AND expires_at>clock_timestamp()
          AND (NOT EXISTS(SELECT 1 FROM fomo_token22_reservations r WHERE r.execution_id=${id}) OR
            EXISTS(SELECT 1 FROM fomo_token22_authorized_reservations r WHERE r.execution_id=${id} AND r.wallet=${wallet} AND r.scope_hash=${scopeHash}))
          RETURNING id`,
      ]);
      return rows.length === 1 ? claim : null;
    },
    // A requested signature is never automatically retried after a timeout.
    // Late valid bytes are retained for recovery, without granting a send claim.
    async saveSigned(
      wallet: string,
      id: string,
      claim: string,
      signed: string,
    ) {
      identity(wallet, id);
      if (!operationId(claim)) throw Error("Invalid signing claim.");
      const saved = await get(wallet, id);
      if (
        !saved ||
        !["signing", "signed", "confirmed", "failed"].includes(saved.state)
      )
        return false;
      const signature = verifyRaydium22SignedMessage(
          saved.review,
          saved.reviewHash,
          signed,
        ),
        sql = client();
      const rows =
        await sql`UPDATE fomo_token22_executions SET state='signed',signature=${signature},signed_transaction=${signed},signed_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE id=${id} AND wallet=${wallet} AND signing_claim=${claim} AND state='signing'
          AND review_hash=${saved.reviewHash} AND review=${JSON.stringify(saved.review)}::jsonb RETURNING id`;
      if (rows.length === 1) return true;
      const existing =
        await sql`SELECT id FROM fomo_token22_executions WHERE id=${id} AND wallet=${wallet}
        AND signing_claim=${claim} AND review_hash=${saved.reviewHash} AND state IN('signed','confirmed','failed')
        AND signature=${signature} AND signed_transaction=${signed}`;
      return existing.length === 1;
    },
    async cancelPrepared(wallet: string, id: string) {
      identity(wallet, id);
      const sql = client(),
        rows =
          await sql`UPDATE fomo_token22_executions SET state='canceled',updated_at=clock_timestamp()
        WHERE id=${id} AND wallet=${wallet} AND state='prepared' AND signing_claim IS NULL AND signature IS NULL RETURNING id`;
      return rows.length === 1;
    },
    async claimRecovery(): Promise<Token22RecoveryClaim | null> {
      const sql = client(),
        leaseId = randomUUID();
      const rows = await sql`WITH due AS (
        SELECT id FROM fomo_token22_executions WHERE state='signed' AND signed_expiry IS NULL AND next_check_at<=clock_timestamp()
          AND (lease_until IS NULL OR lease_until<clock_timestamp())
        ORDER BY next_check_at,id FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE fomo_token22_executions e SET lease_id=${leaseId},lease_until=clock_timestamp()+interval '45 seconds'
        FROM due WHERE e.id=due.id RETURNING e.id,e.wallet`;
      return rows[0]
        ? { id: rows[0].id, wallet: rows[0].wallet, leaseId }
        : null;
    },
    async recover(claim: Token22RecoveryClaim, rpc: Rpc) {
      identity(claim.wallet, claim.id);
      if (!operationId(claim.leaseId)) throw Error("Invalid recovery lease.");
      const sql = client(),
        rows =
          await sql`SELECT * FROM fomo_token22_executions WHERE id=${claim.id} AND wallet=${claim.wallet}
        AND state='signed' AND signed_expiry IS NULL AND lease_id=${claim.leaseId} AND lease_until>clock_timestamp()`;
      if (!rows[0]) return { kind: "stale" as const };
      let saved: Token22Record;
      try {
        saved = rowRecord(rows[0]);
      } catch {
        return {
          kind: (await defer(claim, "inconsistent"))
            ? ("inconsistent" as const)
            : ("stale" as const),
        };
      }
      if (!saved.execution) throw Error("Missing signed execution.");
      const result = await recoverRaydium22Execution(
        saved.review,
        saved.reviewHash,
        saved.execution,
        rpc,
      );
      if (result.kind !== "succeeded" && result.kind !== "failed")
        return {
          kind: (await defer(claim, result.kind))
            ? result.kind
            : ("stale" as const),
        };
      // The state change and the single outcome record commit together. No USDC
      // budget or live position is changed by this native-SOL execution journal.
      const state = result.kind === "succeeded" ? "confirmed" : "failed";
      const applied = await sql`WITH settled AS (
        UPDATE fomo_token22_executions SET state=${state},lease_id=NULL,lease_until=NULL,
          last_outcome=${state},checks=LEAST(checks::bigint+1,2147483647)::integer,
          last_checked_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE id=${claim.id} AND wallet=${claim.wallet} AND state='signed' AND signed_expiry IS NULL AND lease_id=${claim.leaseId}
          AND lease_until>clock_timestamp() AND review_hash=${saved.reviewHash} AND review=${JSON.stringify(saved.review)}::jsonb
          AND signature=${saved.execution.signature} AND signed_transaction=${saved.execution.signed}
        RETURNING id,wallet
      ) INSERT INTO fomo_token22_outcomes(execution_id,wallet,outcome)
        SELECT id,wallet,${JSON.stringify(result)}::jsonb FROM settled RETURNING execution_id`;
      return { kind: applied.length === 1 ? state : ("stale" as const) };
    },
    async outcome(wallet: string, id: string) {
      identity(wallet, id);
      const sql = client(),
        rows = await sql`SELECT o.outcome FROM fomo_token22_outcomes o
        JOIN fomo_token22_executions e ON e.id=o.execution_id AND e.wallet=o.wallet
        WHERE o.execution_id=${id} AND o.wallet=${wallet} AND e.state IN('confirmed','failed')`;
      return rows[0]?.outcome ?? null;
    },
  };
}
