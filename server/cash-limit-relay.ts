import {remoteCashLimitDelivery} from './isolated-signer-transport.js';
import {submitCashLimitDelivery} from './cash-limit-delivery.js';
import {executorRpc} from './copy-executor-rpc.js';
import {cashEvmRpc} from './cash-evm-rpc.js';
import {publicProviderJson} from './public-provider-json.js';
export function configuredCashLimitRelay(env:Record<string,string|undefined>){
 const flag=env.CASH_LIMIT_EXECUTION_ENABLED;if(flag===undefined||flag==='false')return undefined;
 if(flag!=='true'||env.VERCEL||env.VERCEL_ENV||env.COPY_EXECUTOR_ENABLED!=='true'||env.COPY_SIGNER_TRANSPORT!=='isolated')throw Error('Limit delivery requires the isolated executor.');
 const next=remoteCashLimitDelivery({origin:env.COPY_SIGNER_ORIGIN||'',token:env.COPY_SIGNER_TOKEN||''});
 return async(signal:AbortSignal)=>{
  const d=await next(signal);if(!d)return {state:'idle'};
  const active=AbortSignal.any([signal,AbortSignal.timeout(Math.max(1,d.expiresAt-Date.now()))]);
  return submitCashLimitDelivery(d,{solana:executorRpc(env.SOLANA_RPC_URL||'',active),evm:cashEvmRpc,enabled:()=>env.CASH_LIMIT_EXECUTION_ENABLED==='true',broadcast:async(signed,network)=>{
   const endpoint=env[`CASH_${network.toUpperCase()}_RPC_URL`];if(!endpoint)throw Error('Cash execution RPC missing.');const u=new URL(endpoint);if(u.protocol!=='https:'||u.username||u.password||u.hash)throw Error('Invalid cash execution RPC.');
   active.throwIfAborted();const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_sendRawTransaction',params:[signed]}),redirect:'error',signal:active});
   const body=await publicProviderJson(response) as any;if(body.error)throw Error('Cash submission is unresolved.');return body.result;
  }},active);
 };
}
