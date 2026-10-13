import {randomUUID} from 'node:crypto';
import {neon} from '@neondatabase/serverless';
import {rawLamports} from './launch-payout-model.js';
import {conversionPolicyId,verifyConversionPlan,verifyConversionSignature,type ConversionPolicy,type ConversionPlan,type ConversionAttempt,type ConversionReceipt} from './quote-conversion-chain.js';
import type {QuoteFeeAsset} from './launch-quote-fees.js';
export type ConversionClaim={lease:string;policy:ConversionPolicy;enabled:boolean;asset:QuoteFeeAsset|null;available:string;attempt:ConversionAttempt|null};
export const conversionReservation=(p:ConversionPlan)=>String(rawLamports(p.feeLamports)+rawLamports(p.rentCapLamports)+rawLamports(p.temporaryRentLamports));
export function quoteConversionStore(url:string,policy:ConversionPolicy,onlyQuoteMint?:string){
 const id=conversionPolicyId(policy),db=()=>neon(url,{fetchOptions:{signal:AbortSignal.timeout(8000)}});
 function identity(c:ConversionClaim,a:ConversionAttempt){
  if(conversionPolicyId(c.policy)!==id||conversionPolicyId(a.plan.policy)!==id||verifyConversionSignature(a)!==a.signature||!c.asset||c.asset.mint!==a.plan.asset.mint||c.asset.tokenProgram!==a.plan.asset.tokenProgram||c.asset.decimals!==a.plan.asset.decimals)throw Error('Conversion policy or asset changed.');
 }
 return{
  async register(){
   const rows=await db()`INSERT INTO fomo_quote_conversion_policies(treasury,policy_id,policy) VALUES(${policy.treasury},${id},${JSON.stringify(policy)}::jsonb)
    ON CONFLICT(treasury) DO UPDATE SET treasury=EXCLUDED.treasury WHERE fomo_quote_conversion_policies.policy_id=EXCLUDED.policy_id RETURNING treasury`;
   if(rows.length!==1)throw Error('Conversion policy is immutable.');
  },
  async claim(recoveryOnly=false):Promise<ConversionClaim|null>{
   const lease=randomUUID(),rows=await db()`WITH owned AS(
    UPDATE fomo_quote_conversion_policies p SET lease_id=${lease}::uuid,lease_until=clock_timestamp()+interval '120 seconds'
     WHERE treasury=${policy.treasury} AND policy_id=${id} AND next_at<=clock_timestamp() AND(lease_until IS NULL OR lease_until<clock_timestamp())
      AND((enabled AND NOT ${recoveryOnly}) OR EXISTS(SELECT 1 FROM fomo_quote_conversion_attempts a WHERE a.treasury=p.treasury AND a.state='pending')) RETURNING p.*
   ), inventory AS(
    SELECT c.quote_mint,c.token_program,c.decimals,sum(c.raw_amount)-COALESCE((SELECT sum(a.input_raw) FROM fomo_quote_conversion_attempts a
     WHERE a.treasury=c.treasury AND a.quote_mint=c.quote_mint AND a.token_program=c.token_program AND a.decimals=c.decimals AND a.state IN('pending','confirmed')),0) AS available
    FROM fomo_quote_treasury_credits c JOIN fomo_quote_fee_attempts f ON f.id=c.attempt_id AND f.state='confirmed'
    WHERE c.treasury=${policy.treasury} AND (${onlyQuoteMint??null}::text IS NULL OR c.quote_mint=${onlyQuoteMint??null}) GROUP BY c.treasury,c.quote_mint,c.token_program,c.decimals
   ) SELECT o.enabled,a.id,a.plan,a.signature,a.signed_transaction,
    COALESCE(a.quote_mint,i.quote_mint) AS quote_mint,COALESCE(a.token_program,i.token_program) AS token_program,COALESCE(a.decimals,i.decimals) AS decimals,
    LEAST(COALESCE(i.available,0),18446744073709551615)::text AS available
    FROM owned o LEFT JOIN fomo_quote_conversion_attempts a ON a.treasury=o.treasury AND a.state='pending'
    LEFT JOIN LATERAL(SELECT * FROM inventory WHERE available>0 ORDER BY CASE WHEN quote_mint>COALESCE(o.last_asset,'') THEN 0 ELSE 1 END,quote_mint LIMIT 1)i ON a.id IS NULL`;
   const r=rows[0];if(!r)return null;
   const c:ConversionClaim={lease,policy,enabled:r.enabled,asset:r.quote_mint?{mint:r.quote_mint,tokenProgram:r.token_program,decimals:r.decimals}:null,available:r.available,attempt:r.id?{id:r.id,plan:r.plan,signature:r.signature,signed:r.signed_transaction}:null};
   if(c.attempt){identity(c,c.attempt);await verifyConversionPlan(c.attempt.plan);}return c;
  },
  async save(c:ConversionClaim,a:ConversionAttempt){
   identity(c,a);await verifyConversionPlan(a.plan);
   if(Date.now()-a.plan.preparedAt>30000||a.plan.preparedAt>Date.now()+1000)throw Error('Conversion preparation expired.');
   const sql=db(),p=a.plan,reserve=conversionReservation(p);
   // The same lock as buyback reservations prevents two workers spending the
   // same native proceeds, including during a lost-response recovery.
   const [,rows]=await sql.transaction([
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${policy.treasury},3401))`,
    sql`INSERT INTO fomo_quote_conversion_attempts(id,treasury,quote_mint,token_program,decimals,input_raw,plan,signed_transaction,signature,reserved_lamports)
     SELECT ${a.id}::uuid,t.treasury,${p.asset.mint},${p.asset.tokenProgram},${p.asset.decimals},${p.inputRaw}::numeric,${JSON.stringify(p)}::jsonb,${a.signed},${a.signature},${reserve}::numeric
     FROM fomo_quote_conversion_policies t WHERE t.treasury=${policy.treasury} AND t.policy_id=${id} AND t.enabled AND t.lease_id=${c.lease}::uuid AND t.lease_until>clock_timestamp()
      AND NOT EXISTS(SELECT 1 FROM fomo_quote_conversion_attempts a WHERE a.treasury=t.treasury AND a.state='pending')
      AND COALESCE((SELECT sum(c.raw_amount) FROM fomo_quote_treasury_credits c JOIN fomo_quote_fee_attempts f ON f.id=c.attempt_id AND f.state='confirmed'
       WHERE c.treasury=t.treasury AND c.quote_mint=${p.asset.mint} AND c.token_program=${p.asset.tokenProgram} AND c.decimals=${p.asset.decimals}),0)
       -COALESCE((SELECT sum(a.input_raw) FROM fomo_quote_conversion_attempts a WHERE a.treasury=t.treasury AND a.quote_mint=${p.asset.mint} AND a.token_program=${p.asset.tokenProgram} AND a.decimals=${p.asset.decimals} AND a.state IN('pending','confirmed')),0)>=${p.inputRaw}::numeric
      AND COALESCE((SELECT sum(a.buyback_lamports) FROM fomo_launch_payout_attempts a JOIN fomo_launch_payouts p ON p.mint=a.mint WHERE a.state='confirmed' AND p.buyback_wallet=t.treasury),0)
       +COALESCE((SELECT credits-debits FROM fomo_quote_conversion_sol_accounting WHERE treasury=t.treasury),0)
       -COALESCE((SELECT sum(CASE WHEN state='pending' THEN reserved_lamports ELSE debit_lamports END) FROM fomo_buyback_attempts WHERE treasury=t.treasury),0)>=${reserve}::numeric
      AND COALESCE((SELECT sum(reserved_lamports) FROM fomo_quote_conversion_attempts a WHERE a.treasury=t.treasury
       AND(state='pending' OR created_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' OR finalized_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')),0)+${reserve}::numeric<=${policy.dailyFeeCapLamports}::numeric
     ON CONFLICT DO NOTHING RETURNING id`
   ]);return rows.length===1;
  },
  async maySend(c:ConversionClaim,a:ConversionAttempt){
   identity(c,a);const rows=await db()`SELECT 1 FROM fomo_quote_conversion_policies t JOIN fomo_quote_conversion_attempts a ON a.treasury=t.treasury
    WHERE t.treasury=${policy.treasury} AND t.policy_id=${id} AND t.enabled AND t.lease_id=${c.lease}::uuid AND t.lease_until>clock_timestamp()
     AND a.id=${a.id}::uuid AND a.state='pending' AND a.signature=${a.signature} AND a.signed_transaction=${a.signed} AND a.plan=${JSON.stringify(a.plan)}::jsonb`;
   return rows.length===1;
  },
  async settle(c:ConversionClaim,a:ConversionAttempt,r:ConversionReceipt){
   identity(c,a);await verifyConversionPlan(a.plan);
   if(typeof r.success!=='boolean'||!Number.isSafeInteger(r.slot)||r.slot<a.plan.contextSlot||r.feeLamports!==a.plan.feeLamports||rawLamports(r.rentLamports)>rawLamports(a.plan.rentCapLamports)||r.inputRaw!==(r.success?a.plan.inputRaw:'0')||
    (r.success?(rawLamports(r.netSolLamports)===0n||rawLamports(r.netSolLamports)+rawLamports(r.feeLamports)+rawLamports(r.rentLamports)<rawLamports(a.plan.minimumOutputRaw)):(r.netSolLamports!=='0'||r.rentLamports!=='0')))throw Error('Invalid conversion settlement.');
   const rows=await db()`WITH settled AS(
    UPDATE fomo_quote_conversion_attempts a SET state=${r.success?'confirmed':'failed'},receipt=${JSON.stringify(r)}::jsonb,
     fee_lamports=${r.feeLamports}::numeric,rent_lamports=${r.rentLamports}::numeric,net_sol_lamports=${r.netSolLamports}::numeric,finalized_at=clock_timestamp()
     FROM fomo_quote_conversion_policies t WHERE a.treasury=t.treasury AND t.treasury=${policy.treasury} AND t.policy_id=${id}
      AND t.lease_id=${c.lease}::uuid AND t.lease_until>clock_timestamp() AND a.id=${a.id}::uuid AND a.state='pending' AND a.signature=${a.signature} AND a.signed_transaction=${a.signed} AND a.plan=${JSON.stringify(a.plan)}::jsonb RETURNING a.id,a.treasury
   ),credited AS(
    INSERT INTO fomo_quote_conversion_credits(attempt_id,treasury,lamports) SELECT id,treasury,${r.netSolLamports}::numeric FROM settled WHERE ${r.success} RETURNING attempt_id
   ) SELECT id FROM settled`;
   if(rows.length!==1)throw Error('Conversion settlement lease lost.');
  },
  async complete(c:ConversionClaim,outcome:string){
   await db()`UPDATE fomo_quote_conversion_policies SET lease_id=NULL,lease_until=NULL,last_checked_at=clock_timestamp(),last_asset=${c.asset?.mint??null},outcome=${outcome},next_at=clock_timestamp()+interval '60 seconds'
    WHERE treasury=${policy.treasury} AND policy_id=${id} AND lease_id=${c.lease}::uuid AND lease_until>clock_timestamp()`;
  },
  async health(){
   const rows=await db()`SELECT t.enabled,t.outcome,t.last_checked_at,
    (SELECT count(*)::integer FROM fomo_quote_conversion_attempts a WHERE a.treasury=t.treasury AND a.state='pending' AND a.created_at<clock_timestamp()-interval '3 minutes') AS unresolved
    FROM fomo_quote_conversion_policies t WHERE treasury=${policy.treasury} AND policy_id=${id}`;
   if(rows.length!==1)throw Error('Conversion policy not registered.');return rows[0];
  }
 };
}
export type QuoteConversionStore=ReturnType<typeof quoteConversionStore>;
