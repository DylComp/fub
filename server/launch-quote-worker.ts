import {randomUUID} from 'node:crypto';
import {verifyPayoutSignature,type PayoutOutcome} from './launch-payout-model.js';
import {verifyQuoteFeePlan,type QuoteFeeAttempt,type QuoteFeePlan,type QuoteFeeReceipt,type QuoteFeeRoute} from './launch-quote-fees.js';
import type {LaunchQuoteStore} from './launch-quote-store.js';
export type QuoteFeeChain={
 prepare:(route:QuoteFeeRoute)=>Promise<QuoteFeePlan|null>;
 reconcile:(route:QuoteFeeRoute,a:QuoteFeeAttempt)=>Promise<{kind:'confirmed';receipt:QuoteFeeReceipt}|{kind:'failed'|'pending'|'expired_unresolved'}>;
 send:(route:QuoteFeeRoute,a:QuoteFeeAttempt)=>Promise<'sent'|'expired'>;
};
export async function runQuoteFeePayout(deps:{store:LaunchQuoteStore;chain:QuoteFeeChain;payer:string;dailyCapLamports:string;execute:boolean;signal:AbortSignal;authorize?:(route:QuoteFeeRoute)=>boolean;sign:(unsigned:string,signal:AbortSignal)=>Promise<string>}){
 deps.signal.throwIfAborted();const c=await deps.store.claim(!deps.execute);if(!c)return{outcome:'idle' as const};
 let outcome:PayoutOutcome='retry';
 try{
  let a=c.attempt;
  if(a){
   const r=await deps.chain.reconcile(c,a);
   if(r.kind==='confirmed'||r.kind==='failed'){await deps.store.settle(c,a,r.kind==='confirmed'?r.receipt:null);outcome=r.kind;return{outcome};}
   if(r.kind==='expired_unresolved'){outcome=r.kind;return{outcome};}
  }
  if(!deps.execute||!c.enabled||deps.authorize&&!deps.authorize(c)){outcome=a?'pending':'paused';return{outcome};}
  deps.signal.throwIfAborted();
  if(!a){
   const plan=await deps.chain.prepare(c);if(!plan){outcome='below_threshold';return{outcome};}
   await verifyQuoteFeePlan(c,deps.payer,plan);deps.signal.throwIfAborted();
   if(deps.authorize&&!deps.authorize(c)){outcome='paused';return{outcome};}
   const signed=await deps.sign(plan.unsigned,deps.signal),signature=verifyPayoutSignature(plan,signed,deps.payer);
   a={...plan,id:randomUUID(),payer:deps.payer,signed,signature};deps.signal.throwIfAborted();
   if(!await deps.store.save(c,a,deps.dailyCapLamports)){outcome='budget_exhausted';return{outcome};}
  }
  deps.signal.throwIfAborted();if(!await deps.store.maySend(c,a)||deps.authorize&&!deps.authorize(c)){outcome='paused';return{outcome};}
  deps.signal.throwIfAborted();outcome=await deps.chain.send(c,a)==='sent'?'submitted':'expired_unresolved';return{outcome};
 }catch{outcome='retry';return{outcome};}
 finally{await deps.store.complete(c,outcome);}
}
