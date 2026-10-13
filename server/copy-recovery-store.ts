import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";

export function recoveryAvailable() {
  return (
    process.env.COPY_RECOVERY_ENABLED === "true" &&
    !!process.env.DATABASE_URL &&
    (process.env.CRON_SECRET?.length || 0) >= 32 &&
    process.env.VERCEL_ENV !== "preview"
  );
}
export type RecoveryClaim = {
  wallet: string;
  attemptId: string;
  leaseId: string;
};
export type RecoveryOutcome =
  "busy" | "unknown" | "retry" | "confirmed" | "failed";

export function copyRecoveryStore(url: string) {
  const client = () =>
    neon(url, { fetchOptions: { signal: AbortSignal.timeout(5000) } });
  return {
    async beginWorker() {
      const sql = client(),
        leaseId = randomUUID();
      const rows =
        await sql`INSERT INTO fomo_copy_recovery_worker(name,lease_id,lease_until,last_started_at)
        VALUES('copy-recovery',${leaseId},clock_timestamp()+interval '90 seconds',clock_timestamp())
        ON CONFLICT(name) DO UPDATE SET lease_id=EXCLUDED.lease_id,lease_until=EXCLUDED.lease_until,last_started_at=EXCLUDED.last_started_at
        WHERE fomo_copy_recovery_worker.lease_until IS NULL OR fomo_copy_recovery_worker.lease_until<clock_timestamp() RETURNING name`;
      return rows.length ? leaseId : null;
    },
    async endWorker(leaseId: string, outcome: string) {
      const sql = client();
      await sql`UPDATE fomo_copy_recovery_worker SET lease_id=NULL,lease_until=NULL,last_finished_at=clock_timestamp(),outcome=${outcome}
        WHERE name='copy-recovery' AND lease_id=${leaseId} AND lease_until>clock_timestamp()`;
    },
    async expired() {
      const sql = client();
      const rows =
        await sql`SELECT id,wallet FROM fomo_copy_attempts WHERE state='reserved' AND expires_at<=clock_timestamp()
        AND signature IS NULL AND NOT(data ? 'execution') ORDER BY expires_at,id LIMIT 5`;
      return rows.map((row) => ({
        id: row.id as string,
        wallet: row.wallet as string,
      }));
    },
    async expire(wallet: string, id: string) {
      const sql = client();
      const [, rows] = await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${wallet},0))`,
        sql`WITH released AS (
          UPDATE fomo_copy_attempts SET state='released',data=data || '{"releaseReason":"expired"}'::jsonb,updated_at=statement_timestamp()
          WHERE wallet=${wallet} AND id=${id} AND state='reserved' AND expires_at<=statement_timestamp()
            AND signature IS NULL AND NOT(data ? 'execution') RETURNING plan_id,budget_day,reserved_cents
        ), restored AS (
          UPDATE fomo_copy_budgets b SET reserved_cents=b.reserved_cents-r.reserved_cents
          FROM released r WHERE b.plan_id=r.plan_id AND b.day=r.budget_day RETURNING b.plan_id
        ) SELECT * FROM restored`,
      ]);
      return rows.length > 0;
    },
    async claim(): Promise<RecoveryClaim | null> {
      const sql = client(),
        leaseId = randomUUID();
      // Discovery is repeatable after a crash between the submission claim and
      // job registration. Only the stored execution format can use this verifier.
      await sql`INSERT INTO fomo_copy_recovery_jobs(attempt_id)
        SELECT a.id FROM fomo_copy_attempts a WHERE a.state IN('submitting','unknown')
          AND a.signature IS NOT NULL AND a.data->'execution'->>'version'='1' AND a.data ? 'prepared'
          AND NOT EXISTS(SELECT 1 FROM fomo_copy_recovery_jobs j WHERE j.attempt_id=a.id)
        ORDER BY a.created_at,a.id LIMIT 100 ON CONFLICT(attempt_id) DO NOTHING`;
      const rows = await sql`WITH due AS (
        SELECT j.attempt_id FROM fomo_copy_recovery_jobs j JOIN fomo_copy_attempts a ON a.id=j.attempt_id
        WHERE a.state IN('submitting','unknown') AND j.next_run_at<=clock_timestamp()
          AND (j.lease_until IS NULL OR j.lease_until<clock_timestamp())
        ORDER BY j.next_run_at,j.attempt_id FOR UPDATE OF j SKIP LOCKED LIMIT 1
      ) UPDATE fomo_copy_recovery_jobs j SET lease_id=${leaseId},lease_until=clock_timestamp()+interval '60 seconds'
        FROM due,fomo_copy_attempts a WHERE j.attempt_id=due.attempt_id AND a.id=j.attempt_id RETURNING j.attempt_id,a.wallet`;
      return rows[0]
        ? { wallet: rows[0].wallet, attemptId: rows[0].attempt_id, leaseId }
        : null;
    },
    async complete(claim: RecoveryClaim, outcome: RecoveryOutcome) {
      const sql = client();
      await sql`UPDATE fomo_copy_recovery_jobs j SET lease_id=NULL,lease_until=NULL,
        outcome=CASE WHEN a.state IN('confirmed','failed') THEN a.state ELSE ${outcome} END,
        checked_count=CASE WHEN ${outcome}='busy' THEN checked_count ELSE LEAST(checked_count::bigint+1,2147483647)::integer END,
        last_checked_at=CASE WHEN ${outcome}='busy' THEN last_checked_at ELSE clock_timestamp() END,
        failures=CASE WHEN a.state IN('confirmed','failed') THEN 0 WHEN ${outcome}='busy' THEN failures ELSE LEAST(failures+1,5) END,
        next_run_at=clock_timestamp()+CASE WHEN ${outcome}='busy' THEN interval '20 seconds'
          ELSE LEAST(power(2,failures),30)*interval '1 minute' END
        FROM fomo_copy_attempts a WHERE j.attempt_id=${claim.attemptId} AND a.id=j.attempt_id AND a.wallet=${claim.wallet}
          AND j.lease_id=${claim.leaseId} AND j.lease_until>clock_timestamp()`;
    },
  };
}
