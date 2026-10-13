import { neon } from "@neondatabase/serverless";
import { parseCopySave, CopyValidation } from "../src/copy-account.js";
import type { AccountCopyPlan } from "../src/copy-account.js";
import { operationId } from "../src/funding-model.js";

export class CopyConflict extends Error {}
function planRow(row: Record<string, any>): AccountCopyPlan {
  return {
    ...row.data,
    id: row.id,
    wallet: row.wallet,
    version: row.version,
    archived: row.archived,
    enabled: row.enabled,
  };
}
export function copyStore(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("Copy plan storage is not configured.");
  const client = () =>
    neon(url, { fetchOptions: { signal: AbortSignal.timeout(10000) } });
  return {
    async list(wallet: string) {
      const sql = client();
      const rows =
        await sql`SELECT * FROM fomo_copy_plans WHERE wallet=${wallet} ORDER BY updated_at DESC LIMIT 25`;
      return rows.map(planRow);
    },
    async save(wallet: string, value: unknown) {
      const { id, version, plan } = parseCopySave(value, wallet),
        sql = client();
      const [, rows] = await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${wallet},0))`,
        sql`WITH saved AS (INSERT INTO fomo_copy_plans(id,wallet,leader,version,data)
          SELECT ${id},${wallet},${plan.address},1,${JSON.stringify(plan)}::jsonb
          WHERE (EXISTS(SELECT 1 FROM fomo_copy_plans WHERE id=${id} AND wallet=${wallet}) OR
            (${version}=0 AND (SELECT count(*) FROM fomo_copy_plans WHERE wallet=${wallet})<25))
            AND NOT EXISTS(SELECT 1 FROM fomo_copy_plans WHERE wallet=${wallet} AND leader=${plan.address} AND id<>${id} AND NOT archived)
          ON CONFLICT(id) DO UPDATE SET version=fomo_copy_plans.version+1,enabled=false,enabled_at=NULL,archived=false,
            data=EXCLUDED.data || jsonb_build_object('createdAt',fomo_copy_plans.data->>'createdAt'),updated_at=now()
          WHERE fomo_copy_plans.wallet=EXCLUDED.wallet AND fomo_copy_plans.leader=EXCLUDED.leader AND fomo_copy_plans.version=${version}
          RETURNING *), revoked AS (
            UPDATE fomo_copy_permissions SET revoked_at=statement_timestamp(),revoke_reason='edited'
            WHERE wallet=${wallet} AND revoked_at IS NULL AND plan_id IN(SELECT id FROM saved)
          ), native_revoked AS (
            UPDATE fomo_token22_permissions SET revoked_at=statement_timestamp()
            WHERE wallet=${wallet} AND revoked_at IS NULL AND plan_id IN(SELECT id FROM saved)
          ), native_canceled AS (
            UPDATE fomo_token22_executions e SET state='canceled',updated_at=statement_timestamp()
            WHERE e.wallet=${wallet} AND e.state='prepared' AND e.signing_claim IS NULL AND e.signature IS NULL
              AND EXISTS(SELECT 1 FROM fomo_token22_reservations r WHERE r.execution_id=e.id AND r.state='reserved' AND r.plan_id IN(SELECT id FROM saved))
            RETURNING e.id
          ), native_released AS (
            UPDATE fomo_token22_reservations r SET state='released',issue=NULL,updated_at=statement_timestamp()
            WHERE r.wallet=${wallet} AND r.state='reserved' AND r.execution_id IN(SELECT id FROM native_canceled)
            RETURNING r.execution_id,r.plan_id,r.budget_day,r.reserved_lamports
          ), native_restored AS (
            UPDATE fomo_token22_budgets b SET reserved_lamports=b.reserved_lamports-r.lamports
            FROM (SELECT plan_id,budget_day,sum(reserved_lamports) AS lamports FROM native_released GROUP BY plan_id,budget_day) r
            WHERE b.plan_id=r.plan_id AND b.day=r.budget_day RETURNING b.plan_id
          ), paused AS (
            UPDATE fomo_copy_monitors SET enabled=false,revision=revision+1,lease_id=NULL,lease_until=NULL
            WHERE plan_id IN(SELECT id FROM saved)
          ), invalidated AS (
            UPDATE fomo_copy_feed SET lease_id=NULL,lease_until=NULL,monitor_revision=NULL WHERE plan_id IN(SELECT id FROM saved)
          ), released AS (
            UPDATE fomo_copy_attempts SET state='released',updated_at=statement_timestamp(),
              data=data || jsonb_build_object('releaseReason','edited'::text)
            WHERE wallet=${wallet} AND plan_id IN(SELECT id FROM saved) AND state='reserved'
              AND signature IS NULL AND NOT(data ? 'execution') RETURNING plan_id,budget_day,reserved_cents
          ), restored AS (
            UPDATE fomo_copy_budgets b SET reserved_cents=b.reserved_cents-r.cents
            FROM (SELECT plan_id,budget_day,sum(reserved_cents) AS cents FROM released GROUP BY plan_id,budget_day) r
            WHERE b.plan_id=r.plan_id AND b.day=r.budget_day RETURNING b.plan_id
          ) SELECT saved.* FROM saved`,
      ]);
      if (!rows.length)
        throw new CopyConflict(
          "The backup changed, its wallet is already saved, or the 25-wallet limit was reached. Refresh backups before trying again.",
        );
      return planRow(rows[0]);
    },
    async archive(wallet: string, id: string, version: number) {
      if (!operationId(id) || !Number.isSafeInteger(version) || version < 1)
        throw new CopyValidation("Invalid copy plan version.");
      const sql = client();
      const [, rows] = await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${wallet},0))`,
        sql`WITH saved AS (UPDATE fomo_copy_plans SET archived=true,enabled=false,enabled_at=NULL,version=version+1,updated_at=now()
          WHERE wallet=${wallet} AND id=${id} AND version=${version} RETURNING *), revoked AS (
            UPDATE fomo_copy_permissions SET revoked_at=statement_timestamp(),revoke_reason='archived'
            WHERE wallet=${wallet} AND revoked_at IS NULL AND plan_id IN(SELECT id FROM saved)
          ), native_revoked AS (
            UPDATE fomo_token22_permissions SET revoked_at=statement_timestamp()
            WHERE wallet=${wallet} AND revoked_at IS NULL AND plan_id IN(SELECT id FROM saved)
          ), native_canceled AS (
            UPDATE fomo_token22_executions e SET state='canceled',updated_at=statement_timestamp()
            WHERE e.wallet=${wallet} AND e.state='prepared' AND e.signing_claim IS NULL AND e.signature IS NULL
              AND EXISTS(SELECT 1 FROM fomo_token22_reservations r WHERE r.execution_id=e.id AND r.state='reserved' AND r.plan_id IN(SELECT id FROM saved))
            RETURNING e.id
          ), native_released AS (
            UPDATE fomo_token22_reservations r SET state='released',issue=NULL,updated_at=statement_timestamp()
            WHERE r.wallet=${wallet} AND r.state='reserved' AND r.execution_id IN(SELECT id FROM native_canceled)
            RETURNING r.execution_id,r.plan_id,r.budget_day,r.reserved_lamports
          ), native_restored AS (
            UPDATE fomo_token22_budgets b SET reserved_lamports=b.reserved_lamports-r.lamports
            FROM (SELECT plan_id,budget_day,sum(reserved_lamports) AS lamports FROM native_released GROUP BY plan_id,budget_day) r
            WHERE b.plan_id=r.plan_id AND b.day=r.budget_day RETURNING b.plan_id
          ), paused AS (
            UPDATE fomo_copy_monitors SET enabled=false,revision=revision+1,lease_id=NULL,lease_until=NULL WHERE plan_id IN(SELECT id FROM saved)
          ), invalidated AS (
            UPDATE fomo_copy_feed SET lease_id=NULL,lease_until=NULL,monitor_revision=NULL WHERE plan_id IN(SELECT id FROM saved)
          ), released AS (
            UPDATE fomo_copy_attempts SET state='released',updated_at=statement_timestamp(),
              data=data || jsonb_build_object('releaseReason','archived'::text)
            WHERE wallet=${wallet} AND plan_id IN(SELECT id FROM saved) AND state='reserved'
              AND signature IS NULL AND NOT(data ? 'execution') RETURNING plan_id,budget_day,reserved_cents
          ), restored AS (
            UPDATE fomo_copy_budgets b SET reserved_cents=b.reserved_cents-r.cents
            FROM (SELECT plan_id,budget_day,sum(reserved_cents) AS cents FROM released GROUP BY plan_id,budget_day) r
            WHERE b.plan_id=r.plan_id AND b.day=r.budget_day RETURNING b.plan_id
          ) SELECT saved.* FROM saved`,
      ]);
      if (!rows.length)
        throw new CopyConflict(
          "This backup changed. Refresh it before archiving.",
        );
      return planRow(rows[0]);
    },
  };
}
