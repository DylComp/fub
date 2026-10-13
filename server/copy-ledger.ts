import type { CopyRecoveryEvidence } from "../src/copy-recovery-evidence.js";
import type { DispatchTicket } from "./copy-dispatch-store.js";
import type { CopyExecution, CopyPrepared } from "./copy-execution-model.js";
import { readCopyReceipt } from "./copy-receipt.js";
import type { Rpc } from "./funding.js";
import { randomUUID } from "node:crypto";
import bs58 from "bs58";
import { neon } from "@neondatabase/serverless";
import { isMint } from "../src/assets.js";
import {
  operationId,
  USDC,
  WSOL,
  TOKEN_PROGRAM,
} from "../src/funding-model.js";

// Internal only. No public endpoint accepts signals, enables plans or submits trades.
// A future verified feed supplies the leader transaction; a signing adapter must
// validate the quoted transaction before claiming a send with its signature/hash.
export type CopyBuySignal = {
  signature: string;
  mint: string;
  blockTime: number;
  planVersion: number;
  inputCents: number;
  minOutputRaw: string;
  outputDecimals: number;
  slippageBps: number;
  expiresAt: number;
};
export type CopyAttempt = {
  id: string;
  planId: string;
  wallet: string;
  mint: string;
  leaderSignature: string;
  state:
    | "reserved"
    | "submitting"
    | "unknown"
    | "confirmed"
    | "failed"
    | "released"
    | "skipped";
  reservedCents: number;
  side?: "buy" | "sell";
  inputRaw?: string;
  inputDecimals?: number;
  slippageBps?: number;
  positionBeforeRaw?: string;
  inventorySlot?: number;
  permissionId?: string;
  dispatchId?: string;
  recoveryEvidence?: CopyRecoveryEvidence;
  prepared?: CopyPrepared;
  execution?: CopyExecution;
  signature?: string;
  messageHash?: string;
  minOutputRaw: string;
  outputDecimals: number;
  expiresAt: number;
};
const signatureOk = (value: string) => {
  try {
    return (
      /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value) &&
      bs58.decode(value).length === 64
    );
  } catch {
    return false;
  }
};
const rawOk = (value: string) =>
  /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
