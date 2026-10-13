import {copyReadRpc} from './copy-rpc.js';
import {executorRpc} from './copy-executor-rpc.js';
import type {Rpc} from './funding.js';

// Shared by the hosted signer and its recovery-only deployment. History reads
// use the read-only transport; neither role may broadcast through this wrapper.
export function cashCopySolanaRpc(endpoint:string):Rpc {
 return (method,params)=>{
  if(method==='sendTransaction')throw Error('Private signer cannot broadcast.');
  return ['getTransaction','getSignatureStatuses','getSignaturesForAddress','getBlock','getBlocks','getSlot','getFirstAvailableBlock'].includes(method)
   ?copyReadRpc(endpoint)(method,params)
   :executorRpc(endpoint,AbortSignal.timeout(8000))(method,params);
 };
}
