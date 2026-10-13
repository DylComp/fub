import type {IncomingMessage,ServerResponse} from 'node:http';
import {isMint} from '../src/assets.js';
import {SOL_PAIR_MINT} from '../src/launch-pairs.js';
import {freshMarketTime,freshMarketSupply,validTokenMarket,type TokenMarket} from '../src/token-market-model.js';
import type {CurveMarket} from './token-market-pump.js';
type DexMarket={price:number|null;volume:number|null;liquidity:number|null;pair:string;dex:string};
const amount=(v:unknown)=>typeof v==='number'||typeof v==='string'&&v.trim()!==''?Number.isFinite(Number(v))&&Number(v)>=0?Number(v):null:null;
export function dexMarketPairs(raw:unknown,mint:string):DexMarket[]{
 if(!Array.isArray(raw))throw Error('Invalid market response');
 const seen=new Set<string>();
 return raw.slice(0,100).flatMap(p=>{
  if(!p||p.chainId!=='solana'||p.baseToken?.address!==mint||!isMint(p.pairAddress)||seen.has(p.pairAddress))return[];
  seen.add(p.pairAddress);const price=amount(p.priceUsd);
  return[{price:price&&price>0?price:null,volume:amount(p.volume?.h24),liquidity:amount(p.liquidity?.usd),pair:p.pairAddress,dex:typeof p.dexId==='string'?p.dexId:''}];
 }).sort((a,b)=>(b.liquidity??-1)-(a.liquidity??-1)||(b.volume??-1)-(a.volume??-1)||a.pair.localeCompare(b.pair));
}
async function fetchDex(mint:string){
 const r=await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${mint}`,{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(6000)});
 if(!r.ok||!r.body||Number(r.headers.get('content-length'))>1048576)throw Error('Market provider unavailable');
 const reader=r.body.getReader(),parts:Uint8Array[]=[];let size=0;
 try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>1048576)throw Error('Market response too large');parts.push(value);}}finally{await reader.cancel();}
 return{pairs:dexMarketPairs(JSON.parse(Buffer.concat(parts).toString('utf8')),mint),checkedAt:Date.now()};
}
type DexReply=Awaited<ReturnType<typeof fetchDex>>;
export function tokenMarketService(options:{dex?:(mint:string)=>Promise<DexReply>;curve?:(mint:string)=>Promise<CurveMarket>;now?:()=>number}={}){
 const now=options.now||Date.now,dex=options.dex||fetchDex;
 const cache=new Map<string,TokenMarket>(),pending=new Map<string,Promise<TokenMarket>>();
 let sol: DexReply|null=null,solPending:Promise<DexReply>|null=null;
 async function solUsd(){if(sol&&now()-sol.checkedAt<10000)return sol;if(!solPending)solPending=dex(SOL_PAIR_MINT).then(r=>(sol=r)).finally(()=>{solPending=null;});return solPending;}
 async function load(mint:string):Promise<TokenMarket>{
  const [ds,cs,ss]=await Promise.allSettled([dex(mint),(options.curve|| (async m=>(await import('./token-market-pump.js')).readPumpMarket(m)))(mint),solUsd()]);
  if(cs.status==='rejected'&&process.env.VERCEL_ENV==='production'){
   const message=cs.reason instanceof Error?cs.reason.message:'';
   const reason=['Stale market RPC','Inconsistent market slots','Invalid curve accounts','Market RPC unavailable'].includes(message)?message:/429|rate.limit/i.test(message)?'rate_limit':/timeout|abort/i.test(message)?'timeout':'upstream_read_failed';
   console.warn(JSON.stringify({event:'token_market_curve_unavailable',mint,reason}));
  }
  const at=now(),d=ds.status==='fulfilled'&&freshMarketTime(ds.value.checkedAt,at)?ds.value:null;
  const curve=cs.status==='fulfilled'?cs.value:null;
  const previous=cache.get(mint);
  const retained=cs.status==='rejected'&&previous?.curve&&previous.price?.source==='pump-curve'&&previous.price.sol!==null&&freshMarketTime(previous.curve.checkedAt,at)&&freshMarketTime(previous.price.checkedAt,at)?{state:'active' as const,priceSol:previous.price.sol,...previous.curve}:null;
  const active=curve?.state==='active'&&freshMarketTime(curve.checkedAt,at)?curve:retained;
  const pairs=d?.pairs||[],pool=(active?pairs.find(p=>p.dex==='pumpfun'):curve?.state==='complete'?pairs.find(p=>p.dex!=='pumpfun'):pairs[0])||null;
  const solPrice=ss.status==='fulfilled'&&freshMarketTime(ss.value.checkedAt,at)?ss.value.pairs.find(p=>p.price!==null)?.price:null;
  const converted=active&&solPrice?active.priceSol*solPrice:null;
  const usd=converted!==null&&Number.isFinite(converted)&&converted>0?converted:null;
  const price:TokenMarket['price']=active?{sol:active.priceSol,usd,source:'pump-curve',checkedAt:active.checkedAt,usdCheckedAt:usd!==null&&ss.status==='fulfilled'?Math.min(active.checkedAt,ss.value.checkedAt):null}:pool?.price?{usd:pool.price,sol:null,source:'dexscreener',checkedAt:d!.checkedAt,usdCheckedAt:d!.checkedAt}:null;
  return{mint,fetchedAt:at,supply:freshMarketSupply(curve?.supply,at)?curve!.supply:null,solUsd:solPrice&&ss.status==='fulfilled'?{value:solPrice,checkedAt:ss.value.checkedAt}:null,curveUnavailable:cs.status==='rejected',refreshDelayed:cs.status==='rejected'||ds.status==='rejected'||!!active&&ss.status==='rejected',price,volume24h:pool?.volume!==null&&pool?.volume!==undefined?{value:pool.volume,checkedAt:d!.checkedAt}:null,liquidity:!active&&pool?.liquidity!==null&&pool?.liquidity!==undefined?{value:pool.liquidity,checkedAt:d!.checkedAt}:null,curve:active?{reservesSol:active.reservesSol,slot:active.slot,checkedAt:active.checkedAt}:null,dexPair:pool?.pair||null};
 }
 return async(mint:string)=>{
  if(!isMint(mint))throw Error('Invalid mint');
  const hit=cache.get(mint);if(hit&&now()-hit.fetchedAt<10000&&validTokenMarket(hit,mint,now()))return hit;
  if(!pending.has(mint)){
   if(pending.size>=8)throw Error('Market checks busy');
   const task=load(mint).then(r=>{if(cache.size>=200)cache.delete(cache.keys().next().value!);cache.set(mint,r);return r;}).finally(()=>pending.delete(mint));pending.set(mint,task);
  }
  return pending.get(mint)!;
 };
}
const market=tokenMarketService();
export function tokenMarketHandler(get=market){
 let windowStart=0,requests=0;
 return async(req:IncomingMessage,res:ServerResponse)=>{
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  const send=(status:number,data:unknown)=>{res.statusCode=status;res.end(JSON.stringify(data));};
  if(req.method!=='GET'){res.setHeader('Allow','GET');return send(405,{message:'GET required.'});}
  const q=new URL(req.url||'/','https://localhost').searchParams,mint=q.get('market')||'';
  if([...q.keys()].join()!=='market'||!isMint(mint))return send(400,{message:'Provide one Solana token mint.'});
  if(Date.now()-windowStart>=60000){windowStart=Date.now();requests=0;}
  if(++requests>180){res.setHeader('Retry-After','60');return send(429,{message:'Market checks are busy.'});}
  try{return send(200,await get(mint));}catch{return send(503,{message:'Market data could not be checked.'});}
 };
}
export const handleTokenMarket=tokenMarketHandler();
