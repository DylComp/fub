const pause=(signal:AbortSignal,ms=500)=>new Promise<void>((resolve,reject)=>{
 const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(Error('Follow-up cancelled.'));};
 const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);
 signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
});
/** Short, bounded follow-up after a live event. Durable periodic recovery is
 * still responsible for restarts, long bridges, and unavailable evidence. */
export function cashFastFollowup(shutdown:AbortSignal,enabled:()=>boolean){
 const running=new Map<string,Promise<void>>();
 return {
  start(key:string,tick:(signal:AbortSignal)=>Promise<boolean>){
   if(shutdown.aborted||!enabled()||running.has(key)||running.size>=8)return false;
   const signal=AbortSignal.any([shutdown,AbortSignal.timeout(60000)]);
   const task=Promise.resolve().then(async()=>{
    let failures=0;
    while(!signal.aborted&&enabled()){
     try{if(!await tick(signal))return;failures=0;}
     catch{signal.throwIfAborted();if(++failures>3)return;await pause(signal,500*2**(failures-1));continue;}
     await pause(signal);
    }
   }).catch(()=>{/* No failed check authorizes a sale. Durable recovery handles exhaustion. */}).finally(()=>{running.delete(key);});
   running.set(key,task);return true;
  },
  snapshot:()=>({active:running.size}),
 };
}
