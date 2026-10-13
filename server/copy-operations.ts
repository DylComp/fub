import { neon } from "@neondatabase/serverless";
import { serviceConnection } from "./copy-service.js";
import { copyReadRpc } from "./copy-rpc.js";
import { MAINNET_GENESIS } from "./solana-network.js";
import { blockRecoveryRpc } from "./copy-block-recovery.js";

export type OperationsSnapshot = {
  checkedAt: string;
  executionEnabled: boolean;
  observer: { ready: boolean; heartbeatAgeSeconds: number | null };
  monitors: {
    active: number;
    expired: number;
    overdue: number;
    blocked: number;
  };
  recovery: {
    pending: number;
    olderThanThreeMinutes: number;
    missingJobs: number;
    overdueJobs: number;
    overdueUnsigned: number;
  };
  dispatch: { waiting: number; expired: number };
  nativePreparation: {
    queued: number;
    building: number;
    prepared: number;
    expired: number;
    stalled: number;
  };
  signing: { pending: number; uncertain: number; stalled: number };
  token22: {
    awaitingSigner: number;
    stalledSigner: number;
    pending: number;
    aged: number;
    overdue: number;
    inconsistent: number;
    accountingPending: number;
    accountingBlocked: number;
  };
};

// Private operator command only. Read one consistent snapshot, return aggregate
// counts, and never select wallet identities, signatures, keys or transaction data.
export async function operationsSnapshot(
  url: string,
): Promise<OperationsSnapshot> {
  const sql = neon(url, {
    fetchOptions: { signal: AbortSignal.timeout(8000) },
  });
  const [
    control,
    observer,
    monitors,
    recovery,
    dispatch,
    signing,
    token22,
    accounting,
    nativePreparation,
  ] = await sql.transaction(
    [
      sql`SELECT statement_timestamp()::text AS checked_at, enabled
      FROM fomo_copy_dispatch_control WHERE name='execution'`,
      sql`SELECT lease_until>statement_timestamp()
        AND last_heartbeat_at>statement_timestamp()-interval '75 seconds'
        AND outcome NOT IN('retry','stopped') AS ready,
      GREATEST(0,extract(epoch FROM statement_timestamp()-last_heartbeat_at))::int AS age
      FROM fomo_copy_service WHERE name='observer'`,
      sql`SELECT
      count(*) FILTER(WHERE m.enabled AND m.expires_at>statement_timestamp())::int AS active,
      count(*) FILTER(WHERE m.enabled AND m.expires_at<=statement_timestamp())::int AS expired,
      count(*) FILTER(WHERE m.enabled AND m.expires_at>statement_timestamp()
        AND m.next_run_at<statement_timestamp()-interval '90 seconds')::int AS overdue,
      count(*) FILTER(WHERE m.enabled AND m.expires_at>statement_timestamp()
        AND (f.status IN('gap','retry','catching_up') OR m.outcome IN('gap','retry','catching_up')))::int AS blocked
      FROM fomo_copy_monitors m LEFT JOIN fomo_copy_feed f ON f.plan_id=m.plan_id`,
      sql`SELECT
      count(*) FILTER(WHERE a.state IN('submitting','unknown'))::int AS pending,
      count(*) FILTER(WHERE a.state IN('submitting','unknown') AND a.created_at<statement_timestamp()-interval '3 minutes')::int AS aged,
      count(*) FILTER(WHERE a.state IN('submitting','unknown') AND j.attempt_id IS NULL)::int AS missing,
      count(*) FILTER(WHERE a.state IN('submitting','unknown') AND j.next_run_at<statement_timestamp()-interval '2 minutes'
        AND (j.lease_until IS NULL OR j.lease_until<=statement_timestamp()))::int AS overdue,
      count(*) FILTER(WHERE a.state='reserved' AND a.signature IS NULL AND NOT(a.data ? 'execution')
        AND a.expires_at<statement_timestamp()-interval '2 minutes')::int AS unsigned
      FROM fomo_copy_attempts a LEFT JOIN fomo_copy_recovery_jobs j ON j.attempt_id=a.id
      WHERE a.state IN('reserved','submitting','unknown')`,
      sql`SELECT count(*)::int AS waiting,
      count(*) FILTER(WHERE deadline<=statement_timestamp())::int AS expired
      FROM fomo_copy_dispatch WHERE state IN('queued','running')`,
      sql`SELECT
          count(*) FILTER(WHERE s.state='requested')::int AS pending,
          count(*) FILTER(WHERE s.state='uncertain')::int AS uncertain,
          count(*) FILTER(WHERE s.state='requested' AND s.created_at<statement_timestamp()-interval '15 seconds')::int AS stalled
          FROM fomo_copy_signing_requests s JOIN fomo_copy_attempts a ON a.id=s.attempt_id
          WHERE a.state IN('reserved','submitting','unknown')`,
      sql`SELECT
          count(*) FILTER(WHERE state='signing')::int AS awaiting_signer,
          count(*) FILTER(WHERE state='signing' AND updated_at<statement_timestamp()-interval '15 seconds')::int AS stalled_signer,
          count(*) FILTER(WHERE state='signed')::int AS pending,
          count(*) FILTER(WHERE state='signed' AND signed_at<statement_timestamp()-interval '3 minutes')::int AS aged,
          count(*) FILTER(WHERE state='signed' AND next_check_at<statement_timestamp()-interval '2 minutes'
            AND (lease_until IS NULL OR lease_until<=statement_timestamp()))::int AS overdue,
          count(*) FILTER(WHERE state='signed' AND last_outcome='inconsistent')::int AS inconsistent
          FROM fomo_token22_executions WHERE state IN('signing','signed') AND signed_expiry IS NULL`,
      sql`SELECT count(*)::int AS pending,
          count(*) FILTER(WHERE r.issue IS NOT NULL)::int AS blocked
          FROM fomo_token22_reservations r JOIN fomo_token22_executions e ON e.id=r.execution_id
          WHERE r.state='reserved' AND (e.signed_expiry IS NOT NULL OR e.state IN('confirmed','failed','canceled') OR (e.state='prepared' AND e.expires_at<=statement_timestamp()))`,
      sql`SELECT
        count(*) FILTER(WHERE j.state='queued' AND c.id IS NOT NULL)::int AS queued,
        count(*) FILTER(WHERE j.state='building' AND j.lease_until>statement_timestamp() AND c.id IS NOT NULL)::int AS building,
        count(*) FILTER(WHERE j.state='prepared' AND c.id IS NOT NULL AND e.state='prepared' AND e.expires_at>statement_timestamp())::int AS prepared,
        count(*) FILTER(WHERE j.state IN('queued','building') AND j.deadline<=statement_timestamp())::int AS expired,
        count(*) FILTER(WHERE j.lease_until<=statement_timestamp() AND c.id IS NOT NULL AND
          (j.state='building' OR (j.state='prepared' AND e.state IN('prepared','signed') AND NOT EXISTS(SELECT 1 FROM fomo_token22_submissions s WHERE s.execution_id=e.id))))::int AS stalled
        FROM fomo_token22_jobs j LEFT JOIN fomo_token22_current_jobs c ON c.id=j.id LEFT JOIN fomo_token22_executions e ON e.id=j.execution_id`,
    ],
    { isolationLevel: "RepeatableRead", readOnly: true },
  );
  if (control.length !== 1 || typeof control[0].enabled !== "boolean")
    throw Error("Execution control is unavailable.");
  return {
    checkedAt: new Date(control[0].checked_at).toISOString(),
    executionEnabled: control[0].enabled,
    observer: {
      ready: observer[0]?.ready === true,
      heartbeatAgeSeconds: observer[0]?.age ?? null,
    },
    monitors: {
      active: monitors[0].active,
      expired: monitors[0].expired,
      overdue: monitors[0].overdue,
      blocked: monitors[0].blocked,
    },
    recovery: {
      pending: recovery[0].pending,
      olderThanThreeMinutes: recovery[0].aged,
      missingJobs: recovery[0].missing,
      overdueJobs: recovery[0].overdue,
      overdueUnsigned: recovery[0].unsigned,
    },
    dispatch: { waiting: dispatch[0].waiting, expired: dispatch[0].expired },
    nativePreparation:
      nativePreparation[0] as OperationsSnapshot["nativePreparation"],
    signing: {
      pending: signing[0].pending,
      uncertain: signing[0].uncertain,
      stalled: signing[0].stalled,
    },
    token22: {
      awaitingSigner: token22[0].awaiting_signer,
      stalledSigner: token22[0].stalled_signer,
      pending: token22[0].pending,
      aged: token22[0].aged,
      overdue: token22[0].overdue,
      inconsistent: token22[0].inconsistent,
      accountingPending: accounting[0].pending,
      accountingBlocked: accounting[0].blocked,
    },
  };
}

