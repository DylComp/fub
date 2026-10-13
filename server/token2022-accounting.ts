import {readNativeInventory} from './native-inventory.js';
import { neon } from "@neondatabase/serverless";
import { token22Journal } from "./token2022-journal.js";
import {
  assertToken22PermissionReview,
  token22ReviewCost,
  verifyToken22Permission,
  type Token22Permission,
} from "./token2022-permission.js";
import { proportionalSell } from "../src/copy-account.js";
import { tokenUnits } from "../src/token-fees.js";
import { isMint } from "../src/assets.js";
import { operationId } from "../src/funding-model.js";
import { record } from "../src/live-orders.js";
import { signatureValid } from "./copy-classifier.js";
import { TOKEN_2022 } from "./jupiter-routes.js";

import type { Rpc } from "./funding.js";

// Internal only: no public acceptance, reservation, activation or submission API.
export function token22Accounting(url: string) {
  const client = () =>
      neon(url, { fetchOptions: { signal: AbortSignal.timeout(10000) } }),
    journal = token22Journal(url);
  function identity(wallet: string, id: string) {
    if (!isMint(wallet) || !operationId(id))
      throw Error("Invalid accounting identity.");
  }
  async function get(wallet: string, id: string) {
    identity(wallet, id);
    const sql = client(),
      rows =
        await sql`SELECT * FROM fomo_token22_reservations WHERE execution_id=${id} AND wallet=${wallet}`;
    return rows[0] ?? null;
  }
  async function apply(wallet: string, id: string) {
    const reservation = await get(wallet, id);
    if (!reservation || reservation.state !== "reserved") return false;
    const saved = await journal.get(wallet, id);
    if (!saved || saved.reviewHash !== reservation.review_hash)
      throw Error("Accounting review changed.");
    const r = saved.review,
      a = r.accounts,
      sql = client();
    if (
      a.mint !== reservation.mint ||
      a.direction !== reservation.side ||
      a.decimals !== reservation.decimals ||
      a.inputRaw !== String(reservation.input_raw) ||
      token22ReviewCost(r).maximum !== BigInt(reservation.reserved_lamports)
    )
      throw Error("Accounting reservation changed.");
    if(saved.signedExpiry && saved.execution){
      const [,rows]=await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${wallet},0))`,
        sql`WITH released AS (
          UPDATE fomo_token22_reservations r SET state='released',issue=NULL,updated_at=clock_timestamp()
          FROM fomo_token22_executions e WHERE r.execution_id=${id} AND r.wallet=${wallet} AND r.state='reserved'
          AND e.id=r.execution_id AND e.wallet=r.wallet AND e.state='signed' AND e.review_hash=r.review_hash
          AND e.review_hash=${saved.reviewHash} AND e.signed_expiry=${JSON.stringify(saved.signedExpiry)}::jsonb
          AND e.signature=${saved.execution.signature} AND e.signed_transaction=${saved.execution.signed}
          RETURNING r.*
        ) UPDATE fomo_token22_budgets b SET reserved_lamports=b.reserved_lamports-r.reserved_lamports
          FROM released r WHERE b.plan_id=r.plan_id AND b.day=r.budget_day RETURNING r.execution_id`,
      ]);
      return rows.length===1;
    }
    if (
      saved.state === "canceled" ||
      (saved.state === "prepared" && r.expiresAt <= Date.now())
    ) {
      const [, rows] = await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${wallet},0))`,
        sql`WITH canceled AS (
          UPDATE fomo_token22_executions SET state='canceled',updated_at=clock_timestamp()
          WHERE id=${id} AND wallet=${wallet} AND review_hash=${saved.reviewHash} AND signing_claim IS NULL AND signature IS NULL
            AND (state='canceled' OR (state='prepared' AND expires_at<=clock_timestamp())) RETURNING id
        ), released AS (
          UPDATE fomo_token22_reservations r SET state='released',issue=NULL,updated_at=clock_timestamp()
          FROM canceled c WHERE r.execution_id=c.id AND r.wallet=${wallet} AND r.state='reserved'
            AND r.review_hash=${saved.reviewHash} RETURNING r.*
        ) UPDATE fomo_token22_budgets b SET reserved_lamports=b.reserved_lamports-r.reserved_lamports
          FROM released r WHERE b.plan_id=r.plan_id AND b.day=r.budget_day RETURNING r.execution_id`,
      ]);
      return rows.length === 1;
    }
    if (!["confirmed", "failed"].includes(saved.state) || !saved.execution)
      return false;
    const outcome = await journal.outcome(wallet, id);
    if (!outcome) return false;
    const success = saved.state === "confirmed",
      cost = token22ReviewCost(r);
    if (
      outcome.kind !== (success ? "succeeded" : "failed") ||
      outcome.signature !== saved.execution.signature ||
      outcome.messageHash !== r.messageHash ||
      !Number.isSafeInteger(outcome.slot) ||
      outcome.slot < r.minContextSlot ||
      outcome.feeLamports !== String(r.feeLamports) ||
      (success &&
        (outcome.inputRaw !== a.inputRaw ||
          tokenUnits(outcome.outputRaw) < tokenUnits(a.minimum) ||
          tokenUnits(outcome.rentLamports) !== cost.rent))
    )
      throw Error("Accounting receipt does not match the reserved trade.");
    const spent = success ? cost.maximum : BigInt(r.feeLamports),
      credit =
        success && a.direction === "buy" ? tokenUnits(outcome.outputRaw) : 0n,
      debit = success && a.direction === "sell" ? tokenUnits(a.inputRaw) : 0n,
      proceeds =
        success && a.direction === "sell" ? tokenUnits(outcome.outputRaw) : 0n;
    const [, rows] = await sql.transaction([
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${wallet},0))`,
      sql`WITH eligible AS (
        SELECT r.* FROM fomo_token22_reservations r JOIN fomo_token22_executions e ON e.id=r.execution_id
        JOIN fomo_token22_outcomes o ON o.execution_id=e.id
        LEFT JOIN fomo_token22_positions p ON p.plan_id=r.plan_id AND p.mint=r.mint
        WHERE r.execution_id=${id} AND r.wallet=${wallet} AND r.state='reserved' AND r.review_hash=${saved.reviewHash}
          AND e.state=${saved.state} AND e.review=${JSON.stringify(r)}::jsonb AND e.signature=${saved.execution.signature}
          AND o.outcome=${JSON.stringify(outcome)}::jsonb AND (p.decimals IS NULL OR p.decimals=r.decimals)
          AND (${debit.toString()}::numeric=0 OR (p.raw_amount>=${debit.toString()}::numeric AND p.last_slot<=${outcome.slot}))
      ), changed AS (
        UPDATE fomo_token22_reservations r SET state='applied',issue=NULL,updated_at=clock_timestamp()
        FROM eligible e WHERE r.execution_id=e.execution_id RETURNING r.*
      ), charged AS (
        UPDATE fomo_token22_budgets b SET reserved_lamports=b.reserved_lamports-r.reserved_lamports,spent_lamports=b.spent_lamports+${spent.toString()}::bigint
        FROM changed r WHERE b.plan_id=r.plan_id AND b.day=r.budget_day RETURNING r.*
      ), bought AS (
        INSERT INTO fomo_token22_positions(plan_id,mint,decimals,raw_amount,last_slot)
        SELECT plan_id,mint,decimals,${credit.toString()}::numeric,${outcome.slot} FROM charged WHERE ${credit.toString()}::numeric>0
        ON CONFLICT(plan_id,mint) DO UPDATE SET raw_amount=fomo_token22_positions.raw_amount+EXCLUDED.raw_amount,
          last_slot=GREATEST(fomo_token22_positions.last_slot,EXCLUDED.last_slot),revision=fomo_token22_positions.revision+1 RETURNING plan_id
      ), sold AS (
        UPDATE fomo_token22_positions p SET raw_amount=p.raw_amount-${debit.toString()}::numeric,
          proceeds_lamports=p.proceeds_lamports+${proceeds.toString()}::numeric,last_slot=${outcome.slot},revision=p.revision+1
        FROM charged r WHERE p.plan_id=r.plan_id AND p.mint=r.mint AND ${debit.toString()}::numeric>0 RETURNING p.plan_id
      ) SELECT execution_id FROM charged`,
    ]);
    if (!rows.length && (await get(wallet, id))?.state === "reserved")
      throw Error("Position evidence does not permit settlement.");
    return rows.length === 1;
  }
  return {
    get,
    apply,
    async accept(scope: Token22Permission, signature: string) {
      const digest = verifyToken22Permission(scope, signature),
        now = Date.now();
      if (scope.issuedAt > now || scope.acceptBy <= now)
        throw Error("Permission acceptance expired.");
      const sql = client();
      const rows =
        await sql`INSERT INTO fomo_token22_permissions(id,plan_id,wallet,scope,signature,scope_hash,expires_at)
        SELECT ${scope.id},p.id,p.wallet,${JSON.stringify(scope)}::jsonb,${signature},${digest},to_timestamp(${scope.expiresAt}/1000.0)
        FROM fomo_copy_plans p WHERE p.id=${scope.planId} AND p.wallet=${scope.wallet} AND p.leader=${scope.leader}
          AND p.version=${scope.planVersion} AND NOT p.archived AND (p.data->>'slippageBps')::integer>=${scope.slippageBps}
          AND (NOT ${scope.copySells} OR (p.data->>'copySells')::boolean)
          AND to_timestamp(${scope.acceptBy}/1000.0)>statement_timestamp()
          AND NOT EXISTS(SELECT 1 FROM fomo_copy_controls c WHERE c.wallet=p.wallet)
        ON CONFLICT DO NOTHING RETURNING id`;
      return rows.length === 1;
    },
    async revoke(wallet: string, permissionId: string) {
      identity(wallet, permissionId);
      const sql = client();
      const [, rows] = await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${wallet},0))`,
        sql`UPDATE fomo_token22_permissions SET revoked_at=clock_timestamp() WHERE id=${permissionId} AND wallet=${wallet} AND revoked_at IS NULL RETURNING id`,
      ]);
      return rows.length === 1;
    },
    async reserve(
      wallet: string,
      planId: string,
      id: string,
      leaderSignature: string,
      rpc: Rpc,
    ) {
      identity(wallet, id);
      identity(wallet, planId);
      if (!signatureValid(leaderSignature))
        throw Error("Invalid leader signature.");
      const saved = await journal.get(wallet, id),
        sql = client();
      if (!saved || saved.state !== "prepared") return null;
      const prior = await get(wallet, id);
      if (prior)
        return prior.plan_id === planId &&
          prior.leader_signature === leaderSignature
          ? prior
          : null;
      const grants =
        await sql`SELECT g.* FROM fomo_token22_permissions g WHERE g.plan_id=${planId} AND g.wallet=${wallet} AND g.revoked_at IS NULL`;
      if (!grants[0]) return null;
      const g = grants[0],
        scope = g.scope as Token22Permission,
        r = saved.review,
        a = r.accounts;
      if (verifyToken22Permission(scope, g.signature) !== g.scope_hash)
        throw Error("Permission proof changed.");
      assertToken22PermissionReview(scope, r);
      let inventory = "0",
        inventorySlot = r.minContextSlot,
        checkedAt = Date.now(),
        before = "0",
        decision: unknown = null;
      if (a.direction === "sell") {
        const rows =
          await sql`SELECT p.raw_amount::text,e.decision FROM fomo_token22_positions p
          JOIN fomo_copy_feed_events e ON e.plan_id=p.plan_id AND e.signature=${leaderSignature}
          WHERE p.plan_id=${planId} AND p.mint=${a.mint} AND p.decimals=${a.decimals}`;
        if (!rows[0]) return null;
        before = rows[0].raw_amount;
        decision = rows[0].decision;
        const d = record(decision);
        if (
          proportionalSell(
            before,
            String(d.leaderTokenBeforeRaw),
            String(d.tokenRaw),
          ) !== a.inputRaw
        )
          throw Error("Sell size is not proportional to this plan's position.");
        const holdings=await readNativeInventory(wallet,a.mint,rpc,r.minContextSlot,a.tokenProgram??TOKEN_2022);
        if(!holdings.exists||holdings.source!==a.source||holdings.decimals!==a.decimals)throw Error("Inventory unavailable.");
        inventory=holdings.rawAmount;inventorySlot=holdings.slot;
        checkedAt = Date.now();
      }
      const cap = token22ReviewCost(r).maximum.toString();
      await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${wallet},0))`,
        sql`WITH eligible AS (
          SELECT p.id FROM fomo_copy_plans p JOIN fomo_token22_permissions g ON g.plan_id=p.id AND g.wallet=p.wallet
          JOIN fomo_token22_executions x ON x.id=${id} AND x.wallet=p.wallet
          JOIN fomo_copy_feed f ON f.plan_id=p.id JOIN fomo_copy_feed_events e ON e.plan_id=p.id AND e.signature=${leaderSignature}
          WHERE p.id=${planId} AND p.wallet=${wallet} AND p.enabled AND NOT p.archived AND p.version=${scope.planVersion} AND p.leader=${scope.leader}
            AND g.id=${scope.id} AND g.scope_hash=${g.scope_hash} AND g.scope=${JSON.stringify(scope)}::jsonb AND g.signature=${g.signature} AND g.revoked_at IS NULL
            AND g.expires_at>=x.expires_at AND x.expires_at>statement_timestamp() AND x.state='prepared' AND x.review_hash=${saved.reviewHash}
            AND x.review=${JSON.stringify(r)}::jsonb AND fomo_token22_job_allowed(x.id) AND (p.data->>'slippageBps')::integer>=${scope.slippageBps}
            AND NOT EXISTS(SELECT 1 FROM fomo_copy_controls c WHERE c.wallet=p.wallet)
            AND f.status='ready' AND NOT e.failed AND e.decision->>'kind'='swap' AND e.decision->>'side'=${a.direction}
            AND e.decision->>'mint'=${a.mint} AND e.decision->>'tokenProgram'=${a.tokenProgram??TOKEN_2022} AND (e.decision->>'tokenDecimals')::integer=${a.decimals}
            AND p.enabled_at<=to_timestamp(e.block_time) AND to_timestamp(e.block_time)>=statement_timestamp()-interval '60 seconds'
            AND to_timestamp(e.block_time)<=statement_timestamp()+interval '5 seconds' AND e.slot<=${r.minContextSlot}
            AND NOT EXISTS(SELECT 1 FROM fomo_copy_feed_events q WHERE q.plan_id=p.id AND q.decision IS NULL)
            AND NOT EXISTS(SELECT 1 FROM fomo_copy_attempts q WHERE q.wallet=p.wallet AND q.state IN('reserved','submitting','unknown'))
            AND NOT EXISTS(SELECT 1 FROM fomo_token22_reservations q WHERE q.wallet=p.wallet AND q.state='reserved')
            AND NOT EXISTS(SELECT 1 FROM fomo_token22_reservations q WHERE q.plan_id=p.id AND q.leader_signature=${leaderSignature})
            AND (${a.direction}='buy' OR (${scope.copySells} AND (p.data->>'copySells')::boolean
              AND e.decision=${JSON.stringify(decision)}::jsonb
              AND EXISTS(SELECT 1 FROM fomo_token22_positions pos WHERE pos.plan_id=p.id AND pos.mint=${a.mint} AND pos.decimals=${a.decimals}
                AND pos.raw_amount=${before}::numeric AND pos.raw_amount>=${a.inputRaw}::numeric AND pos.last_slot<=${inventorySlot})
              AND (SELECT COALESCE(sum(pos.raw_amount),0) FROM fomo_token22_positions pos JOIN fomo_copy_plans owner ON owner.id=pos.plan_id
                WHERE owner.wallet=${wallet} AND pos.mint=${a.mint})<=${inventory}::numeric
              AND to_timestamp(${checkedAt}/1000.0)>=statement_timestamp()-interval '10 seconds'))
        ), budget AS (
          INSERT INTO fomo_token22_budgets(plan_id,day,reserved_lamports)
          SELECT id,(statement_timestamp() AT TIME ZONE 'UTC')::date,${cap}::bigint FROM eligible WHERE ${cap}::bigint<=${scope.dailySpendLamports}::bigint
          ON CONFLICT(plan_id,day) DO UPDATE SET reserved_lamports=fomo_token22_budgets.reserved_lamports+EXCLUDED.reserved_lamports
          WHERE fomo_token22_budgets.reserved_lamports+fomo_token22_budgets.spent_lamports+EXCLUDED.reserved_lamports<=${scope.dailySpendLamports}::bigint RETURNING plan_id,day
        ) INSERT INTO fomo_token22_reservations(execution_id,wallet,plan_id,permission_id,leader_signature,review_hash,budget_day,mint,side,decimals,input_raw,reserved_lamports)
          SELECT ${id},${wallet},plan_id,${scope.id},${leaderSignature},${saved.reviewHash},day,${a.mint},${a.direction},${a.decimals},${a.inputRaw}::numeric,${cap}::bigint FROM budget`,
      ]);
      return get(wallet, id);
    },
    async reconcile(): Promise<"applied" | "deferred" | null> {
      const sql = client(),
        rows =
          await sql`SELECT r.execution_id,r.wallet FROM fomo_token22_reservations r JOIN fomo_token22_executions e ON e.id=r.execution_id
        WHERE r.state='reserved' AND r.next_check_at<=clock_timestamp() AND (e.signed_expiry IS NOT NULL OR e.state IN('confirmed','failed','canceled') OR (e.state='prepared' AND e.expires_at<=clock_timestamp()))
        ORDER BY r.next_check_at,r.execution_id LIMIT 1`;
      if (!rows[0]) return null;
      const row = rows[0];
      try {
        const applied = await apply(row.wallet, row.execution_id);
        if (
          applied ||
          (await get(row.wallet, row.execution_id))?.state !== "reserved"
        )
          return "applied";
      } catch {
        // Preserve the reservation and retry without monopolizing recovery.
      }
      const deferred =
        await sql`UPDATE fomo_token22_reservations SET issue='inconsistent',next_check_at=clock_timestamp()+interval '5 minutes'
          WHERE execution_id=${row.execution_id} AND wallet=${row.wallet} AND state='reserved' RETURNING execution_id`;
      return deferred.length ? "deferred" : "applied";
    },
  };
}
