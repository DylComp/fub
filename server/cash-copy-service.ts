import {cashSigningFailureReason,type CashSigningFailureReason} from './cash-signing-failure.js';
import {cashCopyRaw,validateCashCopyScope,validateCashCopyEvent,type CashCopyScope,type CashCopyEvent} from '../src/cash-copy-model.js';
import type {CashPurchase} from './cash-purchase-store.js';
import type {CashSale} from './cash-return-store.js';
import type {cashPurchaseService} from './cash-purchase-service.js';
import type {cashReturnService} from './cash-return-service.js';
import {inspectSignedCashDeposit} from './cash-deposit.js';
import {saleHashes} from './cash-return-store.js';
export const CASH_SIGNING_STAGES=['access','leader-proof','quote','simulation','gas','ownership','provider-signature','post-sign-check'] as const;
export type CashSigningStage=typeof CASH_SIGNING_STAGES[number];
export type CashCopyJob={ownerSale?:import('./cash-copy-owner-sale.js').OwnerSale;signingAttempt?:number;signingFailure?:{at:number;stage?:CashSigningStage;reason?:CashSigningFailureReason;code:'pre-sign-check-failed'|'signature-outcome-unresolved'};unsignedSaleAttempts?:{attempt:number;recoveredAt:number;event:CashCopyEvent;sale:CashSale;reason:string}[];id:string;scope:CashCopyScope;event:CashCopyEvent;amountRaw:string;state:'reserved'|'prepared'|'signing'|'submitted'|'complete'|'needs-attention'|'stopped';purchase:CashPurchase|null;sale:CashSale|null};
export interface CashCopyJournal {
 get(id:string):Promise<CashCopyJob|null>;
 // Implementations must CAS against the saved state and persist review before
 // signer access. One job ID is also the immutable purchase/sale ID.
 prepared(job:CashCopyJob,review:CashPurchase|CashSale):Promise<CashCopyJob>;
 claimSigning(job:CashCopyJob):Promise<boolean>;
 recordSigned(job:CashCopyJob,signed:string|string[]):Promise<void>;
 signatures(id:string):Promise<string|string[]|null>;
 submitted(job:CashCopyJob):Promise<void>;
 settle(job:CashCopyJob,result:CashPurchase|CashSale):Promise<void>;
 stop(job:CashCopyJob,state:'stopped'|'needs-attention'):Promise<void>;
 signingFailed?(job:CashCopyJob,code:'pre-sign-check-failed'|'signature-outcome-unresolved',stage?:CashSigningStage,reason?:CashSigningFailureReason):Promise<void>;
}
// Execution core uses the same checked, journaled purchase/return services as
// manual trading. A production observer, atomic budget journal and isolated
// delegated signer must be supplied; no public route can call this factory.
export function cashCopyService(config:{journal:CashCopyJournal;purchases:ReturnType<typeof cashPurchaseService>;returns:ReturnType<typeof cashReturnService>;
 enabled:()=>boolean;authorized:(job:CashCopyJob)=>Promise<boolean>;
 recoverSigned?:(id:string)=>Promise<string|string[]|null>;
 retainSigned?:(job:CashCopyJob,signed:string|string[])=>Promise<void>;
 recoverUnsignedSale?:(id:string)=>Promise<boolean>;
 signer:{purchase:(job:CashCopyJob,purchase:CashPurchase)=>Promise<string>;sale:(job:CashCopyJob,sale:CashSale)=>Promise<string[]>};now?:()=>number}){
 const {journal}=config,now=config.now||Date.now;
 const authorize=async(job:CashCopyJob)=>{
  validateCashCopyScope(job.scope);
  validateCashCopyEvent(job.event,job.scope,now());
  if(!config.enabled()||now()>=job.scope.expiresAt||!await config.authorized(job))throw Error('Cross-chain copying is not authorized.');
 };
 return {async tick(id:string){
  let job=await journal.get(id);if(!job||['complete','stopped'].includes(job.state))return;
  let scope=job.scope,event=job.event;
  if(!scope.networks.includes(event.network)||event.leader!==scope.leader||cashCopyRaw(job.amountRaw)<=0n)throw Error('Copy job scope changed.');
  // Recovery is allowed after a plan stops or a permission expires. Never
  // interpret a pending bridge or expired permission as a failed purchase.
  if(['signing','submitted','needs-attention'].includes(job.state)){
   // Recover the private signer journal before status can expire a review
   // that is unsigned only in the downstream execution ledger.
   const retained=await journal.signatures(id)||await config.recoverSigned?.(id);
   if(retained){
    if(!await journal.signatures(id)){await journal.recordSigned(job,retained);job=(await journal.get(id))!;}
    await config.retainSigned?.(job,retained);
   }
   const result=event.side==='buy'?await config.purchases.status(id,scope.sourceWallet):await config.returns.status(id,scope.sourceWallet);
   // The underlying ledger is bound before broadcast. Reconcile it even if a
   // crash occurred before our job could be marked submitted, or permissions
   // were revoked while the bridge was settling.
   if(result?.state==='expired'&&event.side==='buy'&&!result.signed){await journal.settle(job,result);return;}
   if(result?.signed){
    await journal.settle(job,result);
    // A lost RPC response does not require a new signature. Only retry the
    // exact saved bytes while the original permission is still active.
    if(['submitted','settling','delayed'].includes(result.state)&&config.enabled()&&now()<scope.expiresAt&&await config.authorized(job)){
     const resumed=event.side==='buy'?await config.purchases.resume(id,scope.sourceWallet):await config.returns.resume(id,scope.sourceWallet);
     if(resumed)await journal.settle(job,resumed);
    }
    return;
   }
   const recovered=await config.recoverSigned?.(id);
   if(recovered){await journal.recordSigned(job,recovered);job=(await journal.get(id))!;}
   else if(job.state!=='signing'){
    if(event.side!=='sell'||job.state!=='needs-attention'||!await config.recoverUnsignedSale?.(id))return;
    job=await journal.get(id);if(!job||job.state!=='reserved')return;
    scope=job.scope;event=job.event;
   }
  }
  // A never-signed stale observation can be skipped. After signing starts,
  // preserve its reservation even if authority expires or the job is paused.
  if(['reserved','prepared'].includes(job.state)&&
    (!config.enabled()||now()>=job.scope.expiresAt||now()-job.event.observedAt>(job.event.confirmation==='provisional'?10000:job.event.confirmation==='captured'?120000:60000)||job.event.confirmation==='provisional'&&now()-job.event.blockTime>10000)){
   await journal.stop(job,'stopped');return;
  }
  await authorize(job);
  if(job.state==='reserved'){
   if(event.side==='buy'&&job.amountRaw!==scope.buyUsdcRaw)throw Error('Copy buy size changed.');
   const review=event.side==='buy'?await config.purchases.prepare(id,{sourceWallet:scope.sourceWallet,recipient:scope.recipient,network:event.network,token:event.token,amountRaw:job.amountRaw,slippageBps:scope.slippageBps,gasTopupUsdcRaw:scope.gasTopupUsdcRaw}):await config.returns.prepare(id,{network:event.network,wallet:scope.recipient,cashWallet:scope.sourceWallet,token:event.token,amountRaw:job.amountRaw,slippageBps:scope.slippageBps},scope.maxSaleGas[event.network]!);
   job=await journal.prepared(job,review);
  }
  let signed=await journal.signatures(id);
  if(!signed){
   if(job.state==='signing')return; // An uncertain signer response is not permission to sign a new review.
   await authorize(job);
   if(!await journal.claimSigning(job))return;
   try{
    signed=event.side==='buy'?await config.signer.purchase(job,job.purchase!):await config.signer.sale(job,job.sale!);
    if(event.side==='buy'){if(typeof signed!=='string')throw Error('Invalid copied purchase signature.');inspectSignedCashDeposit(job.purchase!.review,signed);}
    else{if(!Array.isArray(signed))throw Error('Invalid copied sale signatures.');await saleHashes(job.sale!,signed);}
    // Preserve the returned signature even when authority expired during the
    // call. It must be recoverable, but cannot be broadcast without authority.
    await journal.recordSigned(job,signed);
   }catch(error){const stage=(error as {cashSigningStage?:unknown})?.cashSigningStage;await journal.signingFailed?.(job,'signature-outcome-unresolved',typeof stage==='string'&&(CASH_SIGNING_STAGES as readonly string[]).includes(stage)?stage as CashSigningStage:undefined,cashSigningFailureReason(error));await journal.stop(job,'needs-attention');return;}
  }
  await authorize(job);
  if(event.side==='buy')await config.purchases.submit(id,scope.sourceWallet,signed as string);
  else await config.returns.submit(id,scope.sourceWallet,signed as string[]);
  await journal.submitted(job);
 }};
}
