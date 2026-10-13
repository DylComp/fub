import { neon } from "@neondatabase/serverless";
import { recoveryAvailable } from "./copy-recovery-store.js";
import type {
  CopyHistoryReport,
  CopyTradeRecord,
} from "../src/copy-history.js";
// One consistent read snapshot; no transactions, credentials or message hashes leave the server.
export async function copyHistory(
  url: string,
  wallet: string,
  planId: string,
): Promise<CopyHistoryReport | null> {
  const sql = neon(url, {
    fetchOptions: { signal: AbortSignal.timeout(10000) },
  });
  const [plans, attempts, worker] = await sql.transaction(
    [
      sql`SELECT (statement_timestamp() AT TIME ZONE 'UTC')::date::text AS day,
      COALESCE(b.spent_cents,0)::text AS spent,COALESCE(b.reserved_cents,0)::text AS reserved,COALESCE(r.usdc_raw,0)::text AS proceeds
      FROM fomo_copy_plans p LEFT JOIN fomo_copy_budgets b ON b.plan_id=p.id AND b.day=(statement_timestamp() AT TIME ZONE 'UTC')::date
      LEFT JOIN fomo_copy_proceeds r ON r.plan_id=p.id WHERE p.id=${planId} AND p.wallet=${wallet}`,
      sql`SELECT a.id,a.side,a.state,a.mint,a.reserved_cents::text,a.signature,a.updated_at::text,
      a.data->>'inputRaw' AS input_raw,a.data->>'inputDecimals' AS input_decimals,
      a.data->>'releaseReason' AS release_reason,a.data->'recoveryEvidence' AS recovery_evidence,
      a.data->>'minOutputRaw' AS minimum_output_raw,a.data->>'outputDecimals' AS output_decimals,
      CASE WHEN a.state='confirmed' THEN a.data->'receipt'->>'outputRaw' ELSE NULL END AS output_raw,
      j.attempt_id AS recovery_id,j.last_checked_at,j.next_run_at,j.checked_count,j.outcome,
      s.state AS signing_state,s.created_at AS signing_requested_at,s.updated_at AS signing_updated_at
      FROM fomo_copy_attempts a JOIN fomo_copy_plans p ON p.id=a.plan_id
      LEFT JOIN fomo_copy_recovery_jobs j ON j.attempt_id=a.id
      LEFT JOIN fomo_copy_signing_requests s ON s.attempt_id=a.id AND s.wallet=a.wallet
      WHERE p.id=${planId} AND p.wallet=${wallet} AND a.wallet=${wallet}
      ORDER BY (a.state IN ('reserved','submitting','unknown')) DESC,a.updated_at DESC,a.id DESC LIMIT 51`,
      sql`SELECT last_started_at,last_finished_at FROM fomo_copy_recovery_worker WHERE name='copy-recovery'`,
    ],
    { isolationLevel: "RepeatableRead", readOnly: true },
  );
  if (!plans.length) return null;
  return {
    wallet,
    planId,
    day: plans[0].day,
    buySpentCents: plans[0].spent,
    buyReservedCents: plans[0].reserved,
    sellProceedsRaw: plans[0].proceeds,
    checkedAt: Date.now(),
    backgroundRecovery: {
      available: recoveryAvailable(),
      workerStartedAt: worker[0]?.last_started_at
        ? new Date(worker[0].last_started_at).toISOString()
        : null,
      workerFinishedAt: worker[0]?.last_finished_at
        ? new Date(worker[0].last_finished_at).toISOString()
        : null,
    },
    hasMore: attempts.length > 50,
    attempts: attempts.slice(0, 50).map(
      (row) =>
        ({
          id: row.id,
          side: row.side,
          state: row.state,
          mint: row.mint,
          inputRaw:
            row.side === "sell"
              ? row.input_raw
              : (BigInt(row.reserved_cents) * 10000n).toString(),
          inputDecimals: row.side === "sell" ? Number(row.input_decimals) : 6,
          minimumOutputRaw: row.minimum_output_raw,
          outputDecimals: Number(row.output_decimals),
          ...(row.output_raw ? { outputRaw: row.output_raw } : {}),
          ...(row.signature ? { signature: row.signature } : {}),
          ...(row.signing_state
            ? {
                signing: {
                  state: row.signing_state,
                  requestedAt: new Date(row.signing_requested_at).toISOString(),
                  updatedAt: new Date(row.signing_updated_at).toISOString(),
                },
              }
            : {}),
          ...(row.recovery_evidence
            ? { recoveryEvidence: row.recovery_evidence }
            : {}),
          ...(row.recovery_id
            ? {
                recovery: {
                  checkedAt: row.last_checked_at
                    ? new Date(row.last_checked_at).toISOString()
                    : null,
                  nextCheckAt: new Date(row.next_run_at).toISOString(),
                  checks: row.checked_count,
                  outcome: row.outcome,
                },
              }
            : {}),
          ...(row.state === "released" &&
          ["paused", "stopped", "edited", "archived", "expired"].includes(
            row.release_reason,
          )
            ? { releaseReason: row.release_reason }
            : {}),
          updatedAt: row.updated_at,
        }) as CopyTradeRecord,
    ),
  };
}
