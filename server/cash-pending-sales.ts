import canonicalize from 'canonicalize';
import {cashCopyJournal,type CashCopyCas} from './cash-copy-journal.js';
import {compareCashCopyEvents,type CashCopyEvent} from '../src/cash-copy-model.js';
/** Captured sales survive a slow bridge, but cannot sell estimates or unrelated
 * deposits. Reverify their exact block and amounts when inventory is available. */
export async function drainCashPendingSales(config:{cas:CashCopyCas;planId:string;wallet:string;enabled:()=>boolean;verify:(event:CashCopyEvent,signal:AbortSignal)=>Promise<CashCopyEvent|null>;execute:(id:string)=>Promise<void>;now?:()=>number},signal:AbortSignal){
 const now=config.now||Date.now,journal=cashCopyJournal(config.cas,config.planId,config.wallet,now);
 const saved=(await config.cas.read(config.planId,config.wallet))?.value;if(!saved||!config.enabled()||saved.revoked)return;
 const pending=Object.values(saved.pendingSales||{}).filter(p=>p.state==='waiting').sort((a,b)=>compareCashCopyEvents(a.event,b.event)||a.capturedAt-b.capturedAt);
 for(const p of pending){
  signal.throwIfAborted();if(!config.enabled())return;
  if(p.permissionId!==saved.grant.scope.id||now()>=saved.grant.scope.expiresAt||now()-p.event.blockTime>1800000){await journal.cancelQueuedSale(p.event.transaction,p.event.network);continue;}
  const buys=p.waitingOn.map(id=>saved.jobs[id]);
  if(buys.some(j=>!j||j.leaderInvalidatedAt||j.state==='stopped')){await journal.cancelQueuedSale(p.event.transaction,p.event.network);continue;}
  if(buys.some(j=>j.state!=='complete'&&!j.provisionalCredit||j.state==='needs-attention'))return;
  const proof=await config.verify(p.event,signal);signal.throwIfAborted();if(!proof)return;
  const fields=(e:CashCopyEvent)=>{const{observedAt,confirmation,...rest}=e;return rest;};
  if(canonicalize(fields(proof))!==canonicalize(fields(p.event)))throw Error('Queued leader sale changed.');
  if(!config.enabled())return;
  const job=await journal.reserve(proof);await config.execute(job.id);return; // one unresolved sale at a time
 }
}