export function rowAttempt(row: Record<string, any>): CopyAttempt {
  return {
    ...row.data,
    id: row.id,
    planId: row.plan_id,
    wallet: row.wallet,
    mint: row.mint,
    leaderSignature: row.leader_signature,
    state: row.state,
    side: row.side || "buy",
    reservedCents: Number(row.reserved_cents),
    slippageBps: Number(row.slippage_bps),
    signature: row.signature || undefined,
  };
}
export function copyLedger(url: string, dispatch?: DispatchTicket) {
  const client = () =>
    neon(url, { fetchOptions: { signal: AbortSignal.timeout(10000) } });
  const get = async (wallet: string, id: string) => {
    const sql = client(),
      rows =
        await sql`SELECT * FROM fomo_copy_attempts WHERE wallet=${wallet} AND id=${id}`;
    return rows[0] ? rowAttempt(rows[0]) : null;
  };
  return {
    get,
    async reserveBuy(
      wallet: string,
      planId: string,
      signal: CopyBuySignal,
    ): Promise<CopyAttempt | null> {
      const now = Date.now();
      if (
        !isMint(wallet) ||
        !operationId(planId) ||
        !signatureOk(signal.signature) ||
        !isMint(signal.mint) ||
        [USDC, WSOL].includes(signal.mint) ||
        !Number.isSafeInteger(signal.blockTime) ||
        signal.blockTime * 1000 > now + 5000 ||
        now - signal.blockTime * 1000 > 60000 ||
        !Number.isSafeInteger(signal.planVersion) ||
        signal.planVersion < 1 ||
        !Number.isSafeInteger(signal.inputCents) ||
        signal.inputCents < 100 ||
        signal.inputCents > 100000000 ||
        !rawOk(signal.minOutputRaw) ||
        !Number.isInteger(signal.outputDecimals) ||
        signal.outputDecimals < 0 ||
        signal.outputDecimals > 18 ||
        !Number.isInteger(signal.slippageBps) ||
        signal.slippageBps < 10 ||
        signal.slippageBps > 500 ||
        !Number.isSafeInteger(signal.expiresAt) ||
        signal.expiresAt <= now ||
        signal.expiresAt > now + 30000
      )
        throw new Error("The copy signal or quote is invalid or stale.");
      const id = randomUUID(),
        sql = client();
      // The lock is a separate statement: following statements get a fresh
      // READ COMMITTED snapshot after any competing wallet transaction finishes.
      await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${wallet},0))`,
        sql`WITH eligible AS (
          SELECT * FROM fomo_copy_authorized_plans p WHERE p.wallet=${wallet} AND p.id=${planId} AND p.enabled AND NOT p.archived
            AND NOT EXISTS(SELECT 1 FROM fomo_copy_controls control WHERE control.wallet=p.wallet)
            AND to_timestamp(${signal.expiresAt}/1000.0)<=p.permission_expires_at
            AND fomo_copy_dispatch_allowed(${wallet},p.id,${signal.signature},${dispatch?.id || null},${dispatch?.leaseId || null})
            AND p.version=${signal.planVersion} AND p.enabled_at<=to_timestamp(${signal.blockTime})
            AND (p.data->>'buyCents')::bigint=${signal.inputCents} AND (p.data->>'slippageBps')::integer>=${signal.slippageBps}
            AND to_timestamp(${signal.expiresAt}/1000.0)>statement_timestamp()
            AND to_timestamp(${signal.blockTime})>=statement_timestamp()-interval '60 seconds'
            AND EXISTS(SELECT 1 FROM fomo_copy_feed_events e JOIN fomo_copy_feed f ON f.plan_id=e.plan_id
              WHERE e.plan_id=p.id AND e.signature=${signal.signature} AND e.block_time=${signal.blockTime} AND NOT e.failed
                AND e.decision->>'kind'='swap' AND e.decision->>'side'='buy' AND e.decision->>'mint'=${signal.mint}
                AND (e.decision->>'tokenDecimals')::integer=${signal.outputDecimals} AND f.status='ready'
                AND COALESCE(e.decision->>'tokenProgram',${TOKEN_PROGRAM})=${TOKEN_PROGRAM}
                AND NOT EXISTS(SELECT 1 FROM fomo_copy_feed_events pending WHERE pending.plan_id=p.id AND pending.decision IS NULL))
            AND NOT EXISTS(SELECT 1 FROM fomo_copy_attempts WHERE wallet=${wallet} AND state IN ('reserved','submitting','unknown'))
            AND NOT EXISTS(SELECT 1 FROM fomo_token22_reservations WHERE wallet=${wallet} AND state='reserved')
            AND NOT EXISTS(SELECT 1 FROM fomo_copy_attempts WHERE plan_id=${planId} AND leader_signature=${signal.signature})
        ), budget AS (
          INSERT INTO fomo_copy_budgets(plan_id,day,reserved_cents,spent_cents)
          SELECT id,(statement_timestamp() AT TIME ZONE 'UTC')::date,${signal.inputCents},0 FROM eligible
          ON CONFLICT(plan_id,day) DO UPDATE SET reserved_cents=fomo_copy_budgets.reserved_cents+EXCLUDED.reserved_cents
          WHERE fomo_copy_budgets.spent_cents+fomo_copy_budgets.reserved_cents+EXCLUDED.reserved_cents <= (SELECT (data->>'dailyCents')::bigint FROM eligible)
          RETURNING plan_id
        ) INSERT INTO fomo_copy_attempts(id,plan_id,wallet,leader_signature,mint,budget_day,reserved_cents,plan_version,slippage_bps,state,expires_at,data)
          SELECT ${id},p.id,p.wallet,${signal.signature},${signal.mint},(statement_timestamp() AT TIME ZONE 'UTC')::date,${signal.inputCents},p.version,${signal.slippageBps},
            CASE WHEN b.plan_id IS NULL THEN 'skipped' ELSE 'reserved' END,to_timestamp(${signal.expiresAt}/1000.0),${JSON.stringify({ ...(dispatch ? { dispatchId: dispatch.id } : {}), minOutputRaw: signal.minOutputRaw, outputDecimals: signal.outputDecimals, expiresAt: signal.expiresAt })}::jsonb || jsonb_build_object('permissionId',p.permission_id::text)
          FROM eligible p LEFT JOIN budget b ON b.plan_id=p.id`,
      ]);
      const rows =
        await sql`SELECT * FROM fomo_copy_attempts WHERE wallet=${wallet} AND plan_id=${planId} AND leader_signature=${signal.signature}`;
      return rows[0] ? rowAttempt(rows[0]) : null;
    },
    async claim(
      wallet: string,
      id: string,
      signature: string,
      messageHash: string,
    ) {
      if (
        !operationId(id) ||
        !signatureOk(signature) ||
        !/^[0-9a-f]{64}$/.test(messageHash)
      )
        throw new Error("Invalid signed trade identity.");
      const sql = client();
      const [, , rows] = await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${wallet},0))`,
        sql`SELECT pg_advisory_xact_lock_shared(hashtextextended('copy-dispatch-claim',0))`,
        sql`UPDATE fomo_copy_attempts a SET state='submitting',signature=${signature},data=a.data || ${JSON.stringify({ messageHash })}::jsonb,updated_at=statement_timestamp()
          FROM fomo_copy_authorized_plans p WHERE a.wallet=${wallet} AND a.id=${id} AND a.state='reserved' AND a.side='buy' AND NOT (a.data ? 'prepared') AND a.expires_at>statement_timestamp()
            AND a.budget_day=(statement_timestamp() AT TIME ZONE 'UTC')::date AND p.id=a.plan_id AND p.enabled AND NOT p.archived
            AND NOT EXISTS(SELECT 1 FROM fomo_copy_controls control WHERE control.wallet=p.wallet) AND p.version=a.plan_version AND a.data->>'permissionId'=p.permission_id::text AND a.expires_at<=p.permission_expires_at
            AND fomo_copy_dispatch_allowed(a.wallet,a.plan_id,a.leader_signature,a.data->>'dispatchId',${dispatch?.leaseId || null})
            AND a.slippage_bps<=(p.data->>'slippageBps')::integer
            AND ((a.side='buy' AND a.reserved_cents=(p.data->>'buyCents')::bigint) OR (a.side='sell' AND a.reserved_cents=0 AND (p.data->>'copySells')::boolean))
          RETURNING a.*`,
      ]);
      return rows[0] ? rowAttempt(rows[0]) : null;
    },
    async noteRecovery(attempt: CopyAttempt, evidence: CopyRecoveryEvidence) {
      const sql = client();
      await sql`UPDATE fomo_copy_attempts SET data=data || jsonb_build_object('recoveryEvidence',${JSON.stringify(evidence)}::jsonb)
        WHERE wallet=${attempt.wallet} AND id=${attempt.id} AND signature=${attempt.signature || null} AND data->>'messageHash'=${attempt.messageHash || null} AND state IN('submitting','unknown')
          AND COALESCE((data->'recoveryEvidence'->>'checkedAt')::bigint,0)<=${evidence.checkedAt}`;
    },
    async markUnknown(wallet: string, id: string) {
      const sql = client();
      const rows =
        await sql`UPDATE fomo_copy_attempts SET state='unknown',updated_at=statement_timestamp() WHERE wallet=${wallet} AND id=${id} AND state='submitting' RETURNING *`;
      return rows[0] ? rowAttempt(rows[0]) : await get(wallet, id);
    },
    async confirmBuy(wallet: string, id: string, rpc: Rpc) {
      const attempt = await get(wallet, id);
      if (!attempt || !["submitting", "unknown"].includes(attempt.state))
        return attempt;
      if (attempt.side === "sell")
        throw new Error("Use sell settlement for a sell attempt.");
      const receipt = await readCopyReceipt(attempt, rpc);
      if (!receipt) return attempt;
      const sql = client();
      await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${wallet},0))`,
        sql`WITH eligible AS (
          SELECT * FROM fomo_copy_attempts WHERE wallet=${wallet} AND id=${id} AND state IN ('submitting','unknown')
            AND signature=${receipt.signature} AND data->>'messageHash'=${receipt.messageHash}
        ), budget AS (
          UPDATE fomo_copy_budgets b SET reserved_cents=b.reserved_cents-a.reserved_cents,spent_cents=b.spent_cents+a.reserved_cents
          FROM eligible a WHERE b.plan_id=a.plan_id AND b.day=a.budget_day AND b.reserved_cents>=a.reserved_cents RETURNING b.plan_id
        ), completed AS (
          UPDATE fomo_copy_attempts a SET state='confirmed',data=a.data || ${JSON.stringify({ receipt })}::jsonb,updated_at=statement_timestamp()
          FROM budget b WHERE a.id=${id} AND a.wallet=${wallet} AND a.plan_id=b.plan_id RETURNING a.*
        ) INSERT INTO fomo_copy_positions(plan_id,mint,raw_amount)
          SELECT plan_id,mint,${receipt.outputRaw}::numeric FROM completed
          ON CONFLICT(plan_id,mint) DO UPDATE SET raw_amount=fomo_copy_positions.raw_amount+EXCLUDED.raw_amount,revision=fomo_copy_positions.revision+1`,
      ]);
      return get(wallet, id);
    },
    async position(wallet: string, planId: string, mint: string) {
      const sql = client();
      const rows =
        await sql`SELECT x.raw_amount::text FROM fomo_copy_positions x JOIN fomo_copy_plans p ON p.id=x.plan_id
        WHERE p.wallet=${wallet} AND x.plan_id=${planId} AND x.mint=${mint}`;
      return rows[0]?.raw_amount || "0";
    },
    async releaseUnsent(wallet: string, id: string) {
      const sql = client();
      const [, rows] = await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${wallet},0))`,
        sql`WITH released AS (
          UPDATE fomo_copy_attempts SET state='released',updated_at=statement_timestamp() WHERE wallet=${wallet} AND id=${id} AND state='reserved' RETURNING *
        ), restored AS (
          UPDATE fomo_copy_budgets b SET reserved_cents=b.reserved_cents-r.reserved_cents FROM released r WHERE b.plan_id=r.plan_id AND b.day=r.budget_day RETURNING b.plan_id
        ) SELECT r.* FROM released r JOIN restored b ON b.plan_id=r.plan_id`,
      ]);
      return rows[0] ? rowAttempt(rows[0]) : null;
    },
  };
}
