/** Bounded, process-local wakeup; durable journals remain the queue of record.
 * Versioning closes the scan/subscribe race. Reconnects always scan storage. */
export function cashDeliveryWakeup(){
 let version=0;const listeners=new Set<()=>void>();
 return{
  notify(){version++;for(const wake of [...listeners])wake();},
  async next<T>(read:()=>Promise<T|null>,signal:AbortSignal,waitMs=5000):Promise<T|null>{
   signal.throwIfAborted();const before=version,first=await read();if(first)return first;
   signal.throwIfAborted();if(version!==before)return read();
   if(listeners.size>=4)throw Error('Delivery wait capacity exceeded.');
   const changed=await new Promise<boolean>((resolve,reject)=>{
    let timer:ReturnType<typeof setTimeout>;
    const cleanup=()=>{clearTimeout(timer);listeners.delete(wake);signal.removeEventListener('abort',abort);};
    const wake=()=>{cleanup();resolve(true);},abort=()=>{cleanup();reject(Error('Delivery wait cancelled.'));};
    listeners.add(wake);signal.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>{cleanup();resolve(false);},waitMs);
    if(signal.aborted)abort();else if(version!==before)wake();
   });
   signal.throwIfAborted();return changed?read():null;
  },
  snapshot:()=>({waiters:listeners.size,version}),
 };
}
