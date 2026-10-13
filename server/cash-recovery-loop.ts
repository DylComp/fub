import {setTimeout as delay} from 'node:timers/promises';
// Read-only reconciliation continues when execution is disabled. Each ledger
// handles its own errors; one unavailable chain must not stop other workers.
export async function runCashRecovery(work:()=>Promise<unknown>,signal:AbortSignal,report:(healthy:boolean)=>void,intervalMs=60000){
 if(!Number.isSafeInteger(intervalMs)||intervalMs<1000)throw Error('Invalid cash recovery interval.');
 while(!signal.aborted){try{await work();report(true);}catch{report(false);}try{await delay(intervalMs,undefined,{signal});}catch{if(!signal.aborted)throw Error('Cash recovery timer failed.');}}
}
