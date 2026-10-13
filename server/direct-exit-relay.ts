import {setTimeout as delay} from 'node:timers/promises';
import type {Rpc} from './funding.js';
import type {ExitDelivery} from './direct-exit-delivery.js';
import {submitDirectExit} from './direct-exit-delivery.js';
// Call from the existing executor process. The RPC factory creates one bounded
// send transport per iteration. No local order IDs can mint a new transaction.
export async function relayDirectExit(config:{enabled:()=>boolean;next:(signal:AbortSignal)=>Promise<ExitDelivery|null>;rpc:(signal:AbortSignal)=>Rpc},signal:AbortSignal){
 if(!config.enabled())return {state:'disabled' as const};
 signal.throwIfAborted();const d=await config.next(signal);
 if(!d)return {state:'idle' as const};
 const active=AbortSignal.any([signal,AbortSignal.timeout(Math.max(1,d.expiresAt-Date.now()))]);
 active.throwIfAborted();if(!config.enabled())return {state:'disabled' as const};
 await submitDirectExit(d,config.rpc(active),active);
 return {state:'submitted' as const,id:d.id,signature:d.signature};
}

export async function runDirectExitRelay(tick:(signal:AbortSignal)=>Promise<unknown>,signal:AbortSignal,onError:()=>void){
 while(!signal.aborted){
  try{await tick(AbortSignal.any([signal,AbortSignal.timeout(12000)]));}
  catch{if(signal.aborted)break;onError();}
  try{await delay(3000,undefined,{signal});}catch{if(signal.aborted)break;throw Error('Direct exit relay interrupted.');}
 }
}

// A direct exit already carries a privately verified signed transaction. Relaying
// it needs no copy quote key and must not require enabling unrelated copy buys.
export function exitRelayEnabled(env:Record<string,string|undefined>,remote:boolean){
 const flag=env.DIRECT_EXIT_EXECUTION_ENABLED;
 if(flag===undefined||flag==='false')return false;
 if(flag!=='true'||!remote||env.COPY_SIGNER_TRANSPORT!=='isolated'||env.COPY_EXECUTOR_ENABLED!=='true'||env.VERCEL||env.VERCEL_ENV||!['recover','execute'].includes(env.COPY_EXECUTOR_MODE||'recover'))throw Error('Direct exits require an explicit isolated relay.');
 if((env.COPY_EXECUTOR_MODE||'recover')==='recover'&&(env.COPY_EXECUTION_ENABLED==='true'||env.COPY_NATIVE_EXECUTION_ENABLED==='true'))throw Error('Exit-only relay cannot enable copy execution.');
 return true;
}
