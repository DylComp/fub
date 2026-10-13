import {buybackPilotPolicy,type BuybackPilot} from "./buyback-pilot.js";
import { neon } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";
import {
  buybackPolicyId,
  buybackId,
  buybackReservation,
  verifyBuybackSigned,
} from "./buyback-model.js";
import { verifyBuybackPlan } from "./buyback-chain.js";
import { rawLamports } from "./launch-payout-model.js";
import {validateBuybackNonlanding,type BuybackNonlandingProof} from './buyback-nonlanding.js';
import type {
  BuybackPolicy,
  BuybackAttempt,
  BuybackClaim,
  BuybackReceipt,
} from "./buyback-model.js";
export function buybackStore(url: string, policy: BuybackPolicy, schedule: "continuous" | "minute" = "continuous", pilot?: BuybackPilot) {
  if ((policy.purpose === "engineering") !== !!pilot || (pilot && buybackPolicyId(pilot.policy) !== buybackPolicyId(policy))) throw Error("Engineering policy requires matching pilot controls");
  const id = buybackPolicyId(policy),
    db = () =>
      neon(url, { fetchOptions: { signal: AbortSignal.timeout(8000) } });
  return {
    async recordNonlanding(a:BuybackAttempt,proof:BuybackNonlandingProof){
      validateBuybackNonlanding(a,proof);
      await verifyBuybackPlan(a.plan);
      if(buybackPolicyId(a.plan.policy)!==id||buybackId(a.plan)!==a.id)throw Error('Nonlanding policy changed');
      const sql=db();
      const rows=await sql`UPDATE fomo_buyback_attempts a SET state='failed',nonlanding_proof=${JSON.stringify(proof)}::jsonb,
        debit_lamports=0,burned_tokens=0,receipt=${JSON.stringify({kind:'not_landed',proof})}::jsonb,finalized_at=clock_timestamp()
        FROM fomo_buyback_treasuries t WHERE a.treasury=t.treasury AND t.treasury=${policy.treasury} AND t.policy_id=${id} AND NOT t.enabled
          AND (t.lease_until IS NULL OR t.lease_until<clock_timestamp()) AND a.state='pending' AND a.id=${a.id}
          AND a.signature=${a.signature} AND a.signed_transaction=${a.signed} AND a.plan=${JSON.stringify(a.plan)}::jsonb RETURNING a.id`;
      if(rows.length!==1)throw Error('Buyback journal changed or treasury is active');
    },
    async register() {
      const sql = db();
      const rows =
        await sql`INSERT INTO fomo_buyback_treasuries(treasury,policy_id,policy) VALUES(${policy.treasury},${id},${JSON.stringify(policy)}::jsonb) ON CONFLICT(treasury) DO UPDATE SET treasury=EXCLUDED.treasury WHERE fomo_buyback_treasuries.policy_id=EXCLUDED.policy_id RETURNING treasury`;
      if (rows.length !== 1)
        throw Error("An existing treasury has a different immutable policy");
    },
    // Explicit operator handoff, never an automatic retry. Only an accepted
    // curve case can advance once to a distinct, route-bound AMM case. It stays
    // disabled and retains every old reservation, debit and receipt.
    async transitionToGraduatedPilot(next: BuybackPilot) {
      const {purpose,...limits}=next.policy;
      const checked=buybackPilotPolicy(JSON.stringify({...limits,expiresAt:next.expiresAt}),policy.treasury);
      if (!pilot || policy.purpose!=='engineering' || policy.acceptanceRoute || purpose!=='engineering' || next.policy.acceptanceRoute!=='pump-amm' || next.policy.mint===policy.mint || next.expiresAt<=Date.now() || !checked || buybackPolicyId(checked.policy)!==buybackPolicyId(next.policy)) throw Error('Explicit accepted curve-to-AMM handoff required');
      const nextId=buybackPolicyId(next.policy),sql=db();
      const rows=await sql`WITH eligible AS MATERIALIZED (
        SELECT * FROM fomo_buyback_treasuries t WHERE t.treasury=${policy.treasury} AND t.policy_id=${id} AND NOT t.enabled
          AND (t.lease_until IS NULL OR t.lease_until<clock_timestamp())
          AND EXISTS(SELECT 1 FROM fomo_buyback_attempts a WHERE a.treasury=t.treasury AND a.state='confirmed' AND a.plan->'policy'=${JSON.stringify(policy)}::jsonb AND COALESCE(a.plan->>'route','pump-curve')='pump-curve')
          AND NOT EXISTS(SELECT 1 FROM fomo_buyback_attempts a WHERE a.treasury=t.treasury AND a.state='pending')
          AND NOT EXISTS(SELECT 1 FROM fomo_buyback_policy_history h WHERE h.treasury=t.treasury AND h.reason='curve_acceptance_to_graduated') FOR UPDATE
      ), history AS (
        INSERT INTO fomo_buyback_policy_history(id,treasury,previous_policy_id,previous_policy,next_policy_id,next_policy,reason)
        SELECT ${randomUUID()}::uuid,treasury,policy_id,policy,${nextId},${JSON.stringify(next.policy)}::jsonb,'curve_acceptance_to_graduated' FROM eligible RETURNING treasury
      ) UPDATE fomo_buyback_treasuries t SET policy_id=${nextId},policy=${JSON.stringify(next.policy)}::jsonb,enabled=false,outcome='paused',next_at=clock_timestamp()
        FROM history h WHERE t.treasury=h.treasury RETURNING t.treasury`;
      if(rows.length!==1)throw Error('Curve case is active, unresolved, unaccepted, or already handed off');
    },
    // Operator-only handoff after engineering settlement. Old attempts and their
    // actual debits remain in the same ledger. Never called by a public endpoint.
    async transitionToOfficial(next: BuybackPolicy) {
      const nextId=buybackPolicyId(next);
      if (!pilot || policy.purpose!=='engineering' || next.purpose!==undefined || next.treasury!==policy.treasury || next.mint===policy.mint) throw Error('Explicit engineering-to-official policy handoff required');
      const sql=db();
      const rows=await sql`WITH eligible AS MATERIALIZED (
        SELECT * FROM fomo_buyback_treasuries t WHERE t.treasury=${policy.treasury} AND t.policy_id=${id} AND NOT t.enabled
          AND (t.lease_until IS NULL OR t.lease_until<clock_timestamp())
          AND EXISTS(SELECT 1 FROM fomo_buyback_attempts a WHERE a.treasury=t.treasury AND a.state='confirmed' AND a.plan->'policy'=${JSON.stringify(policy)}::jsonb)
          AND NOT EXISTS(SELECT 1 FROM fomo_buyback_attempts a WHERE a.treasury=t.treasury AND a.state='pending') FOR UPDATE
      ), history AS (
        INSERT INTO fomo_buyback_policy_history(id,treasury,previous_policy_id,previous_policy,next_policy_id,next_policy,reason)
        SELECT ${randomUUID()}::uuid,treasury,policy_id,policy,${nextId},${JSON.stringify(next)}::jsonb,'engineering_acceptance_to_official' FROM eligible RETURNING treasury
      ) UPDATE fomo_buyback_treasuries t SET policy_id=${nextId},policy=${JSON.stringify(next)}::jsonb,enabled=false,outcome='paused',next_at=clock_timestamp()
        FROM history h WHERE t.treasury=h.treasury RETURNING t.treasury`;
      if(rows.length!==1)throw Error('Engineering policy is active, unresolved, unaccepted, or changed');
    },
    async claim(recoverOnly = false): Promise<BuybackClaim | null> {
      const sql = db(),
        lease = randomUUID();
      const rows =
        await sql`WITH owned AS (UPDATE fomo_buyback_treasuries SET lease_id=${lease}::uuid,lease_until=clock_timestamp()+interval '120 seconds' WHERE treasury=${policy.treasury} AND policy_id=${id} AND next_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<clock_timestamp()) AND ((enabled AND NOT ${recoverOnly} AND (${!pilot} OR (clock_timestamp()<to_timestamp(${pilot?.expiresAt??0}::double precision/1000) AND NOT EXISTS(SELECT 1 FROM fomo_buyback_attempts WHERE treasury=${policy.treasury} AND plan->'policy'=${JSON.stringify(policy)}::jsonb AND (id IS DISTINCT FROM ${pilot?.replacementOf??null} OR nonlanding_proof IS NULL))))) OR EXISTS(SELECT 1 FROM fomo_buyback_attempts WHERE treasury=${policy.treasury} AND state='pending')) RETURNING enabled), credits AS (SELECT COALESCE(sum(a.buyback_lamports),0) AS amount FROM fomo_launch_payout_attempts a JOIN fomo_launch_payouts p ON p.mint=a.mint WHERE a.state='confirmed' AND p.buyback_wallet=${policy.treasury} AND ((p.route_kind='launchpad' AND (p.mint<>${policy.mint} OR ${policy.purpose==='engineering'})) OR (p.route_kind='official' AND p.mint=${policy.mint} AND ${policy.purpose!=='engineering'}))), debits AS (SELECT COALESCE(sum(CASE WHEN state='pending' THEN reserved_lamports ELSE debit_lamports END),0) AS amount FROM fomo_buyback_attempts WHERE treasury=${policy.treasury}) SELECT o.enabled,GREATEST(0,c.amount-d.amount+COALESCE((SELECT credits-debits FROM fomo_quote_conversion_sol_accounting WHERE treasury=${policy.treasury}),0))::text AS available,(SELECT jsonb_build_object('id',a.id,'plan',a.plan,'signed',a.signed_transaction,'signature',a.signature) FROM fomo_buyback_attempts a WHERE treasury=${policy.treasury} AND state='pending') AS attempt FROM owned o CROSS JOIN credits c CROSS JOIN debits d`;
      return rows.length
        ? {
            lease,
            policy,
            enabled: rows[0].enabled,
            available: rows[0].available,
            attempt: rows[0].attempt,
          }
        : null;
    },
    async save(claim: BuybackClaim, a: BuybackAttempt) {
      if (
        buybackPolicyId(claim.policy) !== id ||
        buybackPolicyId(a.plan.policy) !== id ||
        buybackId(a.plan) !== a.id ||
        verifyBuybackSigned(a.plan, a.signed) !== a.signature
      )
        throw Error("Buyback does not match the treasury policy");
      await verifyBuybackPlan(a.plan);
      const reserve = buybackReservation(a.plan),
        sql = db();
      const [, rows] = await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${policy.treasury},3401))`,
        sql`INSERT INTO fomo_buyback_attempts(id,treasury,plan,signature,signed_transaction,reserved_lamports) SELECT ${a.id},${policy.treasury},${JSON.stringify(a.plan)}::jsonb,${a.signature},${a.signed},${reserve}::numeric FROM fomo_buyback_treasuries t WHERE t.treasury=${policy.treasury} AND t.policy_id=${id} AND t.enabled AND t.lease_id=${claim.lease}::uuid AND t.lease_until>clock_timestamp()
     AND (${!pilot} OR (clock_timestamp()<to_timestamp(${pilot?.expiresAt??0}::double precision/1000) AND NOT EXISTS(SELECT 1 FROM fomo_buyback_attempts WHERE treasury=t.treasury AND plan->'policy'=${JSON.stringify(policy)}::jsonb AND (id IS DISTINCT FROM ${pilot?.replacementOf??null} OR nonlanding_proof IS NULL))))
     AND NOT EXISTS(SELECT 1 FROM fomo_buyback_attempts WHERE treasury=t.treasury AND state='pending')
     AND COALESCE((SELECT sum(a.buyback_lamports) FROM fomo_launch_payout_attempts a JOIN fomo_launch_payouts p ON p.mint=a.mint WHERE a.state='confirmed' AND p.buyback_wallet=t.treasury AND ((p.route_kind='launchpad' AND (p.mint<>${policy.mint} OR ${policy.purpose==='engineering'})) OR (p.route_kind='official' AND p.mint=${policy.mint} AND ${policy.purpose!=='engineering'}))),0)
      + COALESCE((SELECT credits-debits FROM fomo_quote_conversion_sol_accounting WHERE treasury=t.treasury),0)
      - COALESCE((SELECT sum(CASE WHEN state='pending' THEN reserved_lamports ELSE debit_lamports END) FROM fomo_buyback_attempts WHERE treasury=t.treasury),0)>=${reserve}::numeric
     AND (${policy.revenueReserve!==undefined} OR COALESCE((SELECT sum(CASE WHEN state='pending' THEN reserved_lamports ELSE debit_lamports END) FROM fomo_buyback_attempts WHERE treasury=t.treasury AND (state='pending' OR created_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' OR finalized_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')),0)+${reserve}::numeric<=${policy.dailyCap}::numeric)
     ON CONFLICT DO NOTHING RETURNING id`,
      ]);
      return rows.length === 1;
    },
    async maySend(claim: BuybackClaim, a: BuybackAttempt) {
      const sql = db();
      const rows =
        await sql`SELECT 1 FROM fomo_buyback_treasuries t JOIN fomo_buyback_attempts a ON a.treasury=t.treasury WHERE t.treasury=${policy.treasury} AND t.policy_id=${id} AND t.enabled AND t.lease_id=${claim.lease}::uuid AND t.lease_until>clock_timestamp() AND (${!pilot} OR clock_timestamp()<to_timestamp(${pilot?.expiresAt??0}::double precision/1000)) AND a.id=${a.id} AND a.signature=${a.signature} AND a.state='pending'`;
      return rows.length === 1;
    },
    async settle(claim: BuybackClaim, a: BuybackAttempt, r: BuybackReceipt) {
      if (
        typeof r.success !== "boolean" ||
        (r.success && rawLamports(r.debit) <= rawLamports(r.networkFee)) ||
        buybackPolicyId(claim.policy) !== id ||
        buybackPolicyId(a.plan.policy) !== id ||
        a.id !== buybackId(a.plan) ||
        verifyBuybackSigned(a.plan, a.signed) !== a.signature ||
        !Number.isSafeInteger(r.slot) ||
        r.slot < a.plan.contextSlot ||
        rawLamports(r.debit) < rawLamports(r.networkFee) ||
        rawLamports(r.networkFee) > rawLamports(a.plan.fee) ||
        rawLamports(r.debit) > rawLamports(buybackReservation(a.plan)) ||
        r.burned !== (r.success ? a.plan.tokens : "0") ||
        (!r.success && r.debit !== r.networkFee)
      )
        throw Error("Invalid buyback settlement");
      const sql = db(),
        rows =
          await sql`WITH settled AS (UPDATE fomo_buyback_attempts a SET state=${r.success ? "confirmed" : "failed"},receipt=${JSON.stringify(r)}::jsonb,debit_lamports=${r.debit}::numeric,burned_tokens=${r.burned}::numeric,finalized_at=clock_timestamp() FROM fomo_buyback_treasuries t WHERE a.id=${a.id} AND a.signature=${a.signature} AND a.treasury=t.treasury AND t.treasury=${policy.treasury} AND t.policy_id=${id} AND t.lease_id=${claim.lease}::uuid AND t.lease_until>clock_timestamp() AND a.state='pending' RETURNING a.id,a.treasury) UPDATE fomo_buyback_treasuries t SET enabled=CASE WHEN ${!!pilot} THEN false ELSE t.enabled END FROM settled a WHERE t.treasury=a.treasury RETURNING a.id`;
      if (rows.length !== 1) throw Error("Buyback settlement lease lost");
    },
    async complete(claim: BuybackClaim, outcome: string) {
      const sql = db();
      await sql`UPDATE fomo_buyback_treasuries SET lease_id=NULL,lease_until=NULL,last_checked_at=clock_timestamp(),next_at=(CASE WHEN ${schedule === "minute"} THEN date_trunc('minute',clock_timestamp()) ELSE clock_timestamp() END)+interval '60 seconds',outcome=${outcome} WHERE treasury=${policy.treasury} AND policy_id=${id} AND lease_id=${claim.lease}::uuid AND lease_until>clock_timestamp()`;
    },
    async health() {
      const sql = db();
      const rows =
        await sql`SELECT t.enabled,t.outcome,t.last_checked_at,(SELECT count(*)::integer FROM fomo_buyback_attempts a WHERE a.treasury=t.treasury AND state='pending' AND created_at<clock_timestamp()-interval '3 minutes') AS unresolved FROM fomo_buyback_treasuries t WHERE treasury=${policy.treasury} AND policy_id=${id}`;
      if (!rows.length) throw Error("Treasury not registered");
      return rows[0];
    },
  };
}
