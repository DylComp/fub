import canonicalize from 'canonicalize';
import {cashSigningDigest,cashSigningPartId,cashSigningAttempt,type CashSigningParts} from './cash-copy-signing-parts.js';
import type {CashCopyCas,CashCopyDocument} from './cash-copy-journal.js';
import type {CashCopyEvent} from '../src/cash-copy-model.js';
import {validateCashCopyEvent} from '../src/cash-copy-model.js';
import type {CashCopyJob} from './cash-copy-service.js';
import type {CashSale} from './cash-return-store.js';
const same=(a:unknown,b:unknown)=>canonicalize(a)===canonicalize(b);
type Document=CashCopyDocument&{execution?:{sales:Record<string,CashSale>;purchases:Record<string,unknown>}};
const fields=(e:CashCopyEvent)=>{const{observedAt,confirmation,...rest}=e;return rest;};
/** A consumed, originally live signal is the only anchor for a captured retry.
 * Neither a fresh RPC observation nor retry time may extend its 120s lifetime. */
export function capturedSaleAnchor(d:CashCopyDocument,job:CashCopyJob,now=Date.now()){
 const p=d.pendingSales?.[job.event.network+':'+job.event.transaction];
 if(d.revoked||job.event.confirmation!=='captured'||job.event.side!=='sell'||!same(d.grant.scope,job.scope)||!p||p.permissionId!==job.scope.id||p.state!=='consumed'||p.event.confirmation!=='provisional'||p.event.observedAt!==job.event.observedAt||!Number.isSafeInteger(p.capturedAt)||p.capturedAt<p.event.blockTime||p.capturedAt-p.event.blockTime>10000||!same(fields(p.event),fields(job.event)))return null;
 try{validateCashCopyEvent(job.event,job.scope,now);}catch{return null;}
 return p;
}
/** Fence an unsigned sale before replacing its expired review. Unique part rows
 * arbitrate against in-flight signer claims. A real claim (even without bytes)
 * makes recovery refuse. Tombstones are permanent; no part is removed/reused. */
export async function recoverUnsignedCashSale(config:{cas:CashCopyCas;parts:CashSigningParts;planId:string;wallet:string;id:string;enabled:()=>boolean;verify:(event:CashCopyEvent,signal:AbortSignal)=>Promise<CashCopyEvent|null>;now?:()=>number},signal:AbortSignal):Promise<boolean>{
 const now=config.now||Date.now;
 signal.throwIfAborted();if(!config.enabled())return false;
 const snapshot=(await config.cas.read(config.planId,config.wallet))?.value as Document|undefined;
 const job=snapshot?.jobs[config.id],sale=snapshot?.execution?.sales[config.id];
 if(!snapshot||!job||!sale||snapshot.revoked||job.state!=='needs-attention'||job.event.side!=='sell'||job.signed||job.purchase||job.leaderInvalidatedAt||job.provisionalDebit||job.provisionalCredit||job.scope.id!==snapshot.grant.scope.id||!same(job.scope,snapshot.grant.scope)||now()>=job.scope.expiresAt||sale.state!=='prepared'||sale.signed||sale.hashes||sale.receipt||sale.feeWei||!same(job.sale,sale))return false;
 const attempt=cashSigningAttempt(job),history=job.unsignedSaleAttempts||[];
 if(attempt>=2||history.length!==attempt||now()-(job.signingFailure?.at||0)<15000)return false;
 const verified=await config.verify(job.event,signal);signal.throwIfAborted();if(!verified)return false;
 const captured=verified.confirmation==='captured';
 if(verified.confirmation!=='finalized'&&!captured)return false;
 const anchor=captured?capturedSaleAnchor(snapshot,job,now()):null;
 if(captured&&(!anchor||verified.observedAt!==job.event.observedAt))return false;
 if(!same(fields(verified),fields(job.event)))throw Error('Unsigned sale leader evidence changed.');
 validateCashCopyEvent(verified,job.scope,now());
 const fence=cashSigningDigest({purpose:'retire-unsigned-sale',job,sale});
 const ids=[cashSigningPartId(job,0),cashSigningPartId(job,1)];
 // A crash after one insert can only block the old attempt, never release it.
 // Re-entering with the same immutable snapshot completes the remaining fence.
 for(const id of ids){signal.throwIfAborted();await config.parts.claim(id,fence);}
 for(const id of ids){const p=await config.parts.get(id);if(!p||p.digest!==fence||p.state!=='claimed'||p.signed)return false;}
 for(let retry=0;retry<12;retry++){
  signal.throwIfAborted();if(!config.enabled())return false;
  const row=await config.cas.read(config.planId,config.wallet);if(!row)return false;
  const d=structuredClone(row.value) as Document,current=d.jobs[config.id];
  if(!same(current,job)||!same(d.execution?.sales[config.id],sale)||d.revoked||!same(d.grant.scope,job.scope)||now()>=job.scope.expiresAt)return false;
  if(captured&&(!capturedSaleAnchor(d,current,now())||!same(d.pendingSales?.[job.event.network+':'+job.event.transaction],anchor)))return false;
  validateCashCopyEvent(verified,job.scope,now());
  const position=d.positions[`${job.event.network}:${job.event.token}`]||'0';if(BigInt(position)<BigInt(job.amountRaw))return false;
  current.unsignedSaleAttempts=[...history,{attempt,recoveredAt:now(),event:structuredClone(job.event),sale:structuredClone(sale),reason:'unsigned-pre-sign-failure'}];
  current.signingAttempt=attempt+1;current.signingFailure=undefined;current.event=structuredClone(verified);current.sale=null;current.state='reserved';
  delete d.execution!.sales[config.id];
  if(await config.cas.write(config.planId,config.wallet,row.revision,d))return true;
 }
 throw Error('Unsigned sale recovery is busy.');
}
