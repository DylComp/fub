type WaitingQuote={input:Parameters<typeof fetch>[0];init:Parameters<typeof fetch>[1];signal:AbortSignal|null|undefined;resolve:(response:Response)=>void;reject:(reason:unknown)=>void;abort:()=>void};
// One host-wide start budget shared by both direct-exit adapters. Expired
// requests leave the queue immediately, even behind another request's cooldown.
// Provider 429s are never retried with an old transaction intent.
export function pacedQuoteFetch(fetcher:typeof fetch=fetch):typeof fetch{
 let nextAt=0,timer:ReturnType<typeof setTimeout>|undefined;
 const queue:WaitingQuote[]=[];
 function drain(){
  if(timer){clearTimeout(timer);timer=undefined;}
  if(!queue.length)return;
  const wait=nextAt-Date.now();
  if(wait>0){timer=setTimeout(drain,Math.min(60000,wait));return;}
  const entry=queue.shift()!;
  entry.signal?.removeEventListener('abort',entry.abort);
  if(entry.signal?.aborted){entry.reject(entry.signal.reason??Error('Quote request aborted.'));drain();return;}
  nextAt=Date.now()+1000;
  void Promise.resolve().then(()=>{entry.signal?.throwIfAborted();return fetcher(entry.input,entry.init);}).then(response=>{
   if(response.status===429){
    const raw=response.headers.get('retry-after');
    const seconds=raw&&/^\d+(?:\.\d+)?$/.test(raw)?Number(raw):raw?(Date.parse(raw)-Date.now())/1000:NaN;
    const wait=Number.isFinite(seconds)?Math.max(1,seconds):5;
    nextAt=Math.max(nextAt,Math.min(Number.MAX_SAFE_INTEGER,Date.now()+wait*1000));
    drain();
   }
   entry.resolve(response);
  },entry.reject);
  drain();
 }
 return async(input,init)=>{
  const signal=init?.signal??(input instanceof Request?input.signal:undefined);
  signal?.throwIfAborted();
  if(queue.length>=8)throw Error('Quote queue is full.');
  return new Promise<Response>((resolve,reject)=>{
   const entry:WaitingQuote={input,init,signal,resolve,reject,abort:()=>{
    const index=queue.indexOf(entry);
    if(index<0)return;
    queue.splice(index,1);signal?.removeEventListener('abort',entry.abort);
    reject(signal?.reason??Error('Quote request aborted.'));drain();
   }};
   queue.push(entry);signal?.addEventListener('abort',entry.abort,{once:true});
   if(signal?.aborted)entry.abort();else drain();
  });
 };
}
