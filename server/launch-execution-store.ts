import {rawLamports} from './launch-payout-model.js';
import {validateLaunchNonlanding,type LaunchNonlandingProof} from './launch-expiry.js';
import { neon } from '@neondatabase/serverless';
import { randomUUID } from 'node:crypto';
import { launchPlanHash, launchPacket, validateLaunchPlan, validateLaunchExpiry, verifyLaunchSigned } from './launch-execution-model.js';
import type { LaunchExecution, LaunchExecutionPlan, LaunchExecutionReceipt, LaunchExpiryProof } from './launch-execution-model.js';
function parse(r:any):LaunchExecution|null{
 if(!r)return null;validateLaunchPlan(r.plan);
 if(launchPlanHash(r.plan)!==r.id||r.owner!==r.plan.publication.owner||r.mint!==r.plan.mint||r.publication_id!==r.plan.publication.id)throw Error('Stored launch integrity mismatch.');
 if(r.signed_transaction&&verifyLaunchSigned(r.plan,r.signed_transaction)!==r.signature)throw Error('Stored signature mismatch.');
 if(r.nonlanding_proof)validateLaunchNonlanding(r.plan,r.signature,r.nonlanding_proof);
 return {...(r.nonlanding_proof?{nonlandingProof:r.nonlanding_proof}:{}),id:r.id,plan:r.plan,state:r.state,signed:r.signed_transaction,signature:r.signature,receipt:r.receipt};
}
export function launchExecutionStore(url:string){
 const db=()=>neon(url,{fetchOptions:{signal:AbortSignal.timeout(8000)}});
 return {
  async save(plan:LaunchExecutionPlan){
   validateLaunchPlan(plan);const id=launchPlanHash(plan),sql=db();
   await sql`INSERT INTO fomo_launch_executions(id,publication_id,owner,mint,plan)
     SELECT ${id},p.id,p.owner,${plan.mint},${JSON.stringify(plan)}::jsonb FROM fomo_launch_publications p
     WHERE p.id=${plan.publication.id} AND p.owner=${plan.publication.owner} AND p.data=${JSON.stringify(plan.publication)}::jsonb
     ON CONFLICT DO NOTHING`;
   const rows=await sql`SELECT * FROM fomo_launch_executions WHERE publication_id=${plan.publication.id} AND owner=${plan.publication.owner} AND state<>'superseded'`;
   const saved=parse(rows[0]);if(!saved||saved.id!==id)throw Error('This publication already has another launch attempt. Recover it before preparing another.');return saved;
  },
  async refresh(previousId:string,plan:LaunchExecutionPlan,proof:LaunchExpiryProof){
   validateLaunchPlan(plan);const previous=await this.get(previousId,plan.publication.owner);
   if(!previous||previous.plan.publication.id!==plan.publication.id)throw Error('Previous launch does not belong to this publication.');
   const id=launchPlanHash(plan);
   if(id===previousId||launchPacket(plan.unsigned).message.recentBlockhash===launchPacket(previous.plan.unsigned).message.recentBlockhash)throw Error('A refreshed transaction must have a new blockhash and review.');
   if(previous.state==='superseded'){
    const rows=await db()`SELECT * FROM fomo_launch_executions WHERE id=${id} AND replaces_id=${previousId}`;
    const saved=parse(rows[0]);if(saved)return saved;throw Error('This launch was already refreshed. Reload its current attempt.');
   }
   if(!((previous.state==='prepared'&&!previous.signed&&!previous.signature)||(previous.state==='expired_unresolved'&&previous.nonlandingProof)))throw Error('A signed or unresolved launch cannot be replaced.');
   validateLaunchExpiry(previous.plan,proof);
   if(plan.lastValidBlockHeight<=proof.blockHeight||plan.contextSlot<proof.slot)throw Error('The replacement predates the finalized expiry check.');
   const sql=db();
   // The state change and replacement insert are one statement. A concurrent
   // signature bind wins or loses the same row lock; it cannot be discarded.
   const rows=await sql`WITH retired AS (
     UPDATE fomo_launch_executions e SET state='superseded',updated_at=clock_timestamp()
     WHERE e.id=${previousId} AND e.owner=${plan.publication.owner} AND ((e.state='prepared' AND e.signed_transaction IS NULL AND e.signature IS NULL) OR (e.state='expired_unresolved' AND e.nonlanding_proof IS NOT NULL))
       AND (e.lease_until IS NULL OR e.lease_until<clock_timestamp())
       AND EXISTS(SELECT 1 FROM fomo_launch_publications p WHERE p.id=e.publication_id AND p.data=${JSON.stringify(plan.publication)}::jsonb)
     RETURNING e.id,e.publication_id,e.owner
    ) INSERT INTO fomo_launch_executions(id,publication_id,owner,mint,plan,replaces_id,expiry_proof)
      SELECT ${id},publication_id,owner,${plan.mint},${JSON.stringify(plan)}::jsonb,id,${JSON.stringify(proof)}::jsonb FROM retired RETURNING *`;
   const saved=parse(rows[0]);if(!saved)throw Error('Launch changed while refreshing. Reload its current attempt.');return saved;
  },
  async get(id:string,owner:string){const rows=await db()`SELECT * FROM fomo_launch_executions WHERE id=${id} AND owner=${owner}`;return parse(rows[0]);},
  async forPublication(id:string,owner:string){const rows=await db()`SELECT * FROM fomo_launch_executions WHERE publication_id=${id} AND owner=${owner} AND state<>'superseded'`;return parse(rows[0]);},
  async list(owner:string){const rows=await db()`SELECT * FROM fomo_launch_executions WHERE owner=${owner} ORDER BY created_at DESC LIMIT 25`;return rows.map(parse) as LaunchExecution[];},
  async bind(id:string,owner:string,signed:string){
   const previous=await this.get(id,owner);if(!previous)throw Error('Launch not found.');const signature=verifyLaunchSigned(previous.plan,signed),sql=db();
   await sql`UPDATE fomo_launch_executions SET signed_transaction=${signed},signature=${signature},state='pending',updated_at=clock_timestamp()
     WHERE id=${id} AND owner=${owner} AND state='prepared' AND signed_transaction IS NULL`;
   const saved=await this.get(id,owner);if(!saved||saved.signature!==signature||saved.signed!==signed)throw Error('A different signed launch is already saved.');return saved;
  },
  async claim(id:string,owner:string){
   const lease=randomUUID(),rows=await db()`UPDATE fomo_launch_executions SET lease_token=${lease}::uuid,lease_until=clock_timestamp()+interval '120 seconds'
     WHERE id=${id} AND owner=${owner} AND state IN('pending','expired_unresolved') AND (lease_until IS NULL OR lease_until<clock_timestamp()) RETURNING *`;
   const attempt=parse(rows[0]);return attempt?{attempt,lease}:null;
  },
  async submitted(id:string,lease:string){
   const rows=await db()`UPDATE fomo_launch_executions SET submitted_at=COALESCE(submitted_at,clock_timestamp()),updated_at=clock_timestamp()
     WHERE id=${id} AND lease_token=${lease}::uuid AND lease_until>clock_timestamp() AND state='pending' RETURNING id`;
   if(rows.length!==1)throw Error('Launch submission lease lost.');
  },
  async settle(id:string,lease:string,outcome:{kind:'confirmed';receipt:LaunchExecutionReceipt}|{kind:'failed'|'pending'|'expired_unresolved';nonlandingProof?:LaunchNonlandingProof}){
   const sql=db();
   if('nonlandingProof' in outcome&&outcome.nonlandingProof){const prior=await sql`SELECT * FROM fomo_launch_executions WHERE id=${id}`;const a=parse(prior[0]);if(!a||!a.signature||outcome.kind!=='expired_unresolved')throw Error('Invalid nonlanding state');validateLaunchNonlanding(a.plan,a.signature,outcome.nonlandingProof);}
   if(outcome.kind==='confirmed'){
    const stored=parse((await sql`SELECT * FROM fomo_launch_executions WHERE id=${id}`)[0]);
    if(!stored)throw Error('Launch not found.');
    const q=stored.plan.quoteSpend,r=outcome.receipt;
    if(q){
     if(!r.quoteDebit||r.quoteDebit.mint!==q.mint||r.quoteDebit.tokenProgram!==q.tokenProgram||r.quoteDebit.decimals!==q.decimals||rawLamports(r.quoteDebit.raw)>rawLamports(q.maxRaw)||(rawLamports(q.maxRaw)>0n&&rawLamports(r.quoteDebit.raw)===0n))throw Error('Finalized quote debit differs from review.');
     // Confirmed launches join the recurring payout queue automatically. The
     // worker's verified execution gate still applies. Conflicts never resume
     // a route that an operator has paused.
     const rows=await sql`WITH locked AS MATERIALIZED (
      SELECT * FROM fomo_launch_executions WHERE id=${id} AND lease_token=${lease}::uuid AND lease_until>clock_timestamp() AND state IN('pending','expired_unresolved') FOR UPDATE
     ),route AS (
      INSERT INTO fomo_quote_fee_routes(mint,recipient,buyback_wallet,quote_mint,token_program,decimals,enabled)
      SELECT mint,plan->'publication'->>'recipient',plan->>'buybackWallet',plan->'quoteSpend'->>'mint',plan->'quoteSpend'->>'tokenProgram',(plan->'quoteSpend'->>'decimals')::integer,true FROM locked
      WHERE signature=${r.signature} AND mint=${r.mint} AND owner=${r.owner} AND plan->'publication'->>'recipient'=${r.recipient} AND plan->>'buybackWallet'=${r.buybackWallet}
       AND NOT EXISTS(SELECT 1 FROM fomo_launch_payouts p WHERE p.mint=locked.mint)
      ON CONFLICT(mint) DO UPDATE SET mint=EXCLUDED.mint
      WHERE fomo_quote_fee_routes.recipient=EXCLUDED.recipient AND fomo_quote_fee_routes.buyback_wallet=EXCLUDED.buyback_wallet
       AND fomo_quote_fee_routes.quote_mint=EXCLUDED.quote_mint AND fomo_quote_fee_routes.token_program=EXCLUDED.token_program AND fomo_quote_fee_routes.decimals=EXCLUDED.decimals RETURNING mint
     ) UPDATE fomo_launch_executions e SET state='confirmed',receipt=${JSON.stringify(r)}::jsonb,checked_at=clock_timestamp(),updated_at=clock_timestamp()
      FROM locked l,route r WHERE e.id=l.id AND e.mint=r.mint RETURNING e.id`;
     if(rows.length!==1)throw Error('Finalized quote launch or payout registration mismatch.');
     return;
    }
    if(r.quoteDebit)throw Error('Native launch cannot credit pair tokens.');
    // Finalized state and payout registration commit atomically. Registration is
    // uses the recurring-payout default for ordinary finalized launches.
    const rows=await sql`WITH locked AS MATERIALIZED (
      SELECT * FROM fomo_launch_executions WHERE id=${id} AND lease_token=${lease}::uuid AND lease_until>clock_timestamp() AND state IN('pending','expired_unresolved') FOR UPDATE
    ), route AS (
      INSERT INTO fomo_launch_payouts(mint,recipient,buyback_wallet)
      SELECT mint,plan->'publication'->>'recipient',plan->>'buybackWallet' FROM locked
      WHERE signature=${outcome.receipt.signature} AND mint=${outcome.receipt.mint} AND owner=${outcome.receipt.owner}
        AND plan->'publication'->>'recipient'=${outcome.receipt.recipient} AND plan->>'buybackWallet'=${outcome.receipt.buybackWallet}
      ON CONFLICT(mint) DO UPDATE SET mint=EXCLUDED.mint
      WHERE fomo_launch_payouts.recipient=EXCLUDED.recipient AND fomo_launch_payouts.buyback_wallet=EXCLUDED.buyback_wallet RETURNING mint
    ) UPDATE fomo_launch_executions e SET state='confirmed',receipt=${JSON.stringify(outcome.receipt)}::jsonb,checked_at=clock_timestamp(),updated_at=clock_timestamp()
      FROM locked l,route r WHERE e.id=l.id AND e.mint=r.mint RETURNING e.id`;
    if(rows.length!==1)throw Error('Finalized launch or payout registration mismatch.');
   }else{
    const rows=await sql`UPDATE fomo_launch_executions SET state=${outcome.kind},nonlanding_proof=COALESCE(${outcome.nonlandingProof?JSON.stringify(outcome.nonlandingProof):null}::jsonb,nonlanding_proof),checked_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE id=${id} AND lease_token=${lease}::uuid AND lease_until>clock_timestamp() AND state IN('pending','expired_unresolved') RETURNING id`;
    if(rows.length!==1)throw Error('Launch settlement lease lost.');
   }
  },
  async failedCheck(id:string,lease:string){
   // Keep the signed evidence/state intact, but rotate failed checks behind
   // other due attempts instead of letting a bad oldest row starve the queue.
   await db()`UPDATE fomo_launch_executions SET checked_at=clock_timestamp()
     WHERE id=${id} AND lease_token=${lease}::uuid AND lease_until>clock_timestamp() AND state IN('pending','expired_unresolved')`;
  },
  async release(id:string,lease:string){await db()`UPDATE fomo_launch_executions SET lease_until=clock_timestamp() WHERE id=${id} AND lease_token=${lease}::uuid`;},
  async due(){const rows=await db()`SELECT id,owner FROM fomo_launch_executions WHERE state IN('pending','expired_unresolved') AND (checked_at IS NULL OR checked_at<clock_timestamp()-interval '60 seconds') AND (lease_until IS NULL OR lease_until<clock_timestamp()) ORDER BY checked_at NULLS FIRST,created_at LIMIT 10`;return rows as {id:string;owner:string}[];},
 };
}
export type LaunchExecutionStore=ReturnType<typeof launchExecutionStore>;
