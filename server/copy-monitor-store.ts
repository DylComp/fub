import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { CopyConflict } from "./copy-store.js";
import { CopyValidation } from "../src/copy-account.js";
import { operationId } from "../src/funding-model.js";
import type { CopyMonitor } from "../src/copy-monitor.js";
// Global admission, bounded by the hosted 25-wallet observation workload.
export const MONITOR_LIMIT = 25;
export function monitorAvailable() {
  return (
    process.env.COPY_MONITOR_ENABLED === "true" &&
    !!process.env.DATABASE_URL &&
    (process.env.CRON_SECRET?.length || 0) >= 32 &&
    process.env.VERCEL_ENV !== "preview"
  );
}
export type MonitorClaim = {
  planId: string;
  wallet: string;
  revision: number;
  leaseId: string;
};
export type MonitorSchedule = {
  intervalSeconds: number;
  serviceLeaseId: string;
  wakePlanIds?: string[];
};
export function copyMonitorStore(url: string, schedule?: MonitorSchedule) {
  if (
    schedule &&
    (!Number.isInteger(schedule.intervalSeconds) ||
      schedule.intervalSeconds < 3 ||
      schedule.intervalSeconds > 15 ||
      !operationId(schedule.serviceLeaseId) ||
      (schedule.wakePlanIds !== undefined && (schedule.wakePlanIds.length > 25 || schedule.wakePlanIds.some(id=>!operationId(id)))))
  )
    throw new Error("Invalid continuous monitoring schedule.");
  const interval = schedule?.intervalSeconds ?? 60;
  const client = () =>
    neon(url, { fetchOptions: { signal: AbortSignal.timeout(5000) } });
  async function claimMany(limit: number): Promise<MonitorClaim[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5)
      throw new Error("Invalid monitor batch size.");
    const sql = client(),
      leaseId = randomUUID();
    const rows = await sql`WITH due AS (
      SELECT m.plan_id FROM fomo_copy_monitors m JOIN fomo_copy_plans p ON p.id=m.plan_id LEFT JOIN fomo_copy_feed f ON f.plan_id=p.id
      WHERE m.enabled AND m.expires_at>clock_timestamp() AND NOT p.archived
        AND (m.next_run_at<=clock_timestamp() OR (m.plan_id=ANY(${schedule?.wakePlanIds ?? []}::uuid[])
          AND m.outcome='ready' AND m.last_run_at<clock_timestamp()-${interval}*interval '1 second'))
        AND (m.lease_until IS NULL OR m.lease_until<clock_timestamp())
        AND (f.lease_until IS NULL OR f.lease_until<clock_timestamp()) AND (f.next_scan_at IS NULL OR f.next_scan_at<=clock_timestamp())
        AND COALESCE(f.status,'idle')<>'gap'
        AND (NOT ${schedule?.wakePlanIds !== undefined} OR m.plan_id=ANY(${schedule?.wakePlanIds ?? []}::uuid[])
          OR NOT COALESCE(f.initialized,false) OR m.last_success_at IS NULL
          OR m.last_success_at<clock_timestamp()-interval '30 seconds'
          OR COALESCE(f.status,'idle') IN('retry','catching_up')
          OR EXISTS(SELECT 1 FROM fomo_copy_feed_events e WHERE e.plan_id=m.plan_id AND e.decision IS NULL))
        AND CASE WHEN ${!!schedule} THEN EXISTS(SELECT 1 FROM fomo_copy_service s WHERE s.name='observer' AND s.lease_id=${schedule?.serviceLeaseId ?? null} AND s.lease_until>clock_timestamp())
          ELSE NOT EXISTS(SELECT 1 FROM fomo_copy_service s WHERE s.name='observer' AND s.lease_until>clock_timestamp()) END
      ORDER BY m.next_run_at,m.plan_id FOR UPDATE OF m SKIP LOCKED LIMIT ${limit}
    ) UPDATE fomo_copy_monitors m SET lease_id=${leaseId},lease_until=clock_timestamp()+interval '60 seconds',next_run_at=clock_timestamp()+${interval}*interval '1 second'
      FROM due,fomo_copy_plans p WHERE m.plan_id=due.plan_id AND p.id=m.plan_id RETURNING m.plan_id,m.revision,p.wallet`;
    return rows.map((row) => ({
      planId: row.plan_id, wallet: row.wallet, revision: row.revision, leaseId,
    }));
  }
  return {
    async activePlans(): Promise<{planId:string;leader:string}[]> {
      const sql=client();
      const rows=await sql`SELECT m.plan_id,p.leader FROM fomo_copy_monitors m JOIN fomo_copy_plans p ON p.id=m.plan_id
        WHERE m.enabled AND m.expires_at>clock_timestamp() AND NOT p.archived ORDER BY m.plan_id LIMIT 26`;
      if(rows.length>25)throw Error('Observer stream capacity exceeded.');
      return rows.map(row=>({planId:row.plan_id,leader:row.leader}));
    },
    async report(wallet: string, planId: string): Promise<CopyMonitor | null> {
      const sql = client();
      const rows =
        await sql`SELECT m.*,p.archived,w.last_started_at AS worker_started,
        COALESCE(m.enabled AND m.expires_at>clock_timestamp() AND NOT p.archived,false) AS active
        FROM fomo_copy_plans p LEFT JOIN fomo_copy_monitors m ON m.plan_id=p.id
        LEFT JOIN fomo_copy_monitor_worker w ON w.name='leader-activity'
        WHERE p.id=${planId} AND p.wallet=${wallet}`;
      if (!rows[0]) return null;
      const m = rows[0];
      return {
        available: monitorAvailable(),
        revision: m.revision || 0,
        enabled: m.active,
        expiresAt: m.expires_at || null,
        nextRunAt: m.active ? m.next_run_at : null,
        lastRunAt: m.last_run_at || null,
        lastSuccessAt: m.last_success_at || null,
        outcome: m.outcome || "idle",
        workerLastStartedAt: m.worker_started || null,
      };
    },
    async set(
      wallet: string,
      planId: string,
      planVersion: number,
      revision: number,
      enabled: boolean,
    ) {
      if (
        !operationId(planId) ||
        !Number.isSafeInteger(planVersion) ||
        planVersion < 1 ||
        !Number.isSafeInteger(revision) ||
        revision < 0 ||
        revision > 2147483645 ||
        typeof enabled !== "boolean"
      )
        throw new CopyValidation("Invalid monitoring settings.");
      if (enabled && !monitorAvailable())
        throw new CopyValidation(
          "Background checks are unavailable. Manual activity checks still work.",
        );
      const sql = client();
      const result = await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended('copy-monitor-capacity',0))`,
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${wallet},0))`,
        sql`WITH changed AS (
          INSERT INTO fomo_copy_monitors(plan_id,enabled,expires_at)
          SELECT p.id,${enabled},CASE WHEN ${enabled} THEN clock_timestamp()+interval '7 days' ELSE NULL END
          FROM fomo_copy_plans p LEFT JOIN fomo_copy_feed f ON f.plan_id=p.id
          WHERE p.id=${planId} AND p.wallet=${wallet} AND p.version=${planVersion} AND NOT p.archived
            AND (${revision}=0 OR EXISTS(SELECT 1 FROM fomo_copy_monitors m WHERE m.plan_id=p.id AND m.revision=${revision}))
            AND (NOT ${enabled} OR (COALESCE(f.status,'idle')<>'gap' AND
              (SELECT count(*) FROM fomo_copy_monitors m JOIN fomo_copy_plans owner ON owner.id=m.plan_id WHERE m.enabled AND m.expires_at>clock_timestamp() AND NOT owner.archived AND m.plan_id<>p.id)<${MONITOR_LIMIT}))
          ON CONFLICT(plan_id) DO UPDATE SET revision=fomo_copy_monitors.revision+1,enabled=EXCLUDED.enabled,expires_at=EXCLUDED.expires_at,
            lease_id=NULL,lease_until=NULL,failures=0,next_run_at=clock_timestamp(),outcome='idle'
          WHERE fomo_copy_monitors.revision=${revision} RETURNING plan_id
        ), invalidated AS (
          UPDATE fomo_copy_feed SET lease_id=NULL,lease_until=NULL,monitor_revision=NULL
          WHERE plan_id IN(SELECT plan_id FROM changed) AND monitor_revision IS NOT NULL
        ) SELECT plan_id FROM changed`,
      ]);
      if (!result[2].length)
        throw new CopyConflict(
          "Monitoring changed, the plan needs attention, or background capacity is full. Refresh activity before trying again.",
        );
    },
    async beginWorker() {
      const sql = client(),
        leaseId = randomUUID();
      const rows =
        await sql`INSERT INTO fomo_copy_monitor_worker(name,lease_id,lease_until,last_started_at) VALUES('leader-activity',${leaseId},clock_timestamp()+interval '90 seconds',clock_timestamp())
        ON CONFLICT(name) DO UPDATE SET lease_id=EXCLUDED.lease_id,lease_until=EXCLUDED.lease_until,last_started_at=EXCLUDED.last_started_at
        WHERE fomo_copy_monitor_worker.lease_until IS NULL OR fomo_copy_monitor_worker.lease_until<clock_timestamp() RETURNING name`;
      return rows.length ? leaseId : null;
    },
    async endWorker(leaseId: string, outcome: string) {
      const sql = client();
      await sql`UPDATE fomo_copy_monitor_worker SET lease_id=NULL,lease_until=NULL,last_finished_at=clock_timestamp(),outcome=${outcome}
        WHERE name='leader-activity' AND lease_id=${leaseId} AND lease_until>clock_timestamp()`;
    },
    claimMany,
    async claim(): Promise<MonitorClaim | null> {
      return (await claimMany(1))[0] ?? null;
    },
    async complete(claim: MonitorClaim, outcome: CopyMonitor["outcome"]) {
      const sql = client();
      await sql`UPDATE fomo_copy_monitors SET lease_id=NULL,lease_until=NULL,last_run_at=clock_timestamp(),outcome=${outcome},
        last_success_at=CASE WHEN ${outcome} IN('ready','catching_up') THEN clock_timestamp() ELSE last_success_at END,
        failures=CASE WHEN ${outcome}='retry' THEN LEAST(failures+1,5) ELSE 0 END,
        next_run_at=CASE WHEN ${!!schedule} THEN clock_timestamp()+
          CASE WHEN ${outcome}='retry' THEN LEAST(${interval}*power(2,LEAST(failures+1,5)),120)
            WHEN ${schedule?.wakePlanIds !== undefined} AND ${outcome}='ready' THEN 30 ELSE ${interval} END*interval '1 second'
          ELSE date_trunc('minute',clock_timestamp())+CASE WHEN ${outcome}='retry' THEN LEAST(power(2,LEAST(failures+1,5)),30)*interval '1 minute' ELSE interval '1 minute' END END
        WHERE plan_id=${claim.planId} AND revision=${claim.revision} AND lease_id=${claim.leaseId} AND lease_until>clock_timestamp() AND enabled`;
    },
  };
}
