import {randomUUID} from 'node:crypto';
import {conversionPolicyId,verifyConversionPlan,verifyConversionSignature,type ConversionAttempt,type quoteConversionChain} from './quote-conversion-chain.js';
import type {QuoteConversionStore} from './quote-conversion-store.js';
export async function runQuoteConversion(d:{store:QuoteConversionStore;chain:ReturnType<typeof quoteConversionChain>;execute:boolean;signal:AbortSignal;authorize?:(quoteMint:string,treasury:string)=>boolean;sign:(unsigned:string,signal:AbortSignal)=>Promise<string>}){
 d.signal.throwIfAborted();const c=await d.store.claim(!d.execute);if(!c)return{outcome:'idle'};
 let outcome='retry';
 try{
  let a=c.attempt;
  if(a){
   const r=await d.chain.reconcile(a);
   if(r.kind==='settled'){await d.store.settle(c,a,r.receipt);outcome=r.receipt.success?'confirmed':'failed';return{outcome};}
   if(r.kind==='expired_unresolved'){outcome=r.kind;return{outcome};}
  }
  const authorized=()=>!d.authorize||!!c.asset&&d.authorize(c.asset.mint,c.policy.treasury);
  if(!d.execute||!c.enabled||!authorized()){outcome=a?'pending':'paused';return{outcome};}
  d.signal.throwIfAborted();
  if(!a){
   if(!c.asset||c.available==='0'){outcome='below_threshold';return{outcome};}
   const plan=await d.chain.prepare(c.policy,c.asset,c.available);if(!plan){outcome='below_threshold';return{outcome};}
   await verifyConversionPlan(plan);
   if(conversionPolicyId(plan.policy)!==conversionPolicyId(c.policy)||plan.asset.mint!==c.asset.mint||plan.asset.tokenProgram!==c.asset.tokenProgram||plan.asset.decimals!==c.asset.decimals||plan.inputRaw!==c.available||Date.now()-plan.preparedAt>30000||plan.preparedAt>Date.now()+1000)throw Error('Conversion preparation changed.');
   d.signal.throwIfAborted();if(!authorized()){outcome='paused';return{outcome};}const signed=await d.sign(plan.unsigned,d.signal);d.signal.throwIfAborted();
   a={id:randomUUID(),plan,signed,signature:''} satisfies ConversionAttempt;a.signature=verifyConversionSignature(a);
   if(!await d.store.save(c,a)){outcome='budget_exhausted';return{outcome};}
  }
  d.signal.throwIfAborted();if(!await d.store.maySend(c,a)||!authorized()){outcome='paused';return{outcome};}
  d.signal.throwIfAborted();outcome=await d.chain.send(a)==='sent'?'submitted':'expired_unresolved';return{outcome};
 }catch{outcome='retry';return{outcome};}
 finally{await d.store.complete(c,outcome);}
}
