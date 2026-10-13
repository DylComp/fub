import type { DispatchTicket } from "./copy-dispatch-store.js";
import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { isMint } from "../src/assets.js";
import { proportionalSell } from "../src/copy-account.js";
import {
  operationId,
  TOKEN_PROGRAM,
  USDC,
  WSOL,
} from "../src/funding-model.js";
import { signatureValid } from "./copy-classifier.js";
import { copyLedger, rowAttempt } from "./copy-ledger.js";
import { readCopyInventory } from "./copy-inventory.js";
import { readCopyReceipt } from "./copy-receipt.js";
import type { CopyAttempt } from "./copy-ledger.js";
import type { Rpc } from "./funding.js";
export type CopySellSignal = {
  signature: string;
  mint: string;
  blockTime: number;
  planVersion: number;
  inputRaw: string;
  inputDecimals: number;
  minOutputRaw: string;
  slippageBps: number;
  expiresAt: number;
};
const positiveRaw = (value: string) =>
  typeof value === "string" &&
  /^[1-9]\d{0,19}$/.test(value) &&
  BigInt(value) <= 18446744073709551615n;
// Internal execution accounting only. This module cannot authorize, sign or send a trade.
export function copySellLedger(url: string, dispatch?: DispatchTicket) {
  const ledger = copyLedger(url);
  const client = () =>
    neon(url, { fetchOptions: { signal: AbortSignal.timeout(10000) } });
  async function inventory(
    wallet: string,
    mint: string,
    rpc: Rpc,
    priorSlot = 0,
  ) {
    const sql = client();
    const rows =
      await sql`SELECT COALESCE(max((data->'receipt'->>'slot')::bigint),0)::text AS slot
      FROM fomo_copy_attempts WHERE wallet=${wallet} AND mint=${mint} AND state='confirmed'`;
    return readCopyInventory(
      wallet,
      mint,
      rpc,
      Math.max(priorSlot, Number(rows[0].slot)),
    );
  }
  return {
    async reserveSell(
      wallet: string,
      planId: string,
      signal: CopySellSignal,
      rpc: Rpc,
    ): Promise<CopyAttempt | null> {
      const now = Date.now();
      if (
        !isMint(wallet) ||
        !operationId(planId) ||
        !signatureValid(signal.signature) ||
        !isMint(signal.mint) ||
        [USDC, WSOL].includes(signal.mint) ||
        !positiveRaw(signal.inputRaw) ||
        !positiveRaw(signal.minOutputRaw) ||
        !Number.isInteger(signal.inputDecimals) ||
        signal.inputDecimals < 0 ||
        signal.inputDecimals > 18 ||
        !Number.isSafeInteger(signal.planVersion) ||
        signal.planVersion < 1 ||
        !Number.isSafeInteger(signal.blockTime) ||
        signal.blockTime * 1000 > now + 5000 ||
        now - signal.blockTime * 1000 > 60000 ||
        !Number.isInteger(signal.slippageBps) ||
        signal.slippageBps < 10 ||
        signal.slippageBps > 500 ||
        !Number.isSafeInteger(signal.expiresAt) ||
        signal.expiresAt <= now ||
        signal.expiresAt > now + 30000
      )
        throw new Error("The copy sell signal or quote is invalid or stale.");
      const sql = client();
      const old =
        await sql`SELECT * FROM fomo_copy_attempts WHERE wallet=${wallet} AND plan_id=${planId} AND leader_signature=${signal.signature}`;
      if (old.length) return rowAttempt(old[0]);
      const evidence =
        await sql`SELECT x.raw_amount::text,e.decision FROM fomo_copy_authorized_plans p
        JOIN fomo_copy_positions x ON x.plan_id=p.id AND x.mint=${signal.mint}
        JOIN fomo_copy_feed f ON f.plan_id=p.id
        JOIN fomo_copy_feed_events e ON e.plan_id=p.id AND e.signature=${signal.signature}
        WHERE p.wallet=${wallet} AND p.id=${planId} AND to_timestamp(${signal.expiresAt}/1000.0)<=p.permission_expires_at AND fomo_copy_dispatch_allowed(${wallet},p.id,${signal.signature},${dispatch?.id || null},${dispatch?.leaseId || null}) AND p.version=${signal.planVersion} AND p.enabled AND NOT p.archived
            AND NOT EXISTS(SELECT 1 FROM fomo_copy_controls control WHERE control.wallet=p.wallet)
          AND (p.data->>'copySells')::boolean AND p.enabled_at<=to_timestamp(${signal.blockTime})
          AND (p.data->>'slippageBps')::integer>=${signal.slippageBps}
          AND NOT e.failed AND e.block_time=${signal.blockTime} AND e.decision->>'kind'='swap' AND e.decision->>'side'='sell'
          AND e.decision->>'mint'=${signal.mint} AND (e.decision->>'tokenDecimals')::integer=${signal.inputDecimals}
          AND COALESCE(e.decision->>'tokenProgram',${TOKEN_PROGRAM})=${TOKEN_PROGRAM}
          AND f.status='ready' AND NOT EXISTS(SELECT 1 FROM fomo_copy_feed_events pending WHERE pending.plan_id=p.id AND pending.decision IS NULL)`;
      if (!evidence.length) return null;
      const before = String(evidence[0].raw_amount),
        decision = evidence[0].decision;
      const sized = proportionalSell(
        before,
        decision.leaderTokenBeforeRaw,
        decision.tokenRaw,
      );
      if (sized === "0") return null;
      if (sized !== signal.inputRaw)
        throw new Error(
          "The quote does not match this plan's proportional sell.",
        );
      const snapshot = await inventory(wallet, signal.mint, rpc);
      if (snapshot.decimals !== signal.inputDecimals)
        throw new Error("The copied token precision changed.");
      const id = randomUUID();
      await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${wallet},0))`,
        sql`WITH eligible AS (
          SELECT p.* FROM fomo_copy_authorized_plans p JOIN fomo_copy_positions x ON x.plan_id=p.id AND x.mint=${signal.mint}
          JOIN fomo_copy_feed f ON f.plan_id=p.id
          JOIN fomo_copy_feed_events e ON e.plan_id=p.id AND e.signature=${signal.signature}
          WHERE p.wallet=${wallet} AND p.id=${planId} AND to_timestamp(${signal.expiresAt}/1000.0)<=p.permission_expires_at AND fomo_copy_dispatch_allowed(${wallet},p.id,${signal.signature},${dispatch?.id || null},${dispatch?.leaseId || null}) AND p.version=${signal.planVersion} AND p.enabled AND NOT p.archived
            AND NOT EXISTS(SELECT 1 FROM fomo_copy_controls control WHERE control.wallet=p.wallet)
            AND (p.data->>'copySells')::boolean AND p.enabled_at<=to_timestamp(${signal.blockTime})
            AND (p.data->>'slippageBps')::integer>=${signal.slippageBps}
            AND x.raw_amount=${before}::numeric AND x.raw_amount>=${signal.inputRaw}::numeric
            AND NOT e.failed AND e.block_time=${signal.blockTime} AND e.decision=${JSON.stringify(decision)}::jsonb
            AND f.status='ready' AND NOT EXISTS(SELECT 1 FROM fomo_copy_feed_events pending WHERE pending.plan_id=p.id AND pending.decision IS NULL)
            AND to_timestamp(${signal.blockTime})>=statement_timestamp()-interval '60 seconds'
            AND to_timestamp(${signal.expiresAt}/1000.0)>statement_timestamp()
            AND to_timestamp(${snapshot.fetchedAt}/1000.0)>=statement_timestamp()-interval '10 seconds'
            AND (SELECT COALESCE(sum(pos.raw_amount),0) FROM fomo_copy_positions pos JOIN fomo_copy_plans owners ON owners.id=pos.plan_id WHERE owners.wallet=${wallet} AND pos.mint=${signal.mint})<=${snapshot.rawAmount}::numeric
            AND NOT EXISTS(SELECT 1 FROM fomo_copy_attempts settled WHERE settled.wallet=${wallet} AND settled.mint=${signal.mint} AND settled.state='confirmed' AND (settled.data->'receipt'->>'slot')::bigint>${snapshot.slot})
            AND NOT EXISTS(SELECT 1 FROM fomo_copy_attempts pending WHERE pending.wallet=${wallet} AND pending.state IN ('reserved','submitting','unknown'))
            AND NOT EXISTS(SELECT 1 FROM fomo_token22_reservations pending WHERE pending.wallet=${wallet} AND pending.state='reserved')
            AND NOT EXISTS(SELECT 1 FROM fomo_copy_attempts old WHERE old.plan_id=${planId} AND old.leader_signature=${signal.signature})
        ), budget AS (
          INSERT INTO fomo_copy_budgets(plan_id,day,reserved_cents,spent_cents)
          SELECT id,(statement_timestamp() AT TIME ZONE 'UTC')::date,0,0 FROM eligible
          ON CONFLICT(plan_id,day) DO UPDATE SET reserved_cents=fomo_copy_budgets.reserved_cents
          RETURNING plan_id
        ) INSERT INTO fomo_copy_attempts(id,plan_id,wallet,leader_signature,mint,budget_day,reserved_cents,plan_version,slippage_bps,side,state,expires_at,data)
          SELECT ${id},p.id,p.wallet,${signal.signature},${signal.mint},(statement_timestamp() AT TIME ZONE 'UTC')::date,0,p.version,${signal.slippageBps},'sell','reserved',to_timestamp(${signal.expiresAt}/1000.0),${JSON.stringify({ ...(dispatch ? { dispatchId: dispatch.id } : {}), inputRaw: signal.inputRaw, inputDecimals: signal.inputDecimals, outputDecimals: 6, minOutputRaw: signal.minOutputRaw, expiresAt: signal.expiresAt, positionBeforeRaw: before, leaderSoldRaw: decision.tokenRaw, leaderBeforeRaw: decision.leaderTokenBeforeRaw, inventorySlot: snapshot.slot })}::jsonb || jsonb_build_object('permissionId',p.permission_id::text)
          FROM eligible p JOIN budget b ON b.plan_id=p.id`,
      ]);
      const rows =
        await sql`SELECT * FROM fomo_copy_attempts WHERE wallet=${wallet} AND plan_id=${planId} AND leader_signature=${signal.signature}`;
      return rows[0] ? rowAttempt(rows[0]) : null;
    },
    async claimSell(
      wallet: string,
      id: string,
      signature: string,
      messageHash: string,
      rpc: Rpc,
    ) {
      if (
        !operationId(id) ||
        !signatureValid(signature) ||
        !/^[0-9a-f]{64}$/.test(messageHash)
      )
        throw new Error("Invalid signed sell identity.");
      const attempt = await ledger.get(wallet, id);
      if (!attempt || attempt.side !== "sell" || attempt.state !== "reserved")
        return null;
      const snapshot = await inventory(
        wallet,
        attempt.mint,
        rpc,
        attempt.inventorySlot || 0,
      );
      if (snapshot.decimals !== attempt.inputDecimals)
        throw new Error("The copied token precision changed.");
      const sql = client();
      const [, , rows] = await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${wallet},0))`,
        sql`SELECT pg_advisory_xact_lock_shared(hashtextextended('copy-dispatch-claim',0))`,
        sql`UPDATE fomo_copy_attempts a SET state='submitting',signature=${signature},data=a.data || ${JSON.stringify({ messageHash, inventorySlot: snapshot.slot })}::jsonb,updated_at=statement_timestamp()
          FROM fomo_copy_authorized_plans p,fomo_copy_positions x
          WHERE a.wallet=${wallet} AND a.id=${id} AND a.side='sell' AND a.state='reserved' AND NOT (a.data ? 'prepared') AND a.expires_at>statement_timestamp()
            AND p.id=a.plan_id AND p.enabled AND NOT p.archived
            AND NOT EXISTS(SELECT 1 FROM fomo_copy_controls control WHERE control.wallet=p.wallet) AND p.version=a.plan_version AND a.data->>'permissionId'=p.permission_id::text AND a.expires_at<=p.permission_expires_at
            AND fomo_copy_dispatch_allowed(a.wallet,a.plan_id,a.leader_signature,a.data->>'dispatchId',${dispatch?.leaseId || null})
            AND a.slippage_bps<=(p.data->>'slippageBps')::integer
            AND ((a.side='buy' AND a.reserved_cents=(p.data->>'buyCents')::bigint) OR (a.side='sell' AND a.reserved_cents=0 AND (p.data->>'copySells')::boolean)) AND (p.data->>'copySells')::boolean
            AND (a.data->>'inventorySlot')::bigint<=${snapshot.slot}
            AND x.plan_id=p.id AND x.mint=a.mint AND x.raw_amount=(a.data->>'positionBeforeRaw')::numeric AND x.raw_amount>=(a.data->>'inputRaw')::numeric
            AND to_timestamp(${snapshot.fetchedAt}/1000.0)>=statement_timestamp()-interval '10 seconds'
            AND (SELECT COALESCE(sum(pos.raw_amount),0) FROM fomo_copy_positions pos JOIN fomo_copy_plans owners ON owners.id=pos.plan_id WHERE owners.wallet=${wallet} AND pos.mint=a.mint)<=${snapshot.rawAmount}::numeric
            AND NOT EXISTS(SELECT 1 FROM fomo_copy_attempts settled WHERE settled.wallet=${wallet} AND settled.mint=a.mint AND settled.state='confirmed' AND (settled.data->'receipt'->>'slot')::bigint>${snapshot.slot})
          RETURNING a.*`,
      ]);
      return rows[0] ? rowAttempt(rows[0]) : null;
    },
    async confirmSell(wallet: string, id: string, rpc: Rpc) {
      const attempt = await ledger.get(wallet, id);
      if (!attempt || !["submitting", "unknown"].includes(attempt.state))
        return attempt;
      if (attempt.side !== "sell")
        throw new Error("Use buy settlement for a buy attempt.");
      const receipt = await readCopyReceipt(attempt, rpc);
      if (!receipt) return attempt;
      const sql = client();
      await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${wallet},0))`,
        sql`WITH eligible AS (
          SELECT * FROM fomo_copy_attempts WHERE wallet=${wallet} AND id=${id} AND side='sell' AND state IN ('submitting','unknown')
            AND signature=${receipt.signature} AND data->>'messageHash'=${receipt.messageHash}
        ), reduced AS (
          UPDATE fomo_copy_positions x SET raw_amount=x.raw_amount-${receipt.inputRaw}::numeric,revision=x.revision+1
          FROM eligible a WHERE x.plan_id=a.plan_id AND x.mint=a.mint AND x.raw_amount>=${receipt.inputRaw}::numeric
          RETURNING x.plan_id
        ), completed AS (
          UPDATE fomo_copy_attempts a SET state='confirmed',data=a.data || ${JSON.stringify({ receipt })}::jsonb,updated_at=statement_timestamp()
          FROM reduced r WHERE a.wallet=${wallet} AND a.id=${id} AND a.plan_id=r.plan_id RETURNING a.plan_id
        ) INSERT INTO fomo_copy_proceeds(plan_id,usdc_raw) SELECT plan_id,${receipt.outputRaw}::numeric FROM completed
          ON CONFLICT(plan_id) DO UPDATE SET usdc_raw=fomo_copy_proceeds.usdc_raw+EXCLUDED.usdc_raw,updated_at=statement_timestamp()`,
      ]);
      return ledger.get(wallet, id);
    },
    async proceeds(wallet: string, planId: string) {
      const sql = client();
      const rows =
        await sql`SELECT r.usdc_raw::text FROM fomo_copy_proceeds r JOIN fomo_copy_plans p ON p.id=r.plan_id WHERE r.plan_id=${planId} AND p.wallet=${wallet}`;
      return rows[0]?.usdc_raw || "0";
    },
  };
}
