import type {CashNetwork} from '../src/cash-route.js';
import type {CashLeaderBinding} from './cash-copy-hosted.js';
/** Start replacements before retiring old ingress. Accepted work drains under
 * its original abort/permission boundaries; enrollment cannot abort a signer. */
export function cashDynamicStreams<T extends {start:()=>void;retire:()=>void;close:()=>void;snapshot:()=>any}>(config:{create:(network:CashNetwork,leaders:string[])=>T;networks:CashNetwork[]}){
 type Entry={key:string;monitor:T};const running=new Map<CashNetwork,Entry>(),pending=new Map<CashNetwork,Entry>(),retired=new Set<T>();let closed=false;
 const retire=(m:T)=>{m.retire();retired.add(m);};
 const associationCodes=new Set(['invalid-status','status-binding','status-http','fill-binding','source-binding','stale-fill','deposit-accounts','deposit-commitment','deposit-balance','unclassified']);
 const observationCodes=new Set(['wrong-network','receipt-binding','balance-history','arc-native-calls','arc-native-scope','arc-deployment','arc-funding-deployment','arc-pool-settlement','unsupported-calldata','unrecognized-route','unclassified']);
 const stages=new Set(['receipt','fill','association','sale','dispatch']);
 function rejections(snapshots:any[],key:'associationRejections'|'observationRejections'){
  const codes=key==='associationRejections'?associationCodes:observationCodes;
  return snapshots.flatMap(s=>(Array.isArray(s[key])?s[key].slice(-16):[]).flatMap((r:any)=>{
   if(!r||!config.networks.includes(r.network)||typeof r.transaction!=='string'||!/^0x[0-9a-f]{64}$/i.test(r.transaction)||!Number.isSafeInteger(r.at)||r.at<0||key==='observationRejections'&&!stages.has(r.stage))return[];
   // Project known public fields only; do not spread provider errors or URLs.
   return[{network:r.network,transaction:r.transaction,at:r.at,reason:codes.has(r.reason)?r.reason:'unclassified',...(key==='observationRejections'?{stage:r.stage}:{})}];
  })).sort((a,b)=>a.at-b.at).slice(-16);
 }
 const ready=(m:T)=>{const s=m.snapshot();return s.status==='connected'||s.streams?.length>0&&s.streams.every((v:any)=>v.connected);};
 return{
  update(bindings:CashLeaderBinding[]){
   if(closed)return;
   for(const m of retired){const s=m.snapshot();if(!s.active&&!s.queued){m.close();retired.delete(m);}}
   for(const network of config.networks){
    const leaders=[...new Set(bindings.filter(l=>l.networks.includes(network)).map(l=>l.wallet))].sort(),key=leaders.join(',');
    if(leaders.length>100)throw Error('Leader stream capacity exceeded.');
    const prior=running.get(network),replacement=pending.get(network);
    if(replacement&&replacement.key!==key){retire(replacement.monitor);pending.delete(network);}
    if(prior?.key===key)continue;
    if(!leaders.length){if(prior)retire(prior.monitor);running.delete(network);continue;}
    let next=pending.get(network);
    if(!next){const monitor=config.create(network,leaders);monitor.start();next={key,monitor};pending.set(network,next);}
    if(ready(next.monitor)){if(prior)retire(prior.monitor);running.set(network,next);pending.delete(network);}
   }
  },
  ready(leader:string,networks:CashNetwork[]){return networks.every(n=>{const e=running.get(n);return !!e&&e.key.split(',').includes(leader)&&ready(e.monitor);});},
  snapshot(){const snapshots=[...running.values()].map(r=>r.monitor.snapshot());
   const diagnosticSnapshots=[...new Set([...running.values(),...pending.values()].map(r=>r.monitor).concat([...retired]))].map(m=>m.snapshot());
   const streams=snapshots.flatMap(s=>s.streams||[]),sum=(key:string)=>snapshots.reduce((a,s)=>a+(typeof s[key]==='number'?s[key]:0),0);
   return{mode:'shadow',executionEnabled:false,associationRejections:rejections(diagnosticSnapshots,'associationRejections'),observationRejections:rejections(diagnosticSnapshots,'observationRejections'),status:pending.size?'connecting':!streams.length?'unconfigured':streams.every(s=>s.connected)?'connected':'degraded',streams,replacing:pending.size,draining:retired.size,...Object.fromEntries(['queued','active','accepted','preconfirmations','verifiedBalances','verifiedSwaps','verifiedIntents','verifiedSales','associationRetries','sourceMissing','orderMissing','statusMissing','unclassified','refused','expired','gaps','removals','overloaded','sampleSize'].map(k=>[k,sum(k)])),associationFailures:Object.fromEntries(['statusUnavailable','sourceUnavailable','invalidEvidence','deadline'].map(k=>[k,snapshots.reduce((total,s)=>total+(s.associationFailures?.[k]||0),0)])),lastEvidenceAt:Math.max(0,...snapshots.map(s=>s.lastEvidenceAt||0))||null};
  },
  close(){closed=true;for(const r of [...running.values(),...pending.values()])r.monitor.close();for(const m of retired)m.close();running.clear();pending.clear();retired.clear();},
 };
}
