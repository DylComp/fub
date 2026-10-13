import canonicalize from 'canonicalize';
import {cashCopyJournal,type CashCopyCas} from './cash-copy-journal.js';
import {cashCopyRaw,compareCashCopyEvents,validateCashCopyEvent,type CashCopyEvent} from '../src/cash-copy-model.js';
/** A short funding delay may retain an already verified live buy. This is not
 * a historical replay queue: the original provisional freshness stays intact. */
export async function drainCashPendingBuys(config:{cas:CashCopyCas;planId:string;wallet:string;enabled:()=>boolean;allowsAsset:(event:CashCopyEvent)=>boolean;verify:(event:CashCopyEvent,signal:AbortSignal)=>Promise<CashCopyEvent|null>;execute:(id:string)=>Promise<void>;now?:()=>number},signal:AbortSignal){
 const now=config.now||Date.now,journal=cashCopyJournal(config.cas,config.planId,config.wallet,now);
 const saved=(await config.cas.read(config.planId,config.wallet))?.value;if(!saved||!config.enabled())return;
 const pending=Object.values(saved.pendingBuys||{}).filter(p=>p.state==='waiting').sort((a,b)=>compareCashCopyEvents(a.event,b.event)||a.capturedAt-b.capturedAt);
 for(const p of pending){
  signal.throwIfAborted();if(!config.enabled())return;
  const cancel=(reason:'expired'|'invalidated'|'permission'|'budget')=>journal.cancelQueuedBuy(p.event.transaction,p.event.network,reason);
  if(saved.revoked||p.permissionId!==saved.grant.scope.id||now()>=saved.grant.scope.expiresAt){await cancel('permission');continue;}
  try{validateCashCopyEvent(p.event,saved.grant.scope,now());}catch{await cancel('expired');continue;}
  if(p.event.confirmation!=='provisional'||p.event.side!=='buy'||!p.event.sourceOrder||!config.allowsAsset(p.event)){await cancel('invalidated');continue;}
  const prior=p.waitingOn.map(id=>saved.jobs[id]);
  if(!prior.length||prior.some(j=>!j||j.leaderInvalidatedAt||['stopped','needs-attention'].includes(j.state))){await cancel('invalidated');continue;}
  if(prior.some(j=>j.state!=='complete'&&!(j.state==='submitted'&&j.provisionalCredit)))return;
  const day=new Date(now()).toISOString().slice(0,10);
  if(cashCopyRaw(saved.spent[day]||'0')+cashCopyRaw(saved.grant.scope.buyUsdcRaw)>cashCopyRaw(saved.grant.scope.dailyUsdcRaw)){await cancel('budget');continue;}
  const proof=await config.verify(p.event,signal);signal.throwIfAborted();if(!proof)return;
  if(canonicalize({...proof,observedAt:0})!==canonicalize({...p.event,observedAt:0})){await cancel('invalidated');throw Error('Deferred leader buy changed.');}
  if(!config.enabled())return;
  // Preserve the original observation timestamp; reserve atomically rechecks
  // current permission, prerequisite credits, ordering, freshness and budget.
  const job=await journal.reserve(p.event);await config.execute(job.id);return;
 }
}
