import canonicalize from 'canonicalize';
import type {CashCopyEvent} from '../src/cash-copy-model.js';
import {validateCashCopyEvent} from '../src/cash-copy-model.js';
import {cashCopyJournal,type CashCopyCas} from './cash-copy-journal.js';
/** Private event entry point, deliberately absent from browser HTTP routes.
 * Rechecks evidence inside the host, then reserves one committed order before
 * waking execution. The executor rechecks again at its signing boundary. */
export function cashLiveDispatch(config:{cas:CashCopyCas;plans:(after:string|null)=>Promise<{planId:string;wallet:string}[]>;enabled:()=>boolean;allows:(wallet:string)=>boolean;allowsAsset:(event:CashCopyEvent)=>boolean;verify:(event:CashCopyEvent,signal:AbortSignal)=>Promise<CashCopyEvent|null>;execute:(planId:string,wallet:string,jobId:string,signal:AbortSignal)=>Promise<void>;pending?:(planId:string,wallet:string,signal:AbortSignal)=>Promise<void>;now?:()=>number}){
 const now=config.now||Date.now;
 async function visit(run:(row:{planId:string;wallet:string})=>Promise<void>,signal:AbortSignal){
  let cursor:string|null=null;const seen=new Set<string>();
  for(let page=0;page<25;page++){
   signal.throwIfAborted();const rows=await config.plans(cursor);if(!rows.length)return;
   for(const row of rows){if(seen.has(row.planId))throw Error('Live plan cursor did not advance.');seen.add(row.planId);}
   // A slow follower must not consume every other follower's live window.
   // Keep RPC/signing pressure bounded while journals serialize each plan.
   for(let offset=0;offset<rows.length;offset+=4){signal.throwIfAborted();await Promise.all(rows.slice(offset,offset+4).map(row=>run(row)));}
   cursor=rows[rows.length-1].planId;
  }
  throw Error('Live plan capacity exceeded.');
 }
 return{
  async accept(event:CashCopyEvent,signal:AbortSignal){
   if(!config.enabled())return{reserved:0,refused:0,paused:true};
   if(event.confirmation!=='provisional'||event.side==='buy'&&!event.sourceOrder||!config.allowsAsset(event))throw Error('Live event is outside the supported scope.');
   const proof=await config.verify(event,signal);signal.throwIfAborted();
   if(!proof||canonicalize({...proof,observedAt:0})!==canonicalize({...event,observedAt:0}))throw Error('Live dispatch evidence changed.');
   let reserved=0,refused=0,deferred=0;
   await visit(async row=>{
    if(!config.enabled()||!config.allows(row.wallet))return;
    const saved=await config.cas.read(row.planId,row.wallet),scope=saved?.value.grant.scope;
    if(!saved||!scope||saved.value.revoked||scope.leader!==event.leader||!scope.networks.includes(event.network)||now()>=scope.expiresAt)return;
    try{
     validateCashCopyEvent(event,scope,now());signal.throwIfAborted();if(!config.enabled())return;
     const journal=cashCopyJournal(config.cas,row.planId,row.wallet,now);
     if(event.side==='sell'&&await journal.queueSale(event)){if(config.pending)await config.pending(row.planId,row.wallet,signal);return;}
     let job;
     try{job=await journal.reserve(event);}catch(error){
      if(event.side!=='buy')throw error;
      if(await journal.queueBuy(event)){deferred++;if(config.pending)await config.pending(row.planId,row.wallet,signal);return;}
      // Funding can become credited between the failed reserve and queue CAS.
      // Retry once under the same validation instead of dropping that race.
      job=await journal.reserve(event);
     }
     reserved++;
     signal.throwIfAborted();if(config.enabled())await config.execute(row.planId,row.wallet,job.id,signal);
    }catch{refused++;}
   },signal);
   return{reserved,refused,deferred,paused:!config.enabled()};
  },
  async removed(network:CashCopyEvent['network'],transaction:string,blockHash:string,signal:AbortSignal){
   let invalidated=0;
   // A pause must not prevent invalidation or recovery of prior work.
   await visit(async row=>{const saved=await config.cas.read(row.planId,row.wallet);if(!saved||!Object.values(saved.value.jobs).some(j=>j.event.network===network&&j.event.transaction===transaction&&j.event.blockHash===blockHash)&&!Object.values(saved.value.pendingBuys||{}).some(p=>p.event.network===network&&p.event.transaction===transaction&&p.event.blockHash===blockHash)&&!Object.values(saved.value.pendingSales||{}).some(p=>p.event.network===network&&p.event.transaction===transaction&&p.event.blockHash===blockHash))return;
    invalidated+=await cashCopyJournal(config.cas,row.planId,row.wallet,now).invalidateLeader(transaction,blockHash,network);
   },signal);return{invalidated};
  },
 };
}
