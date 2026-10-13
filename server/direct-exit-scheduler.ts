import type {DirectExitRecord,DirectExitStore} from './direct-exit-store.js';

export const EXIT_OBSERVATION_CONCURRENCY=4;
export const EXIT_OBSERVATION_BATCH=12;
// Each lane claims only when it has capacity. Slow orders cannot hold an entire
// batch, and database leases prevent concurrent hosts from claiming the same row.
export function directExitScheduler(config:{
 store:Pick<DirectExitStore,'watching'|'releaseObservation'>;
 enabled:()=>boolean;allows:(wallet:string)=>boolean;
 tick:(id:string,signal:AbortSignal)=>Promise<unknown>;
}){
 let running=false;
 return async(signal:AbortSignal)=>{
  if(running||!config.enabled())return {checked:0,refused:0};
  running=true;let claimed=0,checked=0,refused=0;
  const lane=async()=>{
   while(!signal.aborted&&config.enabled()&&claimed<EXIT_OBSERVATION_BATCH){
    // Reserve the attempt synchronously before yielding to another lane.
    claimed++;
    const [row]:DirectExitRecord[]=await config.store.watching(1);
    if(!row)return;
    try{
     signal.throwIfAborted();
     if(!config.enabled()||!config.allows(row.terms.wallet))continue;
     checked++;
     try{await config.tick(row.terms.id,signal);}catch{signal.throwIfAborted();refused++;}
    }finally{await config.store.releaseObservation(row);}
   }
  };
  try{
   // Wait for every lane, including persistence after late provider responses.
   // Never declare the loop finished while another lane can still save a result.
   const outcomes=await Promise.allSettled(Array.from({length:EXIT_OBSERVATION_CONCURRENCY},lane));
   signal.throwIfAborted();
   if(outcomes.some(r=>r.status==='rejected'))throw Error('Exit observation queue unavailable.');
   return {checked,refused};
  }finally{running=false;}
 };
}

export type ExitQueueCounts={watching:number;leased:number;due:number;oldestDueMs:number};
export function exitQueueHealth(now:()=>number=Date.now){
 let checkedAt:number|null=null,counts:ExitQueueCounts|null=null,failed=false;
 return {
  complete(value:ExitQueueCounts){
   if(Object.keys(value).sort().join(',')!=='due,leased,oldestDueMs,watching'||Object.values(value).some(n=>!Number.isSafeInteger(n)||n<0)||value.due+value.leased>value.watching)throw Error('Invalid exit queue counts.');
   counts={...value};checkedAt=now();failed=false;
  },
  fail(){failed=true;},
  snapshot(enabled:boolean){
   const status=!enabled?'disabled':failed?'unavailable':checkedAt===null?'starting':now()<checkedAt||now()-checkedAt>45000?'stale':counts!.oldestDueMs>15000?'backlogged':'healthy';
   return {status,checkedAt,counts:counts?{...counts}:null,concurrency:EXIT_OBSERVATION_CONCURRENCY,batchLimit:EXIT_OBSERVATION_BATCH};
  },
 };
}
