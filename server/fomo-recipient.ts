import type { IncomingMessage, ServerResponse } from 'node:http';
import { address, isOffCurveAddress } from '@solana/kit';
import { isMint } from '../src/assets.js';
import { fomoHandle } from '../src/fomo-identity.js';
import { fomoAvatar } from '../src/fomo-recipient.js';
import type { FomoRecipient, FomoRecipientStats } from '../src/fomo-recipient.js';
import { fomoResolverStore } from './fomo-resolver-store.js';
const nowDate=(v:unknown,now:number)=>{const n=typeof v==='number'?v:typeof v==='string'?Date.parse(v):NaN;return Number.isSafeInteger(n)&&n>0&&n<=now?n:null;};
const record=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('Invalid profile');return v as Record<string,unknown>;};
export class RecipientUnavailable extends Error { constructor(readonly status=503,readonly code='provider_unavailable',readonly retryAfter?:number){super(code);} }
function wallet(v:unknown){if(v===null||v==='')return null;if(typeof v!=='string'||!isMint(v)||isOffCurveAddress(address(v)))throw Error('Invalid wallet');return v;}
export function parseRecipient(raw:unknown,handle:string,source:FomoRecipient['source'],now=Date.now()):FomoRecipient {
 const envelope=record(raw);if('demo' in envelope)throw Error('Demo data');const r=record(envelope.data??envelope);
 if(typeof r.handle!=='string'||r.handle.startsWith('@')||fomoHandle(r.handle)!==handle)throw Error('Mismatched profile');
 const a=wallet(source==='fomoscan.sh'?r.solanaAddress:r.solana);
 const name=source==='fomoscan.sh'?r.name:r.display_name;
 const observed=source==='fomoscan.sh'?nowDate(envelope.meta&&record(envelope.meta).asOf,now):nowDate(r.last_seen_at,now);
 return {handle,address:a,source,fetchedAt:now,observedAt:observed,displayName:typeof name==='string'&&name.trim()?name.trim().slice(0,100):handle,avatarUrl:fomoAvatar(source==='fomoscan.sh'?r.profilePicture:r.avatar_url),state:a?'matched':'unresolved',retryAfter:null,statsAvailable:false};
}
export function parseRecipientStats(raw:unknown,profile:FomoRecipient,now=Date.now()):FomoRecipientStats|null {
 const envelope=record(raw),r=record(envelope.data??envelope);
 if('demo' in envelope||typeof r.handle!=='string'||fomoHandle(r.handle)!==profile.handle||r.wallet!==profile.address)throw Error('Mismatched stats');
 if(r.status!=='ready')return null;
 const w=record(record(r.windows)['24h']);if(w.status!=='ready')return null;
 const updatedAt=nowDate(w.updatedAt,now);if(!updatedAt)return null;
 const count=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:null;
 return {handle:profile.handle,address:profile.address!,source:'fomoscan.sh',window:'24h',fetchedAt:now,updatedAt,pnlUsd:typeof w.totalPnlUsd==='number'&&Number.isFinite(w.totalPnlUsd)&&Math.abs(w.totalPnlUsd)<=1e12?w.totalPnlUsd:null,trades:count(w.trades),followers:count(r.followers)};
}
type Config={indexKey?:string;scanKey?:string;scanEnabled:boolean};
export function recipientService(config:()=>Config=()=>({indexKey:process.env.FOMO_LOOKUP_API_KEY,scanKey:process.env.FOMOSCAN_API_KEY,scanEnabled:process.env.FOMOSCAN_LOOKUP_ENABLED==='true'}), direct: (handle:string,enqueue:boolean)=>Promise<FomoRecipient|null> = async(handle,enqueue)=>{
 if(process.env.FOMO_DIRECT_LOOKUP_ENABLED!=='true'||!process.env.DATABASE_URL)return null;
 const store=fomoResolverStore(process.env.DATABASE_URL);
 const result=await store.lookup(handle,enqueue);
 if(!result){
  const unavailable=await store.availability();
  if(unavailable)throw new RecipientUnavailable(unavailable.code==='resolver_unavailable'?503:429,unavailable.code,unavailable.retryAfter);
  // A raced admission or exhausted job retry must not turn into a false 404.
  if(enqueue)throw new RecipientUnavailable(503,'resolver_unavailable',60);
 }
 return result;
}) {
 const cache=new Map<string,{expires:number;data:FomoRecipient}>(),pending=new Map<string,Promise<FomoRecipient>>();
 const statsCache=new Map<string,{expires:number;data:FomoRecipientStats|null}>(),statsPending=new Map<string,Promise<FomoRecipientStats|null>>();
 let scanBlockedUntil=0;
 async function read(url:string,key:string,method='GET') {
  const r=await fetch(url,{method,headers:{'X-API-Key':key,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(12000)});
  if(![200,202].includes(r.status)){await r.body?.cancel();if([401,402,403].includes(r.status)&&url.startsWith('https://api.fomoscan.sh/'))scanBlockedUntil=Date.now()+60000;throw new RecipientUnavailable(r.status===404?404:r.status===429?429:503,r.status===402?'provider_plan_required':'provider_unavailable');}
  if(!r.body)throw new RecipientUnavailable();const reader=r.body.getReader(),chunks:Uint8Array[]=[];let n=0;
  try{for(;;){const p=await reader.read();if(p.done)break;n+=p.value.length;if(n>65536)throw new RecipientUnavailable();chunks.push(p.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  return {status:r.status,data:JSON.parse(Buffer.concat(chunks).toString('utf8'))};
 }
 async function lookup(handle:string,resolve:boolean):Promise<FomoRecipient>{
  const c=config();let indexed:FomoRecipient|null=null,scanned:FomoRecipient|null=null,owned:FomoRecipient|null=null,last:unknown;
  const canScan=c.scanEnabled&&c.scanKey&&Date.now()>=scanBlockedUntil;
  const results=await Promise.allSettled([
   c.indexKey?read('https://api.fomoapi.dev/v1/wallets/'+encodeURIComponent(handle),c.indexKey).then(r=>parseRecipient(r.data,handle,'fomoapi.dev')):Promise.resolve(null),
   canScan?read('https://api.fomoscan.sh/v2/user/handle/'+encodeURIComponent(handle),c.scanKey!).then(r=>parseRecipient(r.data,handle,'fomoscan.sh')):Promise.resolve(null),
   direct(handle,resolve),
  ]);
  if(results[0].status==='fulfilled')indexed=results[0].value;else last=results[0].reason;
  if(results[1].status==='fulfilled')scanned=results[1].value;else if(!(last instanceof RecipientUnavailable)||last.status===404)last=results[1].reason;
  if(results[2].status==='fulfilled')owned=results[2].value;
  else if(!resolve)throw results[2].reason instanceof RecipientUnavailable?results[2].reason:new RecipientUnavailable();
  else if(!indexed?.address&&!scanned?.address)last=results[2].reason;
  // An owned conflict is sticky. Never hide it behind a successful third-party read.
  if(owned?.state==='conflict')return owned;
  const wallets=[indexed,scanned,owned].flatMap(p=>p?.address?[p.address]:[]);
  if(new Set(wallets).size>1)return {...(owned||scanned||indexed)!,address:null,state:'conflict',retryAfter:null,statsAvailable:false};
  if(indexed?.address&&scanned?.address&&indexed.address!==scanned.address)return {...scanned,address:null,state:'conflict'};
  let p=owned?.address?owned:scanned?.address?scanned:indexed?.address?indexed:owned||scanned||indexed;
  // Preserve existing profile metadata while a new owned lookup waits in the queue.
  if(owned?.state==='pending'&&!owned.observedAt&&!p?.address&&(scanned||indexed))p={...owned,displayName:(scanned||indexed)!.displayName,avatarUrl:(scanned||indexed)!.avatarUrl};
  if(!p?.address&&canScan&&resolve&&Date.now()>=scanBlockedUntil){
   try{const r=await read('https://api.fomoscan.sh/v2/user/handle/'+encodeURIComponent(handle)+'/resolve',c.scanKey!,'POST');
    if(r.status===202){const d=record(record(r.data).data??r.data);if(d.pending!==true)throw Error('Invalid pending response');p={...(p||{handle,address:null,source:'fomoscan.sh',fetchedAt:Date.now(),observedAt:null,displayName:handle,avatarUrl:null,statsAvailable:false}),state:d.retryable===false?'unresolved':'pending',retryAfter:d.retryable===false?null:Number.isSafeInteger(d.retryAfterSeconds)?Math.max(1,Math.min(300,d.retryAfterSeconds as number)):30};}
    else p=parseRecipient(r.data,handle,'fomoscan.sh');
   }catch(e){last=e;}
  }
  if(!p)throw last instanceof RecipientUnavailable?last:new RecipientUnavailable();
  return {...p,fetchedAt:Date.now(),...(owned?.profileStats?{displayName:owned.displayName,avatarUrl:owned.avatarUrl||p.avatarUrl,profileStats:{...owned.profileStats,source:'fomo-direct' as const}}:{}),profilePending:owned?.state==='pending',statsAvailable:!!(p.address&&p.source!=='fomo-direct'&&canScan&&Date.now()>=scanBlockedUntil)};
 }
 return {
  async refresh(handle:string){
   if(fomoHandle(handle)!==handle)throw new RecipientUnavailable(400);
   return lookup(handle,true);
  },
  async profile(handle:string,fresh=false){
   if(fomoHandle(handle)!==handle)throw new RecipientUnavailable(400);
   if(fresh)return lookup(handle,false);
   const hit=cache.get(handle);if(hit&&hit.expires>Date.now())return hit.data;
   let job=pending.get(handle);if(!job){job=lookup(handle,true).then(data=>{if(cache.size>=500)cache.delete(cache.keys().next().value!);cache.set(handle,{data,expires:Date.now()+(data.profilePending?5000:data.state==='matched'?60000:data.retryAfter?data.retryAfter*1000:15000)});return data;}).finally(()=>pending.delete(handle));pending.set(handle,job);}return job;
  },
  async stats(handle:string){
   const c=config();if(!c.scanEnabled||!c.scanKey||Date.now()<scanBlockedUntil)throw new RecipientUnavailable(503,'provider_plan_required');
   const p=await this.profile(handle);if(!p.address||!p.statsAvailable)throw new RecipientUnavailable();
   const id=handle+':'+p.address,hit=statsCache.get(id);if(hit&&hit.expires>Date.now())return hit.data;
   let job=statsPending.get(id);if(!job){job=read('https://api.fomoscan.sh/v2/user/handle/'+encodeURIComponent(handle)+'/pnl',c.scanKey).then(r=>parseRecipientStats(r.data,p)).then(data=>{if(statsCache.size>=500)statsCache.delete(statsCache.keys().next().value!);statsCache.set(id,{data,expires:Date.now()+(data?600000:60000)});return data;}).finally(()=>statsPending.delete(id));statsPending.set(id,job);}return job;
  },
 };
}
export const recipients=recipientService();
export function recipientHandler(service=recipients){
 let start=0,calls=0,pending=0;
 return async(req:IncomingMessage,res:ServerResponse)=>{
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  const send=(status:number,value:unknown)=>{res.statusCode=status;res.end(JSON.stringify(value));};
  if(req.method!=='GET')return send(405,{message:'GET required.'});
  const q=new URL(req.url||'/','https://localhost').searchParams,action=q.get('action'),raw=q.get('handle')||'',handle=fomoHandle(raw);
  if(!handle||raw!==handle||[...q.keys()].sort().join()!=='action,handle'||!['recipient','recipient-stats'].includes(action||''))return send(400,{message:'Enter a Fomo username.'});
  if(Date.now()-start>=60000){start=Date.now();calls=0;}if(calls>=20||pending>=3){res.setHeader('Retry-After','60');return send(429,{message:'Too many profile checks. Try again in a minute.'});}calls++;pending++;
  try{return action==='recipient-stats'?send(200,{stats:await service.stats(handle)}):send(200,await service.profile(handle));}
  catch(e){
   const status=e instanceof RecipientUnavailable?e.status:503;
   const retry=e instanceof RecipientUnavailable&&Number.isInteger(e.retryAfter)&&e.retryAfter!>0?Math.min(86400,e.retryAfter!):null;
   if(retry)res.setHeader('Retry-After',String(retry));
   const code=e instanceof RecipientUnavailable?e.code:'';
   const message=code==='resolver_daily_limit'?'New username lookups have reached their daily limit. Try again after the retry time.':code==='resolver_queue_full'?'Username lookup is busy. Try again in a minute.':status===404?'No profile was found for this username. Check the spelling or open their Fomo profile.':status===429?'The profile provider is busy. Try again shortly.':'Fomo profile lookup is temporarily unavailable. Try again shortly.';
   return send(status,{message,...(retry?{retryAfter:retry}:{})});
  }
  finally{pending--;}
 };
}
export const handleRecipient=recipientHandler();
