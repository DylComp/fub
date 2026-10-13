import {randomUUID} from 'node:crypto';
import {neon} from '@neondatabase/serverless';
import {rawLamports,validatePayoutAmounts,verifyPayoutSignature,type PayoutOutcome} from './launch-payout-model.js';
import {validateQuoteFeeRoute,verifyQuoteFeePlan,type QuoteFeeRoute,type QuoteFeeAttempt,type QuoteFeeReceipt} from './launch-quote-fees.js';
export type QuoteFeeClaim=QuoteFeeRoute&{lease:string;enabled:boolean;attempt:QuoteFeeAttempt|null};
export function launchQuoteStore(url:string,onlyQuoteMint?:string){
 const db=()=>neon(url,{fetchOptions:{signal:AbortSignal.timeout(8000)}});
 return{
  async register(route:QuoteFeeRoute){
   validateQuoteFeeRoute(route);const sql=db(),a=route.asset;
   const rows=await sql`INSERT INTO fomo_quote_fee_routes(mint,recipient,buyback_wallet,quote_mint,token_program,decimals)
    VALUES(${route.mint},${route.recipient},${route.buybackWallet},${a.mint},${a.tokenProgram},${a.decimals})
    ON CONFLICT(mint) DO UPDATE SET mint=EXCLUDED.mint
    WHERE fomo_quote_fee_routes.recipient=EXCLUDED.recipient AND fomo_quote_fee_routes.buyback_wallet=EXCLUDED.buyback_wallet
     AND fomo_quote_fee_routes.quote_mint=EXCLUDED.quote_mint AND fomo_quote_fee_routes.token_program=EXCLUDED.token_program AND fomo_quote_fee_routes.decimals=EXCLUDED.decimals RETURNING mint`;
   if(rows.length!==1)throw Error('Quote route identity cannot change.');
  },
  async claim(recoveryOnly=false):Promise<QuoteFeeClaim|null>{
   const lease=randomUUID(),rows=await db()`WITH due AS(
    SELECT p.mint FROM fomo_quote_fee_routes p WHERE p.next_run_at<=clock_timestamp()
     AND ((p.enabled AND NOT ${recoveryOnly} AND (${onlyQuoteMint??null}::text IS NULL OR p.quote_mint=${onlyQuoteMint??null})) OR EXISTS(SELECT 1 FROM fomo_quote_fee_attempts a WHERE a.mint=p.mint AND a.state='pending'))
     AND(p.lease_until IS NULL OR p.lease_until<clock_timestamp())
     ORDER BY p.next_run_at,p.mint FOR UPDATE OF p SKIP LOCKED LIMIT 1
   ),claimed AS(
    UPDATE fomo_quote_fee_routes p SET lease_id=${lease}::uuid,lease_until=clock_timestamp()+interval '60 seconds' FROM due WHERE p.mint=due.mint RETURNING p.*
   ) SELECT p.*,a.id,a.payer,a.signature,a.plan,a.signed_transaction FROM claimed p LEFT JOIN fomo_quote_fee_attempts a ON a.mint=p.mint AND a.state='pending'`;
   const r=rows[0];if(!r)return null;
   const claim:QuoteFeeClaim={mint:r.mint,recipient:r.recipient,buybackWallet:r.buyback_wallet,asset:{mint:r.quote_mint,tokenProgram:r.token_program,decimals:r.decimals},lease,enabled:r.enabled,attempt:r.id?{...r.plan,id:r.id,payer:r.payer,signature:r.signature,signed:r.signed_transaction}:null};
   validateQuoteFeeRoute(claim);
   if(claim.attempt){await verifyQuoteFeePlan(claim,claim.attempt.payer,claim.attempt);if(verifyPayoutSignature(claim.attempt,claim.attempt.signed,claim.attempt.payer)!==claim.attempt.signature)throw Error('Stored quote-fee signature mismatch.');}
   return claim;
  },
  async save(c:QuoteFeeClaim,a:QuoteFeeAttempt,dailyCap:string){
   await verifyQuoteFeePlan(c,a.payer,a);
   if(verifyPayoutSignature(a,a.signed,a.payer)!==a.signature||rawLamports(dailyCap)<rawLamports(a.feeLamports))throw Error('Invalid quote-fee budget or signature.');
   const {id,payer,signature,signed,...plan}=a,sql=db();
   // Both native and quote payouts share the payer lock and SOL gas budget.
   const [,rows]=await sql.transaction([
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`launch-payout:${payer}`},0))`,
    sql`INSERT INTO fomo_quote_fee_attempts(id,mint,payer,signature,plan,signed_transaction,reserved_fee_lamports)
     SELECT ${id}::uuid,p.mint,${payer},${signature},${JSON.stringify(plan)}::jsonb,${signed},${a.feeLamports}::bigint
     FROM fomo_quote_fee_routes p WHERE p.mint=${c.mint} AND p.recipient=${c.recipient} AND p.buyback_wallet=${c.buybackWallet}
      AND p.quote_mint=${c.asset.mint} AND p.token_program=${c.asset.tokenProgram} AND p.decimals=${c.asset.decimals}
      AND p.enabled AND p.lease_id=${c.lease}::uuid AND p.lease_until>clock_timestamp()
      AND COALESCE((SELECT sum(reserved_fee_lamports) FROM fomo_quote_fee_attempts WHERE payer=${payer} AND budget_day=(clock_timestamp() AT TIME ZONE 'UTC')::date),0)
       +COALESCE((SELECT sum(reserved_fee_lamports) FROM fomo_launch_payout_attempts WHERE payer=${payer} AND nonlanding_proof IS NULL AND budget_day=(clock_timestamp() AT TIME ZONE 'UTC')::date),0)
       +${a.feeLamports}::bigint<=${dailyCap}::numeric
     ON CONFLICT DO NOTHING RETURNING id`
   ]);return rows.length===1;
  },
  async maySend(c:QuoteFeeClaim,a:QuoteFeeAttempt){
   const rows=await db()`SELECT 1 FROM fomo_quote_fee_routes p JOIN fomo_quote_fee_attempts a ON a.mint=p.mint
    WHERE p.mint=${c.mint} AND p.enabled AND p.lease_id=${c.lease}::uuid AND p.lease_until>clock_timestamp()
     AND p.recipient=${c.recipient} AND p.buyback_wallet=${c.buybackWallet} AND p.quote_mint=${c.asset.mint} AND p.token_program=${c.asset.tokenProgram} AND p.decimals=${c.asset.decimals}
     AND a.id=${a.id}::uuid AND a.state='pending' AND a.signature=${a.signature} AND a.signed_transaction=${a.signed}`;
   return rows.length===1;
  },
  async settle(c:QuoteFeeClaim,a:QuoteFeeAttempt,r:QuoteFeeReceipt|null){
   await verifyQuoteFeePlan(c,a.payer,a);
   if(r){
    if(!Number.isSafeInteger(r.slot)||r.slot<a.contextSlot||r.networkFeeLamports!==a.feeLamports||r.asset.mint!==c.asset.mint||r.asset.tokenProgram!==c.asset.tokenProgram||r.asset.decimals!==c.asset.decimals)throw Error('Quote-fee receipt identity mismatch.');
    validatePayoutAmounts(c,r.recipientRaw,r.treasuryRaw);
    if(rawLamports(r.recipientRaw)+rawLamports(r.treasuryRaw)===0n)throw Error('Empty quote-fee receipt.');
   }
   const rows=await db()`WITH settled AS(
    UPDATE fomo_quote_fee_attempts a SET state=${r?'confirmed':'failed'},receipt=${r?JSON.stringify(r):null}::jsonb,finalized_at=clock_timestamp()
    FROM fomo_quote_fee_routes p WHERE a.mint=p.mint AND p.mint=${c.mint} AND p.recipient=${c.recipient} AND p.buyback_wallet=${c.buybackWallet}
     AND p.quote_mint=${c.asset.mint} AND p.token_program=${c.asset.tokenProgram} AND p.decimals=${c.asset.decimals}
     AND p.lease_id=${c.lease}::uuid AND p.lease_until>clock_timestamp() AND a.id=${a.id}::uuid AND a.state='pending' AND a.signature=${a.signature} AND a.signed_transaction=${a.signed}
    RETURNING a.id,a.mint,a.signature
   ),credit AS(
    INSERT INTO fomo_quote_treasury_credits(attempt_id,source_mint,treasury,quote_mint,token_program,decimals,raw_amount,signature,slot)
    SELECT id,mint,${c.buybackWallet},${c.asset.mint},${c.asset.tokenProgram},${c.asset.decimals},${r?.treasuryRaw??'0'}::numeric,signature,${r?.slot??0} FROM settled
    WHERE ${!!r} AND ${r?.treasuryRaw??'0'}::numeric>0 RETURNING attempt_id
   ) UPDATE fomo_quote_fee_routes p SET last_paid_at=CASE WHEN ${!!r} THEN clock_timestamp() ELSE p.last_paid_at END FROM settled s WHERE p.mint=s.mint RETURNING p.mint`;
   if(rows.length!==1)throw Error('Quote-fee settlement lease lost.');
  },
  async complete(c:QuoteFeeClaim,outcome:PayoutOutcome){
   const failure=['retry','failed','expired_unresolved'].includes(outcome);
   await db()`UPDATE fomo_quote_fee_routes SET lease_id=NULL,lease_until=NULL,last_checked_at=clock_timestamp(),outcome=${outcome},
    next_run_at=clock_timestamp()+CASE WHEN ${outcome==='budget_exhausted'} THEN 300 WHEN ${failure} THEN LEAST(60*power(2,failures),120) ELSE 60 END*interval '1 second',
    failures=CASE WHEN ${failure} THEN LEAST(failures+1,6) ELSE 0 END
    WHERE mint=${c.mint} AND lease_id=${c.lease}::uuid AND lease_until>clock_timestamp()`;
  },
  async totals(){
   return await db()`SELECT p.mint,p.recipient,p.buyback_wallet,p.quote_mint,p.token_program,p.decimals,
    COALESCE(sum((a.receipt->>'recipientRaw')::numeric),0)::text AS recipient_raw,
    COALESCE(sum((a.receipt->>'treasuryRaw')::numeric),0)::text AS treasury_raw
    FROM fomo_quote_fee_routes p LEFT JOIN fomo_quote_fee_attempts a ON a.mint=p.mint AND a.state='confirmed'
    GROUP BY p.mint ORDER BY p.created_at DESC LIMIT 100`;
  },
  async health(){
   const rows=await db()`SELECT
    (SELECT count(*)::integer FROM fomo_quote_fee_attempts WHERE state='pending' AND created_at<clock_timestamp()-interval '2 minutes') AS unresolved,
    count(*) FILTER(WHERE enabled AND next_run_at<clock_timestamp()-interval '120 seconds')::integer AS overdue,
    count(*) FILTER(WHERE enabled AND outcome IN('retry','failed','expired_unresolved','budget_exhausted'))::integer AS blocked
    FROM fomo_quote_fee_routes WHERE (${onlyQuoteMint??null}::text IS NULL OR quote_mint=${onlyQuoteMint??null})`;
   return rows[0] as {unresolved:number;overdue:number;blocked:number};
  }
 };
}
export type LaunchQuoteStore=ReturnType<typeof launchQuoteStore>;