export function operationsIssues(
  snapshot: OperationsSnapshot,
  running: boolean,
) {
  const issues: string[] = [];
  // These deployable entries have no signer. Even accidentally enabling the DB
  // control must not be represented as a ready automatic trading installation.
  if (snapshot.executionEnabled)
    issues.push("execution_control_enabled_without_installed_signer");
  if (running && !snapshot.observer.ready)
    issues.push("continuous_observer_not_ready");
  if (snapshot.monitors.overdue) issues.push("monitor_checks_overdue");
  if (snapshot.monitors.blocked) issues.push("monitor_evidence_blocked");
  if (snapshot.monitors.expired) issues.push("monitor_subscriptions_expired");
  if (snapshot.recovery.olderThanThreeMinutes)
    issues.push("transactions_awaiting_finalized_evidence");
  if (snapshot.recovery.missingJobs)
    issues.push("pending_transactions_without_recovery_jobs");
  if (snapshot.recovery.overdueJobs) issues.push("recovery_checks_overdue");
  if (snapshot.recovery.overdueUnsigned)
    issues.push("unsigned_reservations_cleanup_overdue");
  if (snapshot.dispatch.expired) issues.push("dispatch_cleanup_overdue");
  if (snapshot.nativePreparation.expired)
    issues.push("native_preparation_cleanup_overdue");
  if (snapshot.nativePreparation.stalled)
    issues.push("native_preparation_worker_stalled");
  if (snapshot.signing.uncertain)
    issues.push("signing_provider_outcome_uncertain");
  if (snapshot.signing.stalled) issues.push("signing_provider_request_stalled");
  if (snapshot.token22.stalledSigner)
    issues.push("token22_signing_request_stalled");
  if (snapshot.token22.aged) issues.push("token22_awaiting_finalized_evidence");
  if (snapshot.token22.overdue) issues.push("token22_recovery_checks_overdue");
  if (snapshot.token22.inconsistent)
    issues.push("token22_recovery_evidence_inconsistent");
  if (snapshot.token22.accountingBlocked)
    issues.push("token22_accounting_blocked");
  return issues;
}

