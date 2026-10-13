import {capturedSaleAnchor} from './cash-copy-unsigned-sale-recovery.js';
import {cashSigningAttempt,cashSigningPartId,type CashSigningParts} from './cash-copy-signing-parts.js';
import type {CashCopyDocument} from './cash-copy-journal.js';
/** Scheduling only. Execution still re-reads authority, chain proof, review and
 * immutable part fences. Missing/uncertain part evidence never permits reset. */
export function cashCapturedSaleRetries(now:()=>number=Date.now){
 const next=new Map<string,{at:number;expires:number}>();
 return async(config:{document:CashCopyDocument;parts:CashSigningParts;enabled:()=>boolean;execute:(id:string)=>Promise<void>},signal:AbortSignal):Promise<boolean>=>{
  for(const [key,value] of next)if(value.expires<now())next.delete(key);
  if(!config.enabled()||signal.aborted||config.document.revoked)return false;
  let pending=false;
  for(const job of Object.values(config.document.jobs)){
   signal.throwIfAborted();if(!config.enabled())break;
   const preparing=job.state==='reserved'&&!job.sale&&!job.signingFailure;
   const recovering=job.state==='needs-attention'&&job.sale?.state==='prepared'&&!job.sale.signed&&!job.sale.hashes&&!job.sale.receipt&&!job.sale.feeWei;
   if((!preparing&&!recovering)||job.signed||job.purchase||job.leaderInvalidatedAt||job.provisionalDebit||job.provisionalCredit||!capturedSaleAnchor(config.document,job,now())||now()>=job.scope.expiresAt)continue;
   const attempt=cashSigningAttempt(job);if(attempt>=2||(job.unsignedSaleAttempts||[]).length!==attempt)continue;
   // Even an unsigned provider claim is uncertain. Leave it to durable
   // reconciliation, never repeatedly ask a fast loop to replace its review.
   if(await config.parts.get(cashSigningPartId(job,0))||await config.parts.get(cashSigningPartId(job,1)))continue;
   const key=job.scope.planId+':'+job.id+':'+attempt;
   if(!next.has(key)&&next.size>=1000)continue;
   pending=true;
   const backoff=preparing?2000:15000;
   if(now()<Math.max((job.signingFailure?.at||0)+backoff,next.get(key)?.at||0))continue;
   next.set(key,{at:now()+backoff,expires:job.event.blockTime+120000});
   try{await config.execute(job.id);}catch{signal.throwIfAborted();/* Retry only fresh, unsigned evidence after backoff. */}
  }
  return pending;
 };
}
