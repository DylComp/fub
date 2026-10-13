import {setTimeout as delay} from 'node:timers/promises';
/** The remote read holds until work arrives. No poll sleep follows delivery;
 * a small floor handles older servers that return idle immediately. */
export async function runCashDelivery(tick:(signal:AbortSignal)=>Promise<unknown>,signal:AbortSignal,onError:()=>void){
 let failures=0;
 while(!signal.aborted){
  const started=Date.now();let pause=0;
  try{await tick(AbortSignal.any([signal,AbortSignal.timeout(18000)]));failures=0;pause=Math.max(0,500-(Date.now()-started));}
  catch{if(signal.aborted)return;failures++;onError();pause=Math.min(10000,250*2**Math.min(failures,5));}
  if(pause)try{await delay(pause,undefined,{signal});}catch{if(signal.aborted)return;throw Error('Cash delivery interrupted.');}
 }
}
