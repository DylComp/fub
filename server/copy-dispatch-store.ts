import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { verifyCopyPermission } from "./copy-permission-model.js";
import type { CopyPermissionScope } from "./copy-permission-model.js";
import type { SwapEvidence } from "../src/copy-feed.js";
import { TOKEN_PROGRAM } from "../src/funding-model.js";

export type DispatchTicket = { id: string; leaseId: string };
export type DispatchClaim = DispatchTicket & {
  wallet: string;
  planId: string;
  signature: string;
  planVersion: number;
  deadline: number;
  leaseUntil: number;
  blockTime: number;
  decision: SwapEvidence;
  permission: { scope: CopyPermissionScope; signature: string; hash: string };
};
export function copyDispatchStore(url: string) {
  const client = () =>
    neon(url, { fetchOptions: { signal: AbortSignal.timeout(5000) } });
  async function sweep() {
    const sql = client();
    // A crashed worker's durable submission wins over expiry, revocation and halt.
    await sql`UPDATE fomo_copy_dispatch j SET state='submitted',reason=NULL,lease_id=NULL,lease_until=NULL,updated_at=statement_timestamp()
      WHERE j.state IN('queued','running') AND EXISTS(SELECT 1 FROM fomo_copy_attempts a WHERE a.plan_id=j.plan_id AND a.leader_signature=j.leader_signature AND a.wallet=j.wallet AND a.state IN('submitting','unknown','confirmed','failed'))`;
    await sql`UPDATE fomo_copy_dispatch j SET state='skipped',lease_id=NULL,lease_until=NULL,updated_at=statement_timestamp(),
      reason=CASE WHEN j.deadline<=statement_timestamp() THEN 'expired'
        WHEN NOT EXISTS(SELECT 1 FROM fomo_copy_dispatch_control c WHERE c.name='execution' AND c.enabled AND c.epoch=j.epoch) THEN 'halted'
        WHEN EXISTS(SELECT 1 FROM fomo_copy_attempts a WHERE a.plan_id=j.plan_id AND a.leader_signature=j.leader_signature AND a.state IN('released','skipped')) THEN 'attempt_finished'
        ELSE 'permission_changed' END
      WHERE j.state IN('queued','running') AND NOT EXISTS(SELECT 1 FROM fomo_copy_attempts a WHERE a.plan_id=j.plan_id AND a.leader_signature=j.leader_signature AND a.state IN('submitting','unknown','confirmed','failed'))
        AND (j.deadline<=statement_timestamp()
          OR NOT EXISTS(SELECT 1 FROM fomo_copy_dispatch_control c WHERE c.name='execution' AND c.enabled AND c.epoch=j.epoch)
          OR NOT EXISTS(SELECT 1 FROM fomo_copy_authorized_plans p WHERE p.id=j.plan_id AND p.wallet=j.wallet AND p.enabled AND p.version=j.plan_version AND p.permission_id=j.permission_id)
          OR EXISTS(SELECT 1 FROM fomo_copy_attempts a WHERE a.plan_id=j.plan_id AND a.leader_signature=j.leader_signature AND a.state IN('released','skipped'))) `;
  }
  return {
    sweep,
    async halt() {
      const sql = client();
      await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended('copy-dispatch-claim',0))`,
        sql`UPDATE fomo_copy_dispatch_control SET enabled=false,epoch=epoch+1,updated_at=statement_timestamp() WHERE name='execution'`,
      ]);
      // Never releases a submitted reservation. Old epochs cannot resume.
    },
    async discover() {
      const sql = client();
      const rows =
        await sql`INSERT INTO fomo_copy_dispatch(id,plan_id,leader_signature,wallet,plan_version,permission_id,epoch,sequence,deadline)
        SELECT gen_random_uuid(),p.id,e.signature,p.wallet,p.version,p.permission_id,c.epoch,e.sequence,
          LEAST(to_timestamp(e.block_time)+interval '60 seconds',p.permission_expires_at)
        FROM fomo_copy_authorized_plans p JOIN fomo_copy_feed f ON f.plan_id=p.id
        JOIN fomo_copy_feed_events e ON e.plan_id=p.id CROSS JOIN fomo_copy_dispatch_control c
        WHERE c.name='execution' AND c.enabled AND p.enabled AND f.status='ready' AND NOT e.failed
          AND e.decision->>'kind'='swap' AND e.decision->>'side' IN('buy','sell')
          AND COALESCE(e.decision->>'tokenProgram',${TOKEN_PROGRAM})=${TOKEN_PROGRAM}
          AND (e.decision->>'side'='buy' OR (p.data->>'copySells')::boolean)
          AND e.block_time IS NOT NULL AND to_timestamp(e.block_time)>=p.enabled_at
          AND to_timestamp(e.block_time)>statement_timestamp()-interval '60 seconds'
          AND to_timestamp(e.block_time)<=statement_timestamp()+interval '5 seconds'
          AND NOT EXISTS(SELECT 1 FROM fomo_copy_feed_events pending WHERE pending.plan_id=p.id AND pending.decision IS NULL)
          AND NOT EXISTS(SELECT 1 FROM fomo_copy_attempts a WHERE a.plan_id=p.id AND a.leader_signature=e.signature)
          AND NOT EXISTS(SELECT 1 FROM fomo_copy_dispatch j WHERE j.plan_id=p.id AND j.leader_signature=e.signature)
        ORDER BY e.sequence,p.id LIMIT 100 ON CONFLICT(plan_id,leader_signature) DO NOTHING RETURNING id`;
      return rows.length;
    },
    async claim(): Promise<DispatchClaim | null> {
      const sql = client(),
        leaseId = randomUUID();
      await sweep();
      const [, rows] = await sql.transaction([
        // Serialize short allocation transactions, not network work. Two jobs on
        // one wallet cannot both win even when separate worker processes race.
        sql`SELECT pg_advisory_xact_lock(hashtextextended('copy-dispatch-claim',0))`,
        sql`WITH due AS (
          SELECT j.id FROM fomo_copy_dispatch j JOIN fomo_copy_authorized_plans p ON p.id=j.plan_id AND p.wallet=j.wallet AND p.version=j.plan_version AND p.permission_id=j.permission_id
          JOIN fomo_copy_dispatch_control c ON c.name='execution' JOIN fomo_copy_feed f ON f.plan_id=j.plan_id
          WHERE c.enabled AND c.epoch=j.epoch AND p.enabled AND f.status='ready' AND j.state IN('queued','running') AND j.runs<3
            AND j.deadline>statement_timestamp() AND j.next_run_at<=statement_timestamp() AND (j.lease_until IS NULL OR j.lease_until<=statement_timestamp())
            AND NOT EXISTS(SELECT 1 FROM fomo_copy_feed_events pending WHERE pending.plan_id=j.plan_id AND pending.decision IS NULL)
            AND NOT EXISTS(SELECT 1 FROM fomo_copy_dispatch other WHERE other.wallet=j.wallet AND other.id<>j.id AND other.state='running' AND other.lease_until>statement_timestamp())
            AND NOT EXISTS(SELECT 1 FROM fomo_token22_jobs native WHERE native.wallet=j.wallet AND native.state IN('building','prepared') AND native.lease_until>statement_timestamp())
            AND NOT EXISTS(SELECT 1 FROM fomo_copy_dispatch older WHERE older.plan_id=j.plan_id AND older.sequence<j.sequence AND older.state IN('queued','running'))
            AND NOT EXISTS(SELECT 1 FROM fomo_copy_attempts a WHERE a.wallet=j.wallet AND a.state IN('reserved','submitting','unknown') AND (a.plan_id<>j.plan_id OR a.leader_signature<>j.leader_signature OR a.state<>'reserved'))
          ORDER BY j.sequence,j.id LIMIT 1
        ) UPDATE fomo_copy_dispatch j SET state='running',runs=runs+1,lease_id=${leaseId},lease_until=LEAST(statement_timestamp()+interval '30 seconds',deadline),updated_at=statement_timestamp()
          FROM due WHERE j.id=due.id RETURNING j.id`,
      ]);
      return rows[0] ? this.current({ id: rows[0].id, leaseId }) : null;
    },
    async current(ticket: DispatchTicket): Promise<DispatchClaim | null> {
      const sql = client();
      const rows =
        await sql`SELECT j.*,e.block_time,e.decision,g.scope,g.signature AS proof,g.scope_hash
        FROM fomo_copy_dispatch j JOIN fomo_copy_feed_events e ON e.plan_id=j.plan_id AND e.signature=j.leader_signature
        JOIN fomo_copy_permissions g ON g.id=j.permission_id
        WHERE j.id=${ticket.id} AND fomo_copy_dispatch_allowed(j.wallet,j.plan_id,j.leader_signature,j.id::text,${ticket.leaseId})`;
      if (!rows[0]) return null;
      const r = rows[0];
      if (verifyCopyPermission(r.scope, r.proof) !== r.scope_hash)
        throw new Error("Dispatch permission proof changed.");
      return {
        id: r.id,
        leaseId: ticket.leaseId,
        wallet: r.wallet,
        planId: r.plan_id,
        signature: r.leader_signature,
        planVersion: r.plan_version,
        deadline: new Date(r.deadline).getTime(),
        leaseUntil: new Date(r.lease_until).getTime(),
        blockTime: Number(r.block_time),
        decision: r.decision,
        permission: { scope: r.scope, signature: r.proof, hash: r.scope_hash },
      };
    },
    async attempt(ticket: DispatchTicket) {
      const sql = client();
      const rows =
        await sql`SELECT a.id FROM fomo_copy_dispatch j JOIN fomo_copy_attempts a ON a.plan_id=j.plan_id AND a.leader_signature=j.leader_signature AND a.wallet=j.wallet
        WHERE j.id=${ticket.id} AND j.lease_id=${ticket.leaseId}`;
      return rows[0]?.id as string | undefined;
    },
    async complete(
      ticket: DispatchTicket,
      outcome: "submitted" | "retry" | "ineligible",
    ) {
      const sql = client();
      await sql`UPDATE fomo_copy_dispatch j SET
        state=CASE WHEN EXISTS(SELECT 1 FROM fomo_copy_attempts a WHERE a.plan_id=j.plan_id AND a.leader_signature=j.leader_signature AND a.state IN('submitting','unknown','confirmed','failed')) THEN 'submitted'
          WHEN ${outcome}='retry' AND runs<3 AND deadline>statement_timestamp()+interval '2 seconds' THEN 'queued' ELSE 'skipped' END,
        reason=CASE WHEN EXISTS(SELECT 1 FROM fomo_copy_attempts a WHERE a.plan_id=j.plan_id AND a.leader_signature=j.leader_signature AND a.state IN('submitting','unknown','confirmed','failed')) THEN NULL
          WHEN ${outcome}='retry' AND runs<3 AND deadline>statement_timestamp()+interval '2 seconds' THEN NULL
          WHEN runs>=3 THEN 'retries_exhausted' ELSE 'ineligible' END,
        lease_id=NULL,lease_until=NULL,next_run_at=statement_timestamp()+power(2,runs-1)*interval '1 second',updated_at=statement_timestamp()
        WHERE id=${ticket.id} AND lease_id=${ticket.leaseId} AND lease_until>statement_timestamp() AND state='running'`;
    },
    async health() {
      const sql = client();
      const rows = await sql`SELECT c.enabled,c.epoch::text,
        count(j.id) FILTER(WHERE j.state='queued')::integer AS queued,
        count(j.id) FILTER(WHERE j.state='running' AND j.lease_until>statement_timestamp())::integer AS running,
        max(j.updated_at) AS last_work_at
        FROM fomo_copy_dispatch_control c LEFT JOIN fomo_copy_dispatch j ON true WHERE c.name='execution' GROUP BY c.name`;
      return rows[0];
    },
  };
}
