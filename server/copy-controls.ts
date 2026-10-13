import { neon } from "@neondatabase/serverless";
import { isMint } from "../src/assets.js";
import { operationId } from "../src/funding-model.js";
import { CopyValidation } from "../src/copy-account.js";
import type {
  CopyControlEvent,
  CopyControlReport,
} from "../src/copy-controls.js";
import { CopyConflict } from "./copy-store.js";

function eventRow(row: Record<string, any>): CopyControlEvent {
  return {
    wallet: row.wallet,
    id: row.id,
    kind: row.kind,
    planId: row.plan_id,
    planName: row.plan_name,
    planVersion: row.plan_version,
    affectedPlans: row.affected_plans,
    releasedCount: row.released_count,
    releasedCents: String(row.released_cents),
    pendingCount: row.pending_count,
    nativeReleasedCount: row.native_released_count,
    nativeReleasedLamports: String(row.native_released_lamports),
    nativePendingCount: row.native_pending_count,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
export function copyControls(url: string) {
  const client = () =>
    neon(url, { fetchOptions: { signal: AbortSignal.timeout(10000) } });
  return {
    async report(wallet: string): Promise<CopyControlReport> {
      if (!isMint(wallet)) throw new CopyValidation("Invalid wallet.");
      const sql = client();
      const [controls, plans, attempts, events, native] = await sql.transaction(
        [
          sql`SELECT stopped_at FROM fomo_copy_controls WHERE wallet=${wallet}`,
          sql`SELECT count(*)::integer AS active FROM fomo_copy_plans WHERE wallet=${wallet} AND enabled AND NOT archived`,
          sql`SELECT count(*) FILTER(WHERE state='reserved')::integer AS reserved,
          COALESCE(sum(reserved_cents) FILTER(WHERE state='reserved'),0)::text AS cents,
          count(*) FILTER(WHERE state IN('submitting','unknown'))::integer AS pending
          FROM fomo_copy_attempts WHERE wallet=${wallet} AND state IN('reserved','submitting','unknown')`,
          sql`SELECT * FROM fomo_copy_control_events WHERE wallet=${wallet} ORDER BY created_at DESC,id DESC LIMIT 20`,
          sql`SELECT count(*) FILTER(WHERE e.state='prepared')::int AS reserved,
            COALESCE(sum(r.reserved_lamports),0)::text AS lamports,
            count(*) FILTER(WHERE e.state<>'prepared')::int AS pending
            FROM fomo_token22_reservations r JOIN fomo_token22_executions e ON e.id=r.execution_id
            WHERE r.wallet=${wallet} AND r.state='reserved'`,
        ],
        { isolationLevel: "RepeatableRead", readOnly: true },
      );
      return {
        wallet,
        stoppedAt: controls[0]
          ? new Date(controls[0].stopped_at).toISOString()
          : null,
        activePlans: controls.length ? 0 : plans[0].active,
        reservedCount: attempts[0].reserved,
        reservedCents: attempts[0].cents,
        pendingCount: attempts[0].pending,
        events: events.map(eventRow),
        nativeReservedCount: native[0].reserved,
        nativeReservedLamports: native[0].lamports,
        nativePendingCount: native[0].pending,
      };
    },
    // Revocation uses the same wallet lock as reserve, prepare and claim. A claim
    // that wins first may already be broadcasting; it must settle, not be refunded.
    async stop(
      wallet: string,
      requestId: string,
      plan?: { id: string; version: number },
    ): Promise<CopyControlEvent> {
      if (
        !isMint(wallet) ||
        !operationId(requestId) ||
        (plan &&
          (!operationId(plan.id) ||
            !Number.isSafeInteger(plan.version) ||
            plan.version < 1 ||
            plan.version > 2147483647))
      )
        throw new CopyValidation("Invalid copy control request.");
      const sql = client(),
        planId = plan?.id || null,
        kind = plan ? "pause" : "stop";
      const [, rows] = await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${wallet},0))`,
        sql`WITH existing AS (
          SELECT * FROM fomo_copy_control_events WHERE wallet=${wallet} AND id=${requestId}
        ), stopped AS (
          INSERT INTO fomo_copy_controls(wallet) SELECT ${wallet}
          WHERE ${planId}::uuid IS NULL AND NOT EXISTS(SELECT 1 FROM existing)
          ON CONFLICT(wallet) DO UPDATE SET stopped_at=statement_timestamp() RETURNING wallet
        ), changed AS (
          UPDATE fomo_copy_plans SET enabled=false,enabled_at=NULL,version=LEAST(version::bigint+1,2147483647)::integer,updated_at=statement_timestamp()
          WHERE wallet=${wallet} AND NOT EXISTS(SELECT 1 FROM existing)
            AND ((${planId}::uuid IS NULL AND EXISTS(SELECT 1 FROM stopped)) OR
              (id=${planId}::uuid AND version=${plan?.version || 0} AND NOT archived))
          RETURNING id,data
        ), revoked AS (
          UPDATE fomo_copy_permissions SET revoked_at=statement_timestamp(),revoke_reason=${plan ? "paused" : "stopped"}
          WHERE wallet=${wallet} AND revoked_at IS NULL AND plan_id IN(SELECT id FROM changed)
        ), native_revoked AS (
          UPDATE fomo_token22_permissions SET revoked_at=statement_timestamp()
          WHERE wallet=${wallet} AND revoked_at IS NULL AND plan_id IN(SELECT id FROM changed)
        ), native_canceled AS (
          UPDATE fomo_token22_executions e SET state='canceled',updated_at=statement_timestamp()
          WHERE e.wallet=${wallet} AND e.state='prepared' AND e.signing_claim IS NULL AND e.signature IS NULL
            AND EXISTS(SELECT 1 FROM fomo_token22_reservations r WHERE r.execution_id=e.id AND r.state='reserved' AND r.plan_id IN(SELECT id FROM changed))
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
          WHERE plan_id IN(SELECT id FROM changed)
        ), invalidated AS (
          UPDATE fomo_copy_feed SET lease_id=NULL,lease_until=NULL,monitor_revision=NULL WHERE plan_id IN(SELECT id FROM changed)
        ), released AS (
          UPDATE fomo_copy_attempts SET state='released',updated_at=statement_timestamp(),
            data=data || jsonb_build_object('releaseReason',${plan ? "paused" : "stopped"}::text)
          WHERE wallet=${wallet} AND plan_id IN(SELECT id FROM changed) AND state='reserved'
            AND signature IS NULL AND NOT(data ? 'execution') RETURNING plan_id,budget_day,reserved_cents
        ), restored AS (
          UPDATE fomo_copy_budgets b SET reserved_cents=b.reserved_cents-r.cents
          FROM (SELECT plan_id,budget_day,sum(reserved_cents) AS cents FROM released GROUP BY plan_id,budget_day) r
          WHERE b.plan_id=r.plan_id AND b.day=r.budget_day RETURNING b.plan_id
        ), recorded AS (
          INSERT INTO fomo_copy_control_events(wallet,id,kind,plan_id,plan_name,affected_plans,released_count,released_cents,pending_count,plan_version,native_released_count,native_released_lamports,native_pending_count)
          SELECT ${wallet},${requestId},${kind},${planId}::uuid,
            CASE WHEN ${planId}::uuid IS NOT NULL THEN (SELECT data->>'name' FROM changed LIMIT 1) ELSE NULL END,
            (SELECT count(*) FROM changed),(SELECT count(*) FROM released),(SELECT COALESCE(sum(reserved_cents),0) FROM released),
            (SELECT count(*) FROM fomo_copy_attempts WHERE wallet=${wallet} AND state IN('submitting','unknown') AND (${planId}::uuid IS NULL OR plan_id=${planId}::uuid)),${plan?.version || null}::integer,
            (SELECT count(*) FROM native_released),(SELECT COALESCE(sum(reserved_lamports),0) FROM native_released),
            (SELECT count(*) FROM fomo_token22_reservations r WHERE r.wallet=${wallet} AND r.state='reserved'
              AND (${planId}::uuid IS NULL OR r.plan_id=${planId}::uuid) AND r.execution_id NOT IN(SELECT execution_id FROM native_released))
          WHERE NOT EXISTS(SELECT 1 FROM existing) AND (EXISTS(SELECT 1 FROM stopped) OR EXISTS(SELECT 1 FROM changed))
          RETURNING *
        ) SELECT * FROM recorded UNION ALL SELECT * FROM existing`,
      ]);
      if (
        !rows.length ||
        rows[0].kind !== kind ||
        rows[0].plan_id !== planId ||
        rows[0].plan_version !== (plan?.version || null)
      )
        throw new CopyConflict(
          "Copy settings changed. Refresh before trying again.",
        );
      return eventRow(rows[0]);
    },
  };
}
