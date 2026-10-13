import {isMint} from '../src/assets.js';
import {fomoHandle} from '../src/fomo-identity.js';
import {isCashNetwork,type CashNetwork} from '../src/cash-route.js';
import type {CashLeaderBinding} from './cash-copy-hosted.js';
/** Provider attribution is not ownership. Every copied trade still proves its
 * source payment, destination wallet and swap independently on chain. */
export function parseCashLeaderProfile(raw:unknown,sourceWallet:string,networks:CashNetwork[]):CashLeaderBinding{
 const b=raw as any;
 if(!isMint(sourceWallet)||!b||typeof b!=='object'||Array.isArray(b)||b.demo!==undefined||!Array.isArray(b.data)||!b.data.length||b.data.length>20||b.count!==b.data.length)throw Error('Fomo leader mapping unavailable.');
 const seen=new Set<string>(),evms=new Set<string>();
 for(const p of b.data){const handle=typeof p?.handle==='string'?fomoHandle(p.handle):null;
  if(!handle||seen.has(handle)||p.solana!==sourceWallet||typeof p.evm!=='string'||!/^0x[0-9a-f]{40}$/i.test(p.evm)||/^0x0{40}$/i.test(p.evm))throw Error('Fomo leader mapping is incomplete or conflicting.');
  seen.add(handle);evms.add(p.evm.toLowerCase());
 }
 if(evms.size!==1)throw Error('Fomo leader mapping is conflicting.');
 return{sourceWallet,wallet:[...evms][0],networks:[...networks]};
}
export function cashLeaderProfileLookup(key:string,networks:CashNetwork[],fetcher=fetch){
 let inFlight=0;const starts:number[]=[];
 return async(sourceWallet:string,signal:AbortSignal)=>{
  signal.throwIfAborted();
  if(!isMint(sourceWallet))throw Error('Invalid Fomo source wallet.');
  const now=Date.now();while(starts.length&&starts[0]<=now-60000)starts.shift();
  if(inFlight>=4||starts.length>=30)throw Error('Fomo lookup is busy. Try again shortly.');
  starts.push(now);inFlight++;
  try{
  const active=AbortSignal.any([signal,AbortSignal.timeout(5000)]);
  const r=await fetcher('https://api.fomoapi.dev/v1/lookup/solana/'+sourceWallet,{headers:{'X-API-Key':key,Accept:'application/json'},redirect:'error',signal:active});
  if(!r.ok||!r.body||Number(r.headers.get('content-length'))>65536){void r.body?.cancel();throw Error('Fomo leader lookup unavailable.');}
  const reader=r.body.getReader(),parts:Uint8Array[]=[];let size=0;
  const cancel=()=>{void reader.cancel().catch(()=>{});};active.addEventListener('abort',cancel,{once:true});
  try{active.throwIfAborted();for(;;){const p=await reader.read();active.throwIfAborted();if(p.done)break;size+=p.value.length;if(size>65536)throw Error('Fomo lookup is too large.');parts.push(p.value);}return parseCashLeaderProfile(JSON.parse(Buffer.concat(parts).toString('utf8')),sourceWallet,networks);}
  finally{active.removeEventListener('abort',cancel);cancel();reader.releaseLock();}
  }finally{inFlight--;}
 };
}
/** Active permissions pin a mapping. A provider refresh cannot silently move a
 * followed trader. Restoration reads only the isolated host's accepted grants. */
export function cashLeaderRegistry(initial:CashLeaderBinding[],lookup?:(source:string,signal:AbortSignal,handle?:string)=>Promise<CashLeaderBinding>){
 const rows=new Map<string,CashLeaderBinding>(),expiries=new Map<string,number>(),candidates=new Map<string,{binding:CashLeaderBinding;expires:number}>();
 let version=0;
 function prune(){for(const [source,until] of expiries)if(until<=Date.now()){rows.delete(source);expiries.delete(source);version++;}}
 function put(l:CashLeaderBinding,expiresAt=Infinity){
  prune();
  if(!isMint(l.sourceWallet)||!/^0x[0-9a-f]{40}$/.test(l.wallet)||/^0x0{40}$/.test(l.wallet)||!Array.isArray(l.networks)||!l.networks.length||l.networks.some(n=>!isCashNetwork(n)))throw Error('Invalid leader binding.');
  const old=rows.get(l.sourceWallet),evm=[...rows.values()].find(r=>r.wallet===l.wallet);
  if(old&&old.wallet!==l.wallet||evm&&evm.sourceWallet!==l.sourceWallet)throw Error('Leader mapping changed; review the existing plan.');
  if(!old&&rows.size>=100)throw Error('Leader monitoring capacity reached.');
  version++;expiries.set(l.sourceWallet,Math.max(expiries.get(l.sourceWallet)||0,expiresAt));
  rows.set(l.sourceWallet,old?{...old,networks:[...new Set([...old.networks,...l.networks])]}:structuredClone(l));return structuredClone(rows.get(l.sourceWallet)!);
 }
 for(const l of initial)put(l);
 return{version:()=>version,replace:(expected:number,bindings:{binding:CashLeaderBinding;expiresAt:number}[])=>{if(version!==expected)return false;const next=cashLeaderRegistry([]);for(const row of bindings)next.restore(row.binding,row.expiresAt);rows.clear();expiries.clear();version++;for(const row of bindings)put(row.binding,row.expiresAt);return true;},find:(evm:string)=>{prune();return [...rows.values(),...[...candidates.values()].filter(v=>v.expires>Date.now()).map(v=>v.binding)].find(l=>l.wallet===evm);},snapshot:()=>{prune();return [...rows.values()].map(l=>structuredClone(l));},source:(evm:string,network?:CashNetwork)=>{prune();return [...rows.values()].find(l=>l.wallet===evm&&(!network||l.networks.includes(network)))?.sourceWallet||null;},
  restore:put,
  async resolve(source:string,signal:AbortSignal,handle?:string){if(!lookup){const l=rows.get(source);if(!l)throw Error('Leader mapping has not been verified.');return structuredClone(l);}const l=await lookup(source,signal,handle||candidates.get(source)?.binding.profileHandle||rows.get(source)?.profileHandle),old=rows.get(source)||rows.get(l.sourceWallet);if(old&&(old.wallet!==l.wallet||old.sourceWallet!==l.sourceWallet))throw Error('Leader mapping changed; review the existing plan.');
   if(candidates.size>=100)candidates.delete(candidates.keys().next().value!);candidates.set(l.sourceWallet,{binding:l,expires:Date.now()+300000});return l;},
 };
}