type Status = "ok" | "missing" | "invalid" | "unavailable";
export type OperationsDependencies = {
  snapshot: typeof operationsSnapshot;
  mainnet(endpoint: string): Promise<void>;
};
const defaults: OperationsDependencies = {
  snapshot: operationsSnapshot,
  async mainnet(endpoint) {
    const rpc = copyReadRpc(endpoint);
    if ((await rpc("getGenesisHash", [])) !== MAINNET_GENESIS)
      throw Error("Wrong network.");
    const slot = await rpc("getSlot", [{ commitment: "finalized" }]);
    if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot <= 0)
      throw Error("Invalid finalized slot.");
  },
};
export async function checkOperations(
  env: Record<string, string | undefined>,
  running = false,
  deps: OperationsDependencies = defaults,
) {
  const checks: Record<string, Status> = {
    configuration: "missing",
    database: "missing",
    rpc: "missing",
    archiveRpc: env.SOLANA_ARCHIVE_RPC_URL ? "invalid" : "missing",
  };
  const issues: string[] = [];
  let snapshot: OperationsSnapshot | null = null;
  let endpoint: string | undefined;
  try {
    const config = serviceConnection(env);
    if (
      env.COPY_EXECUTION_ENABLED === "true" ||
      env.COPY_NATIVE_EXECUTION_ENABLED === "true" ||
      env.FUNDING_EXECUTION_ENABLED === "true"
    )
      throw Error("Read-only deployment only.");
    endpoint = config.endpoint;
    checks.configuration = "ok";
  } catch {
    checks.configuration = "invalid";
    issues.push("worker_configuration_incomplete_or_unsafe");
  }
  if (env.DATABASE_URL) {
    try {
      snapshot = await deps.snapshot(env.DATABASE_URL);
      checks.database = "ok";
      issues.push(...operationsIssues(snapshot, running));
    } catch {
      checks.database = "unavailable";
      issues.push("database_or_worker_schema_unavailable");
    }
  } else issues.push("database_not_configured");
  if (endpoint) {
    try {
      await deps.mainnet(endpoint);
      checks.rpc = "ok";
    } catch {
      checks.rpc = "unavailable";
      issues.push("mainnet_rpc_probe_failed");
    }
  } else issues.push("dedicated_mainnet_rpc_not_configured");
  if (env.SOLANA_ARCHIVE_RPC_URL) {
    try {
      blockRecoveryRpc(env.SOLANA_ARCHIVE_RPC_URL);
      await deps.mainnet(env.SOLANA_ARCHIVE_RPC_URL);
      checks.archiveRpc = "ok";
    } catch {
      checks.archiveRpc = "unavailable";
      issues.push("archive_rpc_probe_failed");
    }
  }
  return {
    mode: running ? "running" : "preflight",
    ready: issues.length === 0,
    automaticTradingReady: false,
    checks,
    snapshot,
    issues,
    limitations: [
      "No signing provider is installed.",
      "RPC probes do not establish historical coverage or capacity.",
      "Process health must also pass on each deployed host.",
    ],
  };
}
