import {cashLimitReached,type CashLimitObservation,type CashLimitTerms} from '../src/cash-limit-model.js';

export type CashLimitState='waiting'|'preparing'|'signing'|'submitted'|'complete'|'cancelled'|'expired'|'needs-attention';
export type CashLimitJob<Review>={terms:CashLimitTerms;state:CashLimitState;revision:number;review?:Review;signed?:string[]};
export interface CashLimitJournal<Review>{
 get(id:string):Promise<CashLimitJob<Review>|null>;
 // Every mutation must compare both revision and saved state. A unique order ID
 // plus this atomic claim prevents concurrent ticks from signing twice.
 claim(job:CashLimitJob<Review>):Promise<CashLimitJob<Review>|null>;
 // Only a proven pre-signing state may wait for a better/fresh quote.
 defer?(job:CashLimitJob<Review>):Promise<void>;
 prepared(job:CashLimitJob<Review>,review:Review):Promise<CashLimitJob<Review>>;
 signing(job:CashLimitJob<Review>):Promise<CashLimitJob<Review>>;
 signed(job:CashLimitJob<Review>,bytes:string[]):Promise<CashLimitJob<Review>>;
 terminal(job:CashLimitJob<Review>,state:'cancelled'|'expired'|'needs-attention'|'complete'):Promise<void>;
}
// Deliberately not installed in a public route. Production installation needs a
// durable journal, independently verified two-wallet limit grant and a signer
// that verifies these exact terms. A copied trade grant cannot satisfy it.
export function cashLimitEngine<Review>(c:{journal:CashLimitJournal<Review>;enabled:()=>boolean;now?:()=>number;
 authorized:(terms:CashLimitTerms)=>Promise<boolean>;
 price:(terms:CashLimitTerms)=>Promise<CashLimitObservation>;
 prepare:(terms:CashLimitTerms)=>Promise<Review>;
 inspect:(terms:CashLimitTerms,review:Review)=>Promise<void>;
 sign:(terms:CashLimitTerms,review:Review)=>Promise<string[]>;
 submit:(terms:CashLimitTerms,review:Review,signed:string[])=>Promise<void>;
 recover:(job:CashLimitJob<Review>)=>Promise<'pending'|'complete'>;
}){
 const now=c.now||Date.now;
 const allowed=async(t:CashLimitTerms)=>c.enabled()&&now()>=t.issuedAt&&now()<t.expiresAt&&await c.authorized(t);
 return {async tick(id:string){
  let job=await c.journal.get(id);
  if(!job||['complete','cancelled','expired'].includes(job.state))return;
  if(['signing','submitted','needs-attention'].includes(job.state)){
   // Recovery never constructs a replacement quote or signature, including
   // when a signer returned bytes but the response could not be journaled.
   if(await c.recover(job)==='complete')await c.journal.terminal(job,'complete');
   return;
  }
  // A crashed preparing owner is an operator/recovery concern. It is never
  // silently claimed again; a DB adapter may release only proven unsigned work.
  if(job.state==='preparing')return;
  if(now()>=job.terms.expiresAt){await c.journal.terminal(job,'expired');return;}
  if(!await allowed(job.terms))return;
  if(!cashLimitReached(job.terms,await c.price(job.terms),now()))return;
  const claimed=await c.journal.claim(job);if(!claimed)return;job=claimed;
  try{
   const review=await c.prepare(job.terms);
   await c.inspect(job.terms,review);
   // The trigger and permission must still hold after network/quote latency.
   if(!await allowed(job.terms)||!cashLimitReached(job.terms,await c.price(job.terms),now()))throw Error('Limit conditions changed before signing.');
   job=await c.journal.prepared(job,review);
   job=await c.journal.signing(job);
   const signed=await c.sign(job.terms,review);
   if(!Array.isArray(signed)||signed.length===0||signed.some(s=>typeof s!=='string'||!s))throw Error('Missing limit transaction signature.');
   // Even an expired or revoked permission must retain already-signed bytes.
   job=await c.journal.signed(job,signed);
   if(!await allowed(job.terms))return;
   await c.inspect(job.terms,review);
   if(!await allowed(job.terms)||!cashLimitReached(job.terms,await c.price(job.terms),now()))return;
   await c.submit(job.terms,review,signed);
  }catch{
   // In particular, a submit timeout or signer error cannot release the order
   // for a new signature. Recovery must resolve the original attempt.
   if(job.state==='preparing'&&c.journal.defer)await c.journal.defer(job);
   else await c.journal.terminal(job,'needs-attention');
  }
 }};
}
