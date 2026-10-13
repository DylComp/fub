import canonicalize from 'canonicalize';
import { neon } from '@neondatabase/serverless';
import { inspectSignedCashDeposit, type CashDepositReview } from './cash-deposit.js';
import type { CashWalletBinding } from './cash-wallet-binding.js';
import type { CashReceipt } from '../src/cash-recovery.js';
export type CashPurchaseState='expired'|'prepared'|'submitted'|'settling'|'delayed'|'needs-attention'|'complete'|'refunded'|'reverted';
export type CashPurchase={id:string;wallet:string;review:CashDepositReview;binding:CashWalletBinding;state:CashPurchaseState;signed:string|null;signature:string|null;receipt:CashReceipt|null};
export interface CashPurchaseStore {
  reserve(id:string,review:CashDepositReview,binding:CashWalletBinding):Promise<CashPurchase>;
  get(id:string,wallet:string):Promise<CashPurchase|null>;
  refresh(previous:CashPurchase,review:CashDepositReview,binding:CashWalletBinding):Promise<CashPurchase>;
  bind(id:string,wallet:string,signed:string):Promise<CashPurchase>;
  expire(id:string,wallet:string,blockhash:string):Promise<CashPurchase>;
  expireUnlanded(previous:CashPurchase,checkedAt:number):Promise<CashPurchase>;
  settle(id:string,signature:string,state:Exclude<CashPurchaseState,'expired'|'prepared'|'submitted'>,receipt?:CashReceipt):Promise<CashPurchase>;
  pending(limit:number):Promise<CashPurchase[]>;
}
function parse(row:any):CashPurchase|null{
  if(!row)return null;
  const value:CashPurchase={id:row.id,wallet:row.wallet,review:row.review,binding:row.binding,state:row.state,signed:row.signed_transaction,signature:row.signature,receipt:row.receipt};
  if(value.review.quote.sourceWallet!==value.wallet||value.review.quote.requestId!==row.request_id||value.binding.sourceWallet!==value.wallet||
    value.binding.recipient!==value.review.quote.recipient||value.binding.network!==value.review.quote.network||
    !!value.signed!==!!value.signature||value.signed&&inspectSignedCashDeposit(value.review,value.signed)!==value.signature)throw Error('Cash journal integrity failed.');
  return value;
}
export function cashPurchaseStore(url:string):CashPurchaseStore{
 const query=()=>neon(url,{fetchOptions:{signal:AbortSignal.timeout(8000)}});
 return {
  async get(id,wallet){const sql=query();return parse((await sql`SELECT * FROM fub_cash_purchases WHERE id=${id}::uuid AND wallet=${wallet}`)[0]);},
  async reserve(id,review,binding){
   const sql=query();
   await sql`INSERT INTO fub_cash_purchases(id,wallet,request_id,order_id,review,binding) VALUES(${id}::uuid,${review.quote.sourceWallet},${review.quote.requestId},${review.quote.orderId},${JSON.stringify(review)}::jsonb,${JSON.stringify(binding)}::jsonb) ON CONFLICT DO NOTHING`;
   const saved=await this.get(id,review.quote.sourceWallet);
   if(!saved||saved.review.quote.requestId!==review.quote.requestId||saved.review.unsigned!==review.unsigned)throw Error('Another cash purchase is unresolved. Check its status.');
   return saved;
  },
  async refresh(previous,review,binding){
   if(previous.state!=='expired'||previous.signed||previous.signature||previous.receipt)throw Error('Only a proven unsent purchase can be refreshed.');
   if(canonicalize(previous.review.intent)!==canonicalize(review.intent)||review.maxFeeLamports!==previous.review.maxFeeLamports||review.maxRentLamports!==previous.review.maxRentLamports||binding.sourceWallet!==previous.wallet||binding.recipient!==previous.binding.recipient||binding.network!==previous.binding.network)throw Error('Purchase refresh changed its reserved limits.');
   const {supersededReviews:history=[],...oldReview}=previous.review as CashDepositReview&{supersededReviews?:unknown[]};
   if(!Array.isArray(history)||history.length>=16)throw Error('This purchase needs review before another quote.');
   const next={...review,supersededReviews:[...history,{review:oldReview,state:'expired'}]};
   const sql=query();
   await sql`UPDATE fub_cash_purchases SET request_id=${review.quote.requestId},order_id=${review.quote.orderId},review=${JSON.stringify(next)}::jsonb,binding=${JSON.stringify(binding)}::jsonb,state='prepared',updated_at=clock_timestamp()
    WHERE id=${previous.id}::uuid AND wallet=${previous.wallet} AND state='expired' AND signed_transaction IS NULL AND signature IS NULL AND receipt IS NULL
    AND request_id=${previous.review.quote.requestId} AND review=${JSON.stringify(previous.review)}::jsonb`;
   const saved=await this.get(previous.id,previous.wallet);
   if(!saved||saved.review.quote.requestId!==review.quote.requestId||saved.review.unsigned!==review.unsigned)throw Error('The purchase changed while refreshing. Check its status.');
   return saved;
  },
  async bind(id,wallet,signed){
   const saved=await this.get(id,wallet);if(!saved)throw Error('Cash purchase not found.');
   const signature=inspectSignedCashDeposit(saved.review,signed),sql=query();
   await sql`UPDATE fub_cash_purchases SET signed_transaction=${signed},signature=${signature},state='submitted',updated_at=clock_timestamp() WHERE id=${id}::uuid AND wallet=${wallet} AND state='prepared' AND signature IS NULL AND request_id=${saved.review.quote.requestId} AND review=${JSON.stringify(saved.review)}::jsonb`;
   const result=await this.get(id,wallet);
   if(!result||result.signed!==signed||result.signature!==signature)throw Error('This cash purchase already has a different submission.');
   return result;
  },
  async expire(id,wallet,blockhash){
   const sql=query();
   await sql`UPDATE fub_cash_purchases SET state='expired',updated_at=clock_timestamp() WHERE id=${id}::uuid AND wallet=${wallet} AND state='prepared' AND signature IS NULL AND review->>'blockhash'=${blockhash}`;
   const saved=await this.get(id,wallet);if(!saved)throw Error('Cash purchase not found.');return saved;
  },
  async expireUnlanded(previous,checkedAt){
   if(previous.state!=='submitted'||!previous.signed||!previous.signature||previous.receipt||!Number.isSafeInteger(checkedAt))throw Error('Invalid unlanded purchase expiry.');
   // Preserve the exact old signed bytes for audit before clearing the active
   // submission. The service requires an expired blockhash, complete finalized
   // source history and an absent signature before calling this CAS.
   const review={...previous.review,unlandedSubmission:{signed:previous.signed,signature:previous.signature,checkedAt,evidence:'expired-blockhash-and-finalized-source-history'}};
   const sql=query();
   await sql`UPDATE fub_cash_purchases SET review=${JSON.stringify(review)}::jsonb,state='expired',signed_transaction=NULL,signature=NULL,updated_at=clock_timestamp()
    WHERE id=${previous.id}::uuid AND wallet=${previous.wallet} AND state='submitted' AND receipt IS NULL
    AND signature=${previous.signature} AND signed_transaction=${previous.signed}
    AND request_id=${previous.review.quote.requestId} AND review=${JSON.stringify(previous.review)}::jsonb`;
   const saved=await this.get(previous.id,previous.wallet);if(!saved)throw Error('Cash purchase not found.');return saved;
  },
  async settle(id,signature,state,receipt){
   const sql=query();
   const saved=parse((await sql`SELECT * FROM fub_cash_purchases WHERE id=${id}::uuid AND signature=${signature}`)[0]);
   if(!saved)throw Error('Cash purchase not found.');
   if((state==='complete'||state==='refunded')!==!!receipt||receipt&&receipt.requestId!==saved.review.quote.requestId)throw Error('Cash receipt does not match the purchase.');
   await sql`UPDATE fub_cash_purchases SET state=${state},receipt=${receipt?JSON.stringify(receipt):null}::jsonb,updated_at=clock_timestamp() WHERE id=${id}::uuid AND signature=${signature} AND state IN('submitted','settling','delayed','needs-attention')`;
   return (await this.get(id,saved.wallet))!;
  },
  async pending(limit){if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('Invalid cash recovery batch.');const sql=query();return (await sql`SELECT * FROM fub_cash_purchases WHERE state IN('prepared','submitted','settling','delayed','needs-attention') ORDER BY (state='prepared'),updated_at LIMIT ${limit}`).map(row=>parse(row)!);}
 };
}
