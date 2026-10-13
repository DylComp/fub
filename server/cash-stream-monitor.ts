import {readCashLeaderProvisionalSale} from './cash-leader-sale.js';
import type {CashCopyEvent} from '../src/cash-copy-model.js';
import {cashLeaderStream,type CashLeaderHint} from './cash-leader-stream.js';
import {readCashLeaderFill} from './cash-leader-fill.js';
import {readCashLeaderProvisionalBalance} from './cash-leader-receipt.js';
import type {CashNetwork} from '../src/cash-route.js';
import type {cashLiveProof} from './cash-live-proof.js';
import {CashStatusUnavailable,type cashStatusProof} from './cash-status-proof.js';
import type {Rpc} from './funding.js';

/** Hosted shadow integration. Incoming events immediately wake bounded reads,
 * with no five-second observer timer or history API. Nothing here imports a
 * signer or broadcasts a transaction. Optional private callbacks remain behind
 * the independent execution gate; the default monitor is read-only.
 * This is deliberately separate from the still-finalized trading verifier. */
export function cashStreamMonitor(config:{
 targets:{network:CashNetwork;endpoint:string;leaders:string[];mode?:'logs'|'pendingLogs';heartbeat?:'heads'|'poll'}[];
 rpc:(network:CashNetwork,signal:AbortSignal)=>Rpc;now?:()=>number;
 stream?:typeof cashLeaderStream;
 read?:typeof readCashLeaderProvisionalBalance;
 inspect?:typeof readCashLeaderFill;
 onVerified?:(event:CashCopyEvent,signal:AbortSignal)=>Promise<unknown>;
 onRemoved?:(hint:CashLeaderHint)=>Promise<unknown>;
 readSale?:typeof readCashLeaderProvisionalSale;
 associate?:(balance:NonNullable<Awaited<ReturnType<typeof readCashLeaderProvisionalBalance>>>,fill:NonNullable<Awaited<ReturnType<typeof readCashLeaderFill>>>,signal:AbortSignal)=>ReturnType<typeof cashLiveProof>|ReturnType<typeof cashStatusProof>;
}){
 const now=config.now||Date.now,read=config.read||readCashLeaderProvisionalBalance;
 if(config.targets.length>6||new Set(config.targets.map(t=>t.network)).size!==config.targets.length)throw Error('Duplicate shadow stream network.');
 const queue=new Map<string,CashLeaderHint>(),active=new Map<string,AbortController>(),invalid=new Map<string,number>();
 const latencies:number[]=[],queueTimes:number[]=[],swapTimes:number[]=[];
 let sourceMissing=0,orderMissing=0,statusMissing=0,verifiedIntents=0,verifiedSales=0,associationRetries=0;
 const associationFailures={statusUnavailable:0,sourceUnavailable:0,invalidEvidence:0,deadline:0};
 const associationRejections:{network:CashNetwork;transaction:string;at:number;reason:string}[]=[];
 type ObservationStage='receipt'|'fill'|'association'|'sale'|'dispatch';
 const observationRejections:{network:CashNetwork;transaction:string;at:number;stage:ObservationStage;reason:string}[]=[];
 // Only fixed diagnostic codes leave this module. RPC errors can contain URLs,
 // credentials or arbitrary provider content, so never expose their messages.
 const observationCodes:Record<string,string>={
  'Wrong leader network.':'wrong-network',
  'Leader transaction does not match its receipt.':'receipt-binding',
  'Token logs do not match historical balances.':'balance-history',
  'Arc native calls differ.':'arc-native-calls',
  'Arc native scope differs.':'arc-native-scope',
  'Arc deployment changed.':'arc-deployment',
  'Arc native funding/deployment differs.':'arc-funding-deployment',
  'Arc native pool settlement differs.':'arc-pool-settlement',
  'Unsupported leader calldata.':'unsupported-calldata',
  'Unrecognized leader route.':'unrecognized-route',
 };
 function recordObservation(h:CashLeaderHint,stage:ObservationStage,error:unknown){
  observationRejections.push({network:h.network,transaction:h.transaction,at:now(),stage,reason:error instanceof Error?observationCodes[error.message]||'unclassified':'unclassified'});
  if(observationRejections.length>16)observationRejections.shift();
 }
 const rejectionCodes:Record<string,string>={'Invalid public status.':'invalid-status','Public status transaction binding differs.':'status-binding','Public intent status unavailable.':'status-http','Live status evidence differs.':'fill-binding','Source payment differs from fill.':'source-binding','Live fill is stale.':'stale-fill','Leader deposit accounts changed.':'deposit-accounts','Leader deposit commitment changed.':'deposit-commitment','Leader deposit balance mismatch.':'deposit-balance'};
 let retiring=false,closed=false,accepted=0,preconfirmations=0,verifiedBalances=0,verifiedSwaps=0,unclassified=0,expired=0,refused=0,gaps=0,removals=0,overloaded=0,lastEvidenceAt:number|null=null;
 const key=(h:CashLeaderHint)=>[h.network,h.leader,h.token,h.transaction,h.blockHash].join(':');
 const networks=new Set(config.targets.map(t=>t.network));
 function drain(){
  if(closed)return;
  while(active.size<2&&queue.size){
   const [id,hint]=queue.entries().next().value!;queue.delete(id);
   if(invalid.has(id)||now()-hint.receivedAt>1000||now()<hint.receivedAt){expired++;continue;}
   const controller=new AbortController();active.set(id,controller);
   const started=now();queueTimes.push(started-hint.receivedAt);if(queueTimes.length>256)queueTimes.shift();
   const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(3000)]);
   let rpc:Rpc,stage:ObservationStage='receipt';
   const readOne=async()=>{
    const base=config.rpc(hint.network,signal);rpc=async(method,params)=>{signal.throwIfAborted();const result=await base(method,params);signal.throwIfAborted();return result;};
    // Inclusion notifications can beat the HTTP reader by a few milliseconds.
    // Retry only missing evidence, never invalid evidence or a stale queue.
    for(let attempt=0;attempt<3;attempt++){
     const result=await read({network:hint.network,leader:hint.leader,token:hint.token,transaction:hint.transaction},rpc,now);
     if(result||attempt===2||now()-hint.receivedAt>750)return result;
     await new Promise<void>((resolve,reject)=>{
      signal.throwIfAborted();const abort=()=>{clearTimeout(timer);reject(Error('Observation cancelled.'));};
      const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},75);signal.addEventListener('abort',abort,{once:true});
     });
    }
    return null;
   };
   void readOne().then(async b=>{
    if(closed||signal.aborted||invalid.has(id))return;
    if(!b||b.blockHash!==hint.blockHash||b.blockNumber!==hint.blockNumber){refused++;return;}
    // A matched token balance is still NOT proof of a purchase or sale.
    if(b.tradeVerified!==false||b.confirmation!=='provisional')throw Error('Unexpected observation status.');
    verifiedBalances++;lastEvidenceAt=now();latencies.push(now()-hint.receivedAt);if(latencies.length>256)latencies.shift();
    if(BigInt(b.deltaRaw)>0n){
     try{
      stage='fill';const fill=await (config.inspect||readCashLeaderFill)(b,rpc);
      if(closed||signal.aborted||invalid.has(id))return;
      if(!fill){unclassified++;recordObservation(hint,stage,Error('Unrecognized leader route.'));return;}
      if(fill.tradeVerified!==false||fill.sourceAssociation!=='unverified')throw Error('Unexpected fill status.');
      verifiedSwaps++;
      if(config.associate){
       stage='association';
       // Provider indexing can lag inclusion. Keep the original hint and block,
       // and never extend the live event window or retry contradictory evidence.
       const deadline=Math.min(hint.receivedAt+9500,Number.isSafeInteger(b.blockTime)?b.blockTime+9500:hint.receivedAt+9500);
       if(now()>=deadline){associationFailures.deadline++;return;}
       const associationSignal=AbortSignal.any([controller.signal,AbortSignal.timeout(Math.max(1,deadline-now()))]);
       for(let attempt=0;attempt<24;attempt++){
        if(closed||retiring||associationSignal.aborted||invalid.has(id)||now()>=deadline){associationFailures.deadline++;return;}
        let association:Awaited<ReturnType<NonNullable<typeof config.associate>>>|undefined;
        try{
         association=await config.associate(b,fill,associationSignal);
         if(closed||retiring||associationSignal.aborted||invalid.has(id)||now()>=deadline)return;
         if(association.state==='awaiting-source')sourceMissing++;else if(association.state==='awaiting-status')statusMissing++;else if(association.state!=='verified'){orderMissing++;break;}
        }catch(error){
         if(closed||retiring||controller.signal.aborted||invalid.has(id))return;
         if(associationSignal.aborted||now()>=deadline){associationFailures.deadline++;return;}
         if(!(error instanceof CashStatusUnavailable)){associationFailures.invalidEvidence++;associationRejections.push({network:hint.network,transaction:hint.transaction,at:now(),reason:error instanceof Error?rejectionCodes[error.message]||'unclassified':'unclassified'});if(associationRejections.length>16)associationRejections.shift();throw error;}
         associationFailures[error.stage==='status'?'statusUnavailable':'sourceUnavailable']++;
        }
        if(association?.state==='verified'){verifiedIntents++;if(config.onVerified){stage='dispatch';await config.onVerified(association.event,AbortSignal.any([controller.signal,AbortSignal.timeout(12000)]));}break;}
        if(attempt===23||deadline-now()<=350)break;
        associationRetries++;
        await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(Error('Observation cancelled.'));};const timer=setTimeout(()=>{associationSignal.removeEventListener('abort',abort);resolve();},350);associationSignal.addEventListener('abort',abort,{once:true});if(associationSignal.aborted)abort();});
       }
      }
      swapTimes.push(now()-hint.receivedAt);if(swapTimes.length>256)swapTimes.shift();
     }catch(error){if(!closed){unclassified++;if(stage!=='association'&&!controller.signal.aborted)recordObservation(hint,stage,error);}}
    }else if(BigInt(b.deltaRaw)<0n){
     stage='sale';const sale=await(config.readSale||readCashLeaderProvisionalSale)({network:b.network,leader:b.leader,token:b.token,transaction:b.transaction},rpc,now);
     if(closed||signal.aborted||invalid.has(id))return;
     if(!sale||sale.event.blockHash!==b.blockHash){unclassified++;recordObservation(hint,stage,Error('Unrecognized leader route.'));return;}verifiedSales++;
     if(config.onVerified){stage='dispatch';await config.onVerified(sale.event,AbortSignal.any([controller.signal,AbortSignal.timeout(12000)]));}
    }
   }).catch(error=>{if(!closed){refused++;if(!controller.signal.aborted)recordObservation(hint,stage,error);}}).finally(()=>{active.delete(id);drain();});
  }
 }
 function hint(h:CashLeaderHint){
  if(closed||retiring||!networks.has(h.network))return;
  const id=key(h),time=now();for(const [k,t] of invalid)if(time-t>60000)invalid.delete(k);
  if(h.removed){removals++;if(config.onRemoved)void config.onRemoved(h).catch(()=>{refused++;});queue.delete(id);active.get(id)?.abort();if(invalid.size>=10000){for(const c of active.values())c.abort();queue.clear();overloaded++;return;}invalid.set(id,time);return;}
  if(h.confirmation==='preconfirmed'){preconfirmations++;return;}
  if(invalid.has(id)||active.has(id)||queue.has(id))return;
  if(queue.size>=64){overloaded++;return;}
  accepted++;queue.set(id,h);drain();
 }
 const streams=config.targets.map(t=>(config.stream||cashLeaderStream)({...t,mode:t.mode||(t.network==='base'?'pendingLogs':'logs'),now,onHint:hint,onGap:()=>{
  gaps++;for(const [id,h] of queue)if(h.network===t.network)queue.delete(id);
  for(const [id,c] of active)if(id.startsWith(t.network+':'))c.abort();
 }}));
 const percentile=(values:number[],p:number)=>{if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.ceil(sorted.length*p)-1];};
 return{
  start(){if(closed)throw Error('Monitor is closed.');for(const s of streams)s.start();},
  snapshot(){const statuses=streams.map(s=>s.status());return{mode:'shadow' as const,executionEnabled:false as const,status:!statuses.length?'unconfigured':statuses.every(s=>s.connected)?'connected':'degraded',streams:statuses,queued:queue.size,active:active.size,accepted,preconfirmations,verifiedBalances,verifiedSwaps,verifiedIntents,verifiedSales,associationRetries,associationFailures:{...associationFailures},associationRejections:associationRejections.map(r=>({...r})),observationRejections:observationRejections.map(r=>({...r})),sourceMissing,orderMissing,statusMissing,unclassified,refused,expired,gaps,removals,overloaded,lastEvidenceAt,queueDelayP95Ms:percentile(queueTimes,.95),balanceReadP50Ms:percentile(latencies,.5),balanceReadP95Ms:percentile(latencies,.95),balanceReadP99Ms:percentile(latencies,.99),swapReadP95Ms:percentile(swapTimes,.95),sampleSize:latencies.length};},
  retire(){retiring=true;for(const s of streams)s.close();},
  close(){closed=true;for(const s of streams)s.close();for(const c of active.values())c.abort();queue.clear();invalid.clear();},
 };
}
