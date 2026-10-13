import {nativePermissionSellLimit} from "../src/native-copy-permission.js";
import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import {
  verifyToken22Permission,
  assertToken22PermissionReview,
  type Token22Permission,
} from "./token2022-permission.js";
import {
  raydium22ReviewHash,
  verifyRaydium22Review,
  type Raydium22ExecutionReview,
} from "./native-copy-review.js";
import { TOKEN_2022 } from "./jupiter-routes.js";
import { TOKEN_PROGRAM, WSOL, operationId } from "../src/funding-model.js";
import { isMint } from "../src/assets.js";
import { proportionalSell } from "../src/copy-account.js";
import { tokenUnits } from "../src/token-fees.js";
import type { SwapEvidence } from "../src/copy-feed.js";
import type { Raydium22Request } from "./token2022-raydium.js";
export type NativeTicket = { id: string; leaseId: string };
export type NativeDispatchTicket = NativeTicket & {
  wallet: string;
  planId: string;
  executionId: string;
  leaderSignature: string;
};
export type NativeJob = NativeTicket & {
  executionId: string;
  wallet: string;
  planId: string;
  leaderSignature: string;
  leaderSlot: number;
  deadline: number;
  leaseUntil: number;
  decision: SwapEvidence;
  permission: Token22Permission;
  scopeHash: string;
};
export function nativeJobRequest(
  job: NativeJob,
  positionRaw: string,
): Raydium22Request {
  const d = job.decision;
  if (
    ((job.permission.version===2||job.permission.version===4||job.permission.version===6||job.permission.version===8||job.permission.version===10) && d.mint!==job.permission.mint) ||
    d.kind !== "swap" ||
    (d.tokenProgram !== TOKEN_2022 && !(job.permission.version>=5 && ["raydium-native-sol-v2","native-sol-venues-v3","native-sol-venues-v4"].includes(job.permission.policy) && d.tokenProgram===TOKEN_PROGRAM)) ||
    d.quoteMint !== WSOL ||
    !isMint(d.mint) ||
    d.mint === WSOL ||
    !Number.isInteger(d.tokenDecimals) ||
    d.tokenDecimals < 0 ||
    d.tokenDecimals > 18 ||
    !["buy", "sell"].includes(d.side) ||
    (d.side === "sell" && job.permission.copySells !== true)
  )
    throw Error("Unsupported native leader event.");
  const inputRaw =
    d.side === "buy"
      ? job.permission.buyLamports
      : proportionalSell(positionRaw, d.leaderTokenBeforeRaw, d.tokenRaw);
  if (
    tokenUnits(inputRaw) < 1n ||
    (d.side==="sell" && tokenUnits(inputRaw)>nativePermissionSellLimit(job.permission)) ||
    tokenUnits(inputRaw) > (d.side === "buy" ? 10000000n : tokenUnits(positionRaw))
  )
    throw Error("Native trade size is outside the supported policy.");
  return {
    wallet: job.wallet,
    mint: d.mint,
    direction: d.side,
    inputRaw,
    minOutputRaw: "1",
    slippageBps: job.permission.slippageBps,
  };
}
export function token22Queue(url: string) {
  const client = () =>
    neon(url, { fetchOptions: { signal: AbortSignal.timeout(8000) } });
  const ticket = (t: NativeTicket) => {
    if (!operationId(t.id) || !operationId(t.leaseId))
      throw Error("Invalid native job ticket.");
  };
  async function current(t: NativeTicket): Promise<NativeJob | null> {
    ticket(t);
    const sql = client();
    const rows =
      await sql`SELECT j.*,g.scope,g.signature,g.scope_hash FROM fomo_token22_current_jobs j JOIN fomo_token22_permissions g ON g.id=j.permission_id WHERE j.id=${t.id} AND j.state='building' AND j.lease_id=${t.leaseId} AND j.lease_until>statement_timestamp()`;
    if (!rows[0]) return null;
    const r = rows[0];
    if (verifyToken22Permission(r.scope, r.signature) !== r.scope_hash)
      throw Error("Native job permission proof changed.");
    return {
      id: r.id,
      leaseId: t.leaseId,
      executionId: r.execution_id,
      wallet: r.wallet,
      planId: r.plan_id,
      leaderSignature: r.leader_signature,
      leaderSlot: Number(r.leader_slot),
      deadline: new Date(r.deadline).getTime(),
      leaseUntil: new Date(r.lease_until).getTime(),
      decision: r.decision,
      permission: r.scope,
      scopeHash: r.scope_hash,
    };
  }
  async function sweep() {
    const sql = client();
    await sql`UPDATE fomo_token22_jobs j SET state='skipped',lease_id=NULL,lease_until=NULL,updated_at=statement_timestamp(),
    reason=CASE WHEN j.deadline<=statement_timestamp() THEN 'expired' WHEN NOT EXISTS(SELECT 1 FROM fomo_copy_dispatch_control c WHERE c.name='execution' AND c.enabled AND c.epoch=j.epoch) THEN 'halted' ELSE 'permission_changed' END
    WHERE j.state IN('queued','building') AND NOT EXISTS(SELECT 1 FROM fomo_token22_current_jobs c WHERE c.id=j.id)`;
    await sql`UPDATE fomo_token22_jobs SET state='skipped',reason='retries_exhausted',lease_id=NULL,lease_until=NULL,updated_at=statement_timestamp() WHERE state IN('queued','building') AND runs>=3 AND (lease_until IS NULL OR lease_until<=statement_timestamp())`;
  }
  return {
    current,
    sweep,
    // Scheduling leases prevent busy loops and overlapping host work. The
    // journal's irreversible signing/send claims remain the execution fence.
    async claimDispatch(): Promise<NativeDispatchTicket | null> {
      const sql = client(),
        leaseId = randomUUID();
      const [, rows] = await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended('copy-dispatch-claim',0))`,
        sql`WITH due AS (
          SELECT j.id FROM fomo_token22_current_jobs j
          JOIN fomo_token22_executions e ON e.id=j.execution_id AND e.queue_job_id=j.id AND e.wallet=j.wallet
          WHERE j.state='prepared' AND j.next_run_at<=statement_timestamp()
            AND (j.lease_until IS NULL OR j.lease_until<=statement_timestamp())
            AND e.state IN('prepared','signed') AND e.expires_at>statement_timestamp()
            AND (e.lease_until IS NULL OR e.lease_until<=statement_timestamp())
            AND NOT EXISTS(SELECT 1 FROM fomo_token22_submissions s WHERE s.execution_id=e.id)
            AND NOT EXISTS(SELECT 1 FROM fomo_token22_jobs other WHERE other.wallet=j.wallet AND other.id<>j.id AND other.state IN('building','prepared') AND other.lease_until>statement_timestamp())
            AND NOT EXISTS(SELECT 1 FROM fomo_token22_reservations r WHERE r.wallet=j.wallet AND r.state='reserved' AND r.execution_id<>e.id)
            AND NOT EXISTS(SELECT 1 FROM fomo_copy_attempts a WHERE a.wallet=j.wallet AND a.state IN('reserved','submitting','unknown'))
            AND NOT EXISTS(SELECT 1 FROM fomo_copy_dispatch d WHERE d.wallet=j.wallet AND d.state='running' AND d.lease_until>statement_timestamp())
          ORDER BY j.next_run_at,j.sequence,j.id LIMIT 1
        ) UPDATE fomo_token22_jobs j SET lease_id=${leaseId},lease_until=LEAST(statement_timestamp()+interval '40 seconds',deadline),updated_at=statement_timestamp()
          FROM due WHERE j.id=due.id RETURNING j.id,j.wallet,j.plan_id,j.execution_id,j.leader_signature`,
      ]);
      const r = rows[0];
      return r
        ? {
            id: r.id,
            leaseId,
            wallet: r.wallet,
            planId: r.plan_id,
            executionId: r.execution_id,
            leaderSignature: r.leader_signature,
          }
        : null;
    },
    async releaseDispatch(t: NativeDispatchTicket) {
      ticket(t);
      const sql = client();
      await sql`UPDATE fomo_token22_jobs SET lease_id=NULL,lease_until=NULL,next_run_at=statement_timestamp()+interval '3 seconds',updated_at=statement_timestamp()
        WHERE id=${t.id} AND state='prepared' AND lease_id=${t.leaseId}`;
    },
    async discover() {
      const sql = client();
      const rows =
        await sql`INSERT INTO fomo_token22_jobs(id,execution_id,wallet,plan_id,leader_signature,permission_id,plan_version,epoch,sequence,leader_slot,decision,deadline)
    SELECT gen_random_uuid(),gen_random_uuid(),p.wallet,p.id,e.signature,g.id,p.version,c.epoch,e.sequence,e.slot,e.decision,LEAST(to_timestamp(e.block_time)+interval '60 seconds',g.expires_at)
    FROM fomo_copy_plans p JOIN fomo_token22_permissions g ON g.plan_id=p.id AND g.wallet=p.wallet JOIN fomo_copy_feed f ON f.plan_id=p.id JOIN fomo_copy_feed_events e ON e.plan_id=p.id CROSS JOIN fomo_copy_dispatch_control c
    WHERE c.name='execution' AND c.enabled AND p.enabled AND NOT p.archived AND g.revoked_at IS NULL AND g.expires_at>statement_timestamp()
      AND p.version=(g.scope->>'planVersion')::integer AND p.leader=g.scope->>'leader' AND (p.data->>'slippageBps')::integer>=(g.scope->>'slippageBps')::integer
      AND f.status='ready' AND NOT e.failed AND e.decision->>'kind'='swap' AND (e.decision->>'tokenProgram'=${TOKEN_2022} OR (e.decision->>'tokenProgram'=${TOKEN_PROGRAM} AND ((g.scope->>'version' IN ('5','6') AND g.scope->>'policy'='raydium-native-sol-v2') OR (g.scope->>'version' IN ('7','8') AND g.scope->>'policy'='native-sol-venues-v3') OR (g.scope->>'version' IN ('9','10') AND g.scope->>'policy'='native-sol-venues-v4')))) AND e.decision->>'quoteMint'=${WSOL}
      AND ((g.scope->>'version' IN ('1','3','5','7','9') AND NOT g.scope ? 'mint') OR (g.scope->>'version' IN ('2','4','6','8','10') AND g.scope->>'mint'=e.decision->>'mint'))
      AND e.decision->>'side' IN('buy','sell') AND (e.decision->>'side'='buy' OR ((g.scope->>'copySells')::boolean AND (p.data->>'copySells')::boolean))
      AND e.slot>0 AND p.enabled_at<=to_timestamp(e.block_time) AND to_timestamp(e.block_time)>statement_timestamp()-interval '60 seconds' AND to_timestamp(e.block_time)<=statement_timestamp()+interval '5 seconds'
      AND NOT EXISTS(SELECT 1 FROM fomo_copy_controls x WHERE x.wallet=p.wallet)
      AND NOT EXISTS(SELECT 1 FROM fomo_copy_feed_events x WHERE x.plan_id=p.id AND x.decision IS NULL)
      AND NOT EXISTS(SELECT 1 FROM fomo_token22_reservations x WHERE x.plan_id=p.id AND x.leader_signature=e.signature)
      AND NOT EXISTS(SELECT 1 FROM fomo_token22_jobs x WHERE x.plan_id=p.id AND x.leader_signature=e.signature)
    ORDER BY e.sequence,p.id LIMIT 100 ON CONFLICT(plan_id,leader_signature) DO NOTHING RETURNING id`;
      return rows.length;
    },
    async claim(): Promise<NativeJob | null> {
      await sweep();
      const sql = client(),
        leaseId = randomUUID();
      const [, rows] = await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended('copy-dispatch-claim',0))`,
        sql`WITH due AS (SELECT j.id FROM fomo_token22_current_jobs j WHERE j.state IN('queued','building') AND j.runs<3 AND j.next_run_at<=statement_timestamp() AND (j.lease_until IS NULL OR j.lease_until<=statement_timestamp())
     AND NOT EXISTS(SELECT 1 FROM fomo_token22_jobs other WHERE other.wallet=j.wallet AND other.id<>j.id AND ((other.state='building' AND other.lease_until>statement_timestamp()) OR (other.state='prepared' AND other.deadline>statement_timestamp() AND NOT EXISTS(SELECT 1 FROM fomo_token22_executions e WHERE e.id=other.execution_id AND e.state IN('confirmed','failed','canceled')))))
     AND NOT EXISTS(SELECT 1 FROM fomo_token22_jobs older WHERE older.plan_id=j.plan_id AND older.sequence<j.sequence AND older.state IN('queued','building'))
     AND NOT EXISTS(SELECT 1 FROM fomo_token22_reservations r WHERE r.wallet=j.wallet AND r.state='reserved')
     AND NOT EXISTS(SELECT 1 FROM fomo_copy_attempts a WHERE a.wallet=j.wallet AND a.state IN('reserved','submitting','unknown'))
     AND NOT EXISTS(SELECT 1 FROM fomo_copy_dispatch d WHERE d.wallet=j.wallet AND d.state='running' AND d.lease_until>statement_timestamp())
     ORDER BY j.sequence,j.id LIMIT 1)
     UPDATE fomo_token22_jobs j SET state='building',runs=runs+1,lease_id=${leaseId},lease_until=LEAST(statement_timestamp()+interval '30 seconds',deadline),updated_at=statement_timestamp() FROM due WHERE j.id=due.id RETURNING j.id`,
      ]);
      return rows[0] ? current({ id: rows[0].id, leaseId }) : null;
    },
    async position(job: NativeJob) {
      const sql = client();
      const rows =
        await sql`SELECT raw_amount::text FROM fomo_token22_positions WHERE plan_id=${job.planId} AND mint=${job.decision.mint} AND decimals=${job.decision.tokenDecimals}`;
      return rows[0]?.raw_amount ?? "0";
    },
    async save(t: NativeTicket, review: Raydium22ExecutionReview) {
      const job = await current(t);
      if (!job) return null;
      const r = structuredClone(review),
        digest = raydium22ReviewHash(r);
      verifyRaydium22Review(r, digest);
      assertToken22PermissionReview(job.permission, r);
      const position = await this.position(job),
        request = nativeJobRequest(job, position);
      if (
        (r.accounts.tokenProgram??TOKEN_2022)!==job.decision.tokenProgram ||
        r.accounts.wallet !== job.wallet ||
        r.accounts.mint !== request.mint ||
        r.accounts.direction !== request.direction ||
        r.accounts.inputRaw !== request.inputRaw ||
        r.accounts.decimals !== job.decision.tokenDecimals ||
        r.minContextSlot < job.leaderSlot ||
        r.reviewedAt > Date.now() ||
        r.expiresAt <= Date.now() ||
        r.expiresAt > job.deadline
      )
        throw Error("Preparation does not match the native job.");
      const sql = client();
      const [, rows] = await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${job.wallet},0))`,
        sql`WITH eligible AS (SELECT j.* FROM fomo_token22_jobs j JOIN fomo_token22_current_jobs c ON c.id=j.id JOIN fomo_token22_permissions g ON g.id=j.permission_id WHERE j.id=${job.id} AND j.state='building' AND j.lease_id=${job.leaseId} AND j.lease_until>clock_timestamp() AND j.deadline>=to_timestamp(${r.expiresAt}/1000.0) AND to_timestamp(${r.expiresAt}/1000.0)>clock_timestamp() AND g.scope_hash=${job.scopeHash}
      AND (j.decision->>'side'='buy' OR EXISTS(SELECT 1 FROM fomo_token22_positions p WHERE p.plan_id=j.plan_id AND p.mint=${r.accounts.mint} AND p.decimals=${r.accounts.decimals} AND p.raw_amount=${position}::numeric AND p.last_slot<=${r.minContextSlot})) FOR UPDATE OF j),
     saved AS (INSERT INTO fomo_token22_executions(id,wallet,message_hash,review_hash,review,expires_at,queue_job_id)
      SELECT execution_id,wallet,${r.messageHash},${digest},${JSON.stringify(r)}::jsonb,to_timestamp(${r.expiresAt}/1000.0),id FROM eligible ON CONFLICT DO NOTHING RETURNING id)
     UPDATE fomo_token22_jobs j SET state='prepared',lease_id=NULL,lease_until=NULL,updated_at=clock_timestamp() FROM saved s WHERE j.execution_id=s.id RETURNING j.execution_id`,
      ]);
      return (rows[0]?.execution_id as string | undefined) ?? null;
    },
    async finish(t: NativeTicket, retry: boolean) {
      ticket(t);
      const sql = client();
      await sql`UPDATE fomo_token22_jobs SET state=CASE WHEN ${retry} AND runs<3 AND deadline>statement_timestamp()+interval '2 seconds' THEN 'queued' ELSE 'skipped' END, reason=CASE WHEN ${retry} AND runs<3 AND deadline>statement_timestamp()+interval '2 seconds' THEN NULL WHEN runs>=3 THEN 'retries_exhausted' ELSE 'ineligible' END,lease_id=NULL,lease_until=NULL,next_run_at=statement_timestamp()+power(2,runs-1)*interval '1 second',updated_at=statement_timestamp() WHERE id=${t.id} AND lease_id=${t.leaseId} AND state='building' AND lease_until>statement_timestamp()`;
    },
  };
}
