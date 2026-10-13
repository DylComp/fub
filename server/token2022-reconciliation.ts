import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { isMint } from "../src/assets.js";
import { operationId } from "../src/funding-model.js";
import { CopyValidation } from "../src/copy-account.js";
import { parseAllocations, validateAllocation } from "../src/copy-inventory.js";
import type {
  InventoryReview,
  InventoryEvent,
  InventoryReport,
  CopyPosition,
} from "../src/copy-inventory.js";
import type { Rpc } from "./funding.js";
import { CopyConflict } from "./copy-store.js";
import { readNativeInventory } from "./native-inventory.js";

const conflict = () =>
  new CopyConflict(
    "Positions or balances changed. Check the balance again before correcting it.",
  );
function reviewRow(row: Record<string, any>): InventoryReview {
  return {
    wallet: row.wallet,
    id: row.id,
    mint: row.mint,
    positions: row.positions,
    balanceRaw: String(row.balance_raw),
    decimals: row.decimals,
    slot: Number(row.slot),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}
function eventRow(row: Record<string, any>): InventoryEvent {
  return {
    wallet: row.wallet,
    id: row.id,
    mint: row.mint,
    positions: row.positions,
    balanceRaw: String(row.balance_raw),
    decimals: row.decimals,
    slot: Number(row.slot),
    allocations: row.allocations,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
export function token22Reconciliation(
  url: string,
  readRpc: () => Rpc,
  beforeRead: () => Promise<void> = async () => {},
) {
  const client = () =>
    neon(url, { fetchOptions: { signal: AbortSignal.timeout(10000) } });
  function owner(wallet: string) {
    if (!isMint(wallet)) throw new CopyValidation("Invalid wallet.");
  }
  return {
    async report(wallet: string): Promise<InventoryReport> {
      owner(wallet);
      const sql = client();
      const [tokens, events] = await sql.transaction(
        [
          sql`SELECT x.mint,sum(x.raw_amount)::text AS raw,count(*)::integer AS plans
          FROM fomo_token22_positions x JOIN fomo_copy_plans p ON p.id=x.plan_id
          WHERE p.wallet=${wallet} GROUP BY x.mint HAVING sum(x.raw_amount)>0 ORDER BY x.mint LIMIT 51`,
          sql`SELECT *,balance_raw::text FROM fomo_token22_inventory_events WHERE wallet=${wallet} ORDER BY created_at DESC,id DESC LIMIT 20`,
        ],
        { isolationLevel: "RepeatableRead", readOnly: true },
      );
      return {
        wallet,
        tokens: tokens.slice(0, 50) as InventoryReport["tokens"],
        hasMore: tokens.length > 50,
        events: events.map(eventRow),
      };
    },
    async review(wallet: string, mint: string): Promise<InventoryReview> {
      owner(wallet);
      if (!isMint(mint))
        throw new CopyValidation("Use an exact token contract.");
      const sql = client();
      const rows = await sql`SELECT s.positions,
        (EXISTS(SELECT 1 FROM fomo_copy_attempts WHERE wallet=${wallet} AND state IN('reserved','submitting','unknown')) OR EXISTS(SELECT 1 FROM fomo_token22_reservations WHERE wallet=${wallet} AND state='reserved')) AS pending,
        COALESCE((SELECT max(x.last_slot) FROM fomo_token22_positions x JOIN fomo_copy_plans p ON p.id=x.plan_id WHERE p.wallet=${wallet} AND x.mint=${mint}),0)::text AS slot
        FROM fomo_token22_inventory_state s WHERE s.wallet=${wallet} AND s.mint=${mint}`;
      if (!rows.length)
        throw new CopyValidation("No copied position for this token.");
      const positions = rows[0].positions as CopyPosition[];
      if (rows[0].pending || positions.some((p) => p.enabled))
        throw new CopyConflict(
          "Pause the token's copy plans and resolve pending copy trades before correcting positions.",
        );
      await beforeRead();
      const snapshot = await readNativeInventory(
        wallet,
        mint,
        readRpc(),
        Number(rows[0].slot),
      );
      // Capture the review only if no settlement, plan edit or claim won the lock.
      const fresh = client();
      const [, saved] = await fresh.transaction([
        fresh`SELECT pg_advisory_xact_lock(hashtextextended(${wallet},0))`,
        fresh`INSERT INTO fomo_token22_inventory_reviews(wallet,mint,id,positions,balance_raw,decimals,slot,expires_at)
          SELECT ${wallet},${mint},${randomUUID()},s.positions,${snapshot.rawAmount}::numeric,${snapshot.decimals},${snapshot.slot},statement_timestamp()+interval '2 minutes'
          FROM fomo_token22_inventory_state s WHERE s.wallet=${wallet} AND s.mint=${mint} AND s.positions=${JSON.stringify(positions)}::jsonb
            AND NOT EXISTS(SELECT 1 FROM fomo_copy_attempts WHERE wallet=${wallet} AND state IN('reserved','submitting','unknown'))
            AND NOT EXISTS(SELECT 1 FROM fomo_token22_reservations WHERE wallet=${wallet} AND state='reserved')
            AND NOT EXISTS(SELECT 1 FROM fomo_token22_positions x JOIN fomo_copy_plans p ON p.id=x.plan_id WHERE p.wallet=${wallet} AND x.mint=${snapshot.mint} AND x.decimals<>${snapshot.decimals})
            AND to_timestamp(${snapshot.fetchedAt}/1000.0) BETWEEN statement_timestamp()-interval '10 seconds' AND statement_timestamp()+interval '1 second'
          ON CONFLICT(wallet,mint) DO UPDATE SET id=EXCLUDED.id,positions=EXCLUDED.positions,balance_raw=EXCLUDED.balance_raw,decimals=EXCLUDED.decimals,slot=EXCLUDED.slot,expires_at=EXCLUDED.expires_at
          RETURNING *,balance_raw::text`,
      ]);
      if (!saved.length) throw conflict();
      return reviewRow(saved[0]);
    },
    async apply(
      wallet: string,
      id: string,
      value: unknown,
    ): Promise<InventoryEvent> {
      owner(wallet);
      if (!operationId(id)) throw new CopyValidation("Invalid balance review.");
      const allocations = parseAllocations(value),
        serialized = JSON.stringify(allocations);
      const sql = client();
      const existing =
        await sql`SELECT *,balance_raw::text FROM fomo_token22_inventory_events WHERE wallet=${wallet} AND id=${id}`;
      const result = (row: Record<string, any>) => {
        if (JSON.stringify(parseAllocations(row.allocations)) !== serialized)
          throw conflict();
        return eventRow(row);
      };
      // A lost response can be retried even after the review expires or RPC fails.
      if (existing.length) return result(existing[0]);
      const reviews =
        await sql`SELECT *,balance_raw::text FROM fomo_token22_inventory_reviews WHERE wallet=${wallet} AND id=${id} AND expires_at>statement_timestamp()`;
      if (!reviews.length) throw conflict();
      const review = reviewRow(reviews[0]);
      validateAllocation(review.positions, allocations, review.balanceRaw);
      await beforeRead();
      const snapshot = await readNativeInventory(
        wallet,
        review.mint,
        readRpc(),
        review.slot,
      );
      if (
        snapshot.rawAmount !== review.balanceRaw ||
        snapshot.decimals !== review.decimals
      )
        throw conflict();
      const fresh = client();
      const [, saved] = await fresh.transaction([
        fresh`SELECT pg_advisory_xact_lock(hashtextextended(${wallet},0))`,
        fresh`WITH existing AS (
          SELECT * FROM fomo_token22_inventory_events WHERE wallet=${wallet} AND id=${id}
        ), eligible AS (
          SELECT r.* FROM fomo_token22_inventory_reviews r JOIN fomo_token22_inventory_state s ON s.wallet=r.wallet AND s.mint=r.mint
          WHERE r.wallet=${wallet} AND r.id=${id} AND r.expires_at>statement_timestamp()
            AND r.positions=${JSON.stringify(review.positions)}::jsonb AND s.positions=r.positions
            AND r.balance_raw=${snapshot.rawAmount}::numeric AND r.decimals=${snapshot.decimals} AND r.slot<=${snapshot.slot}
            AND NOT EXISTS(SELECT 1 FROM existing)
            AND NOT EXISTS(SELECT 1 FROM fomo_copy_plans p JOIN fomo_token22_positions x ON x.plan_id=p.id WHERE p.wallet=${wallet} AND x.mint=r.mint AND p.enabled)
            AND NOT EXISTS(SELECT 1 FROM fomo_copy_attempts WHERE wallet=${wallet} AND state IN('reserved','submitting','unknown'))
            AND NOT EXISTS(SELECT 1 FROM fomo_token22_reservations WHERE wallet=${wallet} AND state='reserved')
            AND NOT EXISTS(SELECT 1 FROM fomo_token22_positions x JOIN fomo_copy_plans p ON p.id=x.plan_id WHERE p.wallet=${wallet} AND x.mint=${snapshot.mint} AND x.decimals<>${snapshot.decimals})
            AND COALESCE((SELECT max(x.last_slot) FROM fomo_token22_positions x JOIN fomo_copy_plans p ON p.id=x.plan_id WHERE p.wallet=${wallet} AND x.mint=r.mint),0)<=${snapshot.slot}
            AND to_timestamp(${snapshot.fetchedAt}/1000.0) BETWEEN statement_timestamp()-interval '10 seconds' AND statement_timestamp()+interval '1 second'
        ), changed AS (
          UPDATE fomo_token22_positions x SET raw_amount=a.raw::numeric,revision=x.revision+1,last_slot=GREATEST(x.last_slot,${snapshot.slot})
          FROM eligible e,jsonb_to_recordset(${serialized}::jsonb) AS a(id uuid,raw text)
          WHERE x.plan_id=a.id AND x.mint=e.mint AND x.raw_amount>=a.raw::numeric
          RETURNING x.plan_id
        ), recorded AS (
          INSERT INTO fomo_token22_inventory_events(wallet,id,mint,positions,allocations,balance_raw,decimals,slot)
          SELECT wallet,id,mint,positions,${serialized}::jsonb,balance_raw,decimals,${snapshot.slot} FROM eligible
          WHERE (SELECT count(*) FROM changed)=jsonb_array_length(positions) RETURNING *
        ) SELECT *,balance_raw::text AS balance_raw FROM recorded UNION ALL SELECT *,balance_raw::text AS balance_raw FROM existing`,
      ]);
      if (!saved.length) throw conflict();
      return result(saved[0]);
    },
  };
}
