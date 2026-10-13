import { randomUUID } from "node:crypto";
import { copyMonitorStore } from "./copy-monitor-store.js";
import type { MonitorClaim } from "./copy-monitor-store.js";
import { neon } from "@neondatabase/serverless";
import type {
  CopyFeedReport,
  FeedDecision,
  LeaderSignature,
} from "../src/copy-feed.js";
export class FeedCapacity extends Error {}
export const MAX_FEED_EVENTS = 10000;
export type FeedLease = {
  planId: string;
  wallet: string;
  leader: string;
  version: number;
  leaseId: string;
  initialized: boolean;
  startSlot: number | null;
  cursor: string | null;
  staged: LeaderSignature[];
};
export function copyFeedStore(url: string, scanIntervalSeconds = 15) {
  if (
    !Number.isInteger(scanIntervalSeconds) ||
    scanIntervalSeconds < 3 ||
    scanIntervalSeconds > 15
  )
    throw new Error("Invalid feed interval.");
  const client = () =>
    neon(url, { fetchOptions: { signal: AbortSignal.timeout(5000) } });
  return {
    async acquire(
      wallet: string,
      planId: string,
      monitor?: MonitorClaim,
    ): Promise<FeedLease | null> {
      const sql = client(),
        leaseId = randomUUID();
      const [, rows] = await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${wallet},0))`,
        sql`INSERT INTO fomo_copy_feed(plan_id,lease_id,lease_until,next_scan_at,monitor_revision)
        SELECT id,${leaseId},LEAST(clock_timestamp()+interval '45 seconds',
          CASE WHEN ${!!monitor} THEN (SELECT expires_at FROM fomo_copy_monitors WHERE plan_id=${planId}) ELSE clock_timestamp()+interval '45 seconds' END),
          clock_timestamp()+${scanIntervalSeconds}*interval '1 second',${monitor?.revision ?? null}
        FROM fomo_copy_plans WHERE id=${planId} AND wallet=${wallet} AND NOT archived
          AND (NOT ${!!monitor} OR EXISTS(SELECT 1 FROM fomo_copy_monitors m WHERE m.plan_id=${planId} AND m.revision=${monitor?.revision ?? 0}
            AND m.lease_id=${monitor?.leaseId ?? null} AND m.lease_until>clock_timestamp() AND m.enabled AND m.expires_at>clock_timestamp()))
        ON CONFLICT(plan_id) DO UPDATE SET lease_id=EXCLUDED.lease_id,lease_until=EXCLUDED.lease_until,next_scan_at=EXCLUDED.next_scan_at,monitor_revision=EXCLUDED.monitor_revision
          WHERE (fomo_copy_feed.lease_until IS NULL OR fomo_copy_feed.lease_until<clock_timestamp()) AND fomo_copy_feed.next_scan_at<=clock_timestamp()
        RETURNING *`,
      ]);
      if (!rows[0]) return null;
      const plans =
        await sql`SELECT leader,version FROM fomo_copy_plans WHERE id=${planId} AND wallet=${wallet} AND NOT archived`;
      if (!plans[0]) return null;
      return {
        planId,
        wallet,
        leader: plans[0].leader,
        version: plans[0].version,
        leaseId,
        initialized: rows[0].initialized,
        startSlot:
          rows[0].start_slot === null ? null : Number(rows[0].start_slot),
        cursor: rows[0].cursor_signature,
        staged: rows[0].staged,
      };
    },
    async checkpoint(
      lease: FeedLease,
      rows: LeaderSignature[],
      cursor: string | null,
      startSlot: number,
    ) {
      const sql = client();
      const result = await sql`WITH updated AS (
        UPDATE fomo_copy_feed f SET initialized=true,start_slot=COALESCE(f.start_slot,${startSlot}),cursor_signature=${cursor},staged='[]'::jsonb
        FROM fomo_copy_plans p WHERE f.plan_id=${lease.planId} AND f.lease_id=${lease.leaseId} AND f.lease_until>clock_timestamp()
          AND p.id=f.plan_id AND p.wallet=${lease.wallet} AND p.version=${lease.version} AND NOT p.archived
          AND (SELECT count(*) FROM fomo_copy_feed_events WHERE plan_id=${lease.planId})+${rows.length}<=${MAX_FEED_EVENTS} RETURNING f.plan_id
      ), inserted AS (
        INSERT INTO fomo_copy_feed_events(plan_id,signature,slot,block_time,failed)
        SELECT u.plan_id,e.value->>'signature',(e.value->>'slot')::bigint,(e.value->>'blockTime')::bigint,(e.value->>'failed')::boolean FROM updated u,
          jsonb_array_elements(${JSON.stringify(rows)}::jsonb) WITH ORDINALITY AS e(value,ordinality) ORDER BY e.ordinality
        ON CONFLICT(plan_id,signature) DO NOTHING RETURNING signature
      ) SELECT plan_id FROM updated`;
      if (!result.length) {
        const count =
          await sql`SELECT count(*)::integer AS n FROM fomo_copy_feed_events WHERE plan_id=${lease.planId}`;
        if (count[0].n + rows.length > MAX_FEED_EVENTS)
          throw new FeedCapacity("Saved activity reached its record limit.");
        throw new Error("Activity lease changed. Refresh before retrying.");
      }
    },
    async stage(lease: FeedLease, rows: LeaderSignature[]) {
      if (rows.length > 1000)
        throw new Error("Activity backlog exceeds the supported bound.");
      const sql = client();
      const result =
        await sql`UPDATE fomo_copy_feed f SET staged=${JSON.stringify(rows)}::jsonb
        FROM fomo_copy_plans p WHERE f.plan_id=${lease.planId} AND f.lease_id=${lease.leaseId} AND f.lease_until>clock_timestamp()
          AND p.id=f.plan_id AND p.wallet=${lease.wallet} AND p.version=${lease.version} AND NOT p.archived RETURNING f.plan_id`;
      if (!result.length)
        throw new Error("Activity lease changed. Refresh before retrying.");
    },
    async pending(lease: FeedLease) {
      const sql = client();
      const rows =
        await sql`SELECT e.signature,e.slot,e.block_time,e.failed FROM fomo_copy_feed_events e
        JOIN fomo_copy_feed f ON f.plan_id=e.plan_id JOIN fomo_copy_plans p ON p.id=e.plan_id
        WHERE e.plan_id=${lease.planId} AND p.wallet=${lease.wallet} AND p.version=${lease.version} AND NOT p.archived
          AND f.lease_id=${lease.leaseId} AND f.lease_until>clock_timestamp() AND e.decision IS NULL ORDER BY e.sequence LIMIT 3`;
      return rows.map((row) => ({
        signature: row.signature,
        slot: Number(row.slot),
        blockTime: row.block_time === null ? null : Number(row.block_time),
        failed: row.failed,
      })) as LeaderSignature[];
    },
    async record(
      lease: FeedLease,
      event: LeaderSignature,
      decision: FeedDecision,
    ) {
      const sql = client();
      const rows = await sql`WITH locked AS (
          SELECT f.plan_id FROM fomo_copy_feed f WHERE f.plan_id=${lease.planId} AND f.lease_id=${lease.leaseId} AND f.lease_until>clock_timestamp() FOR UPDATE
        ) UPDATE fomo_copy_feed_events e SET decision=${JSON.stringify(decision)}::jsonb
        FROM locked,fomo_copy_feed f,fomo_copy_plans p WHERE locked.plan_id=e.plan_id AND e.plan_id=${lease.planId} AND e.signature=${event.signature} AND e.decision IS NULL
          AND f.plan_id=e.plan_id AND f.lease_id=${lease.leaseId} AND f.lease_until>clock_timestamp()
          AND p.id=e.plan_id AND p.wallet=${lease.wallet} AND p.version=${lease.version} AND NOT p.archived RETURNING e.signature`;
      if (!rows.length)
        throw new Error("Activity lease changed. Refresh before retrying.");
    },
    async finish(
      lease: FeedLease,
      status: CopyFeedReport["status"],
      message: string,
    ) {
      const sql = client();
      await sql`UPDATE fomo_copy_feed f SET lease_until=NULL,lease_id=NULL,monitor_revision=NULL,checked_at=clock_timestamp(),status=${status},message=${message}
        FROM fomo_copy_plans p WHERE f.plan_id=${lease.planId} AND f.lease_id=${lease.leaseId} AND f.lease_until>clock_timestamp()
          AND p.id=f.plan_id AND p.wallet=${lease.wallet} AND p.version=${lease.version} AND NOT p.archived`;
    },
    async report(
      wallet: string,
      planId: string,
    ): Promise<CopyFeedReport | null> {
      const sql = client();
      const [plans, events, pending] = await sql.transaction([
        sql`SELECT p.leader,f.initialized,f.checked_at,f.status,f.message FROM fomo_copy_plans p LEFT JOIN fomo_copy_feed f ON f.plan_id=p.id WHERE p.id=${planId} AND p.wallet=${wallet}`,
        sql`SELECT e.* FROM fomo_copy_feed_events e JOIN fomo_copy_plans p ON p.id=e.plan_id WHERE e.plan_id=${planId} AND p.wallet=${wallet} AND e.decision IS NOT NULL ORDER BY e.sequence DESC LIMIT 20`,
        sql`SELECT count(*)::integer AS count FROM fomo_copy_feed_events e JOIN fomo_copy_plans p ON p.id=e.plan_id WHERE e.plan_id=${planId} AND p.wallet=${wallet} AND e.decision IS NULL`,
      ]);
      if (!plans[0]) return null;
      const p = plans[0];
      return {
        planId,
        monitor:
          (await copyMonitorStore(url).report(wallet, planId)) || undefined,
        leader: p.leader,
        initialized: !!p.initialized,
        checkedAt: p.checked_at || null,
        status: p.status || "idle",
        message:
          (p.message || "No activity check yet.") +
          (pending[0]?.count
            ? ` ${pending[0].count} transactions waiting for evidence.`
            : ""),
        events: events.map((e) => ({
          signature: e.signature,
          slot: Number(e.slot),
          blockTime: e.block_time === null ? null : Number(e.block_time),
          failed: e.failed,
          decision: e.decision,
          recordedAt: e.recorded_at,
        })),
      };
    },
  };
}
export type CopyFeedStore = ReturnType<typeof copyFeedStore>;
