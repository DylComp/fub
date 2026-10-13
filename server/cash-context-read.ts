import {ChainRpcError,type Rpc} from './funding.js';

// A pooled RPC may route the next read to a replica behind minContextSlot.
// Retry the identical read, keeping its finality, message and slot intact.
// Never use this helper to retry a submission or soften a simulation error.
export async function cashContextRead(rpc:Rpc,method:string,params:unknown[],sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))){
 if(!['getMultipleAccounts','getFeeForMessage','simulateTransaction'].includes(method))throw Error('Unsupported cash context read.');
 for(let attempt=0;;attempt++){
  try{return await rpc(method,params);}
  catch(error){
   if(!(error instanceof ChainRpcError)||error.code!==-32016||attempt>=3)throw error;
   await sleep(250*2**attempt);
  }
 }
}
