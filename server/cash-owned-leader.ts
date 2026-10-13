import {isMint} from '../src/assets.js';
import {fomoHandle} from '../src/fomo-identity.js';
import type {CashNetwork} from '../src/cash-route.js';
import type {CashLeaderBinding} from './cash-copy-hosted.js';
/** Credentials stay on the private Fly network; callers select an identity,
 * never an endpoint, cookie, session or EVM address. */
export function ownedCashLeaderLookup(origin:string,secret:string,networks:CashNetwork[],fetcher=fetch){
 if(origin!=='http://fub-fomo-resolver.internal:8080'||!/^[A-Za-z0-9_-]{32,128}$/.test(secret))throw Error('Private Fomo lookup configuration is invalid.');
 return async(source:string,signal:AbortSignal,handle?:string):Promise<CashLeaderBinding>=>{
  if(!isMint(source)||!handle||fomoHandle(handle)!==handle)throw Error('Select a verified Fomo username for cross-chain copying.');
  const active=AbortSignal.any([signal,AbortSignal.timeout(7000)]);
  const r=await fetcher(origin+'/leader?handle='+encodeURIComponent(handle),{headers:{Authorization:'Bearer '+secret,Accept:'application/json'},redirect:'error',signal:active});
  if(!r.ok||!r.body||Number(r.headers.get('content-length'))>8192){void r.body?.cancel();throw Error('Fomo trading-wallet lookup is unavailable.');}
  const reader=r.body.getReader();let size=0;const parts:Uint8Array[]=[];
  const cancel=()=>{void reader.cancel().catch(()=>{});};active.addEventListener('abort',cancel,{once:true});
  try{
   for(;;){active.throwIfAborted();const chunk=await reader.read();active.throwIfAborted();if(chunk.done)break;size+=chunk.value.length;if(size>8192)throw Error('Fomo profile response is too large.');parts.push(chunk.value);}
   const p=JSON.parse(Buffer.concat(parts).toString('utf8'));
   if(p.source!=='fomo-direct'||p.handle!==handle||!isMint(p.sourceWallet)||source!==p.sourceWallet&&source!==p.recipientWallet||!/^0x[0-9a-f]{40}$/.test(p.wallet)||/^0x0{40}$/.test(p.wallet)||!Number.isSafeInteger(p.observedAt)||p.observedAt>Date.now()+1000||Date.now()-p.observedAt>120000)throw Error('Fomo trading-wallet mapping changed or expired.');
   return {sourceWallet:p.sourceWallet,wallet:p.wallet,networks:[...networks],profileHandle:handle};
  }finally{active.removeEventListener('abort',cancel);cancel();reader.releaseLock();}
 };
}
