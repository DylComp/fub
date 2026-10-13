import type { LaunchExecutionStore } from './launch-execution-store.js';
import type { LaunchExecutionChain } from './launch-execution-chain.js';

// The wallet signs outside this service. There is no mint key or user signing
// credential here. Every send uses the same durably saved, fully signed bytes.
export function launchExecutionService(store:LaunchExecutionStore,chain:LaunchExecutionChain,maySend:()=>boolean){
 async function recover(id:string,owner:string,send=false){
  const claimed=await store.claim(id,owner);if(!claimed)return store.get(id,owner);
  const {attempt,lease}=claimed;
  try{
   if(!attempt.signed)throw Error('Missing signed launch.');
   const checked=attempt.nonlandingProof?{kind:'expired_unresolved' as const,nonlandingProof:attempt.nonlandingProof}:await chain.reconcile(attempt.plan,attempt.signed);
   const result=attempt.state==='expired_unresolved'&&checked.kind==='pending'?{kind:'expired_unresolved' as const}:checked;
   await store.settle(id,lease,result);
   if(result.kind==='pending'&&send&&maySend()){
    // Persist before the network call: a timeout remains recoverable. No new
    // signature, blockhash or mint is generated when the response is unknown.
    await store.submitted(id,lease);
    await chain.send(attempt.plan,attempt.signed);
   }
   return await store.get(id,owner);
  }catch(error){await store.failedCheck?.(id,lease);throw error;}finally{await store.release(id,lease);}
 }
 return {
  recover,
  async submit(id:string,owner:string,signed:string){
   // Even if launch sending is paused, retain an already-signed attempt for
   // recovery. The owner may also have submitted it through their wallet.
   await store.bind(id,owner,signed);return recover(id,owner,true);
  },
  async sweep(signal?:AbortSignal){signal?.throwIfAborted();const results=[];for(const a of await store.due()){if(signal?.aborted)break;try{await recover(a.id,a.owner,false);results.push({id:a.id,checked:true});}catch{results.push({id:a.id,checked:false});}}return results;},
 };
}
