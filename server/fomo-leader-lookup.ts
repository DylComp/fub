import {timingSafeEqual} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {isMint} from '../src/assets.js';
import {fomoHandle} from '../src/fomo-identity.js';
import {validFomoTradingProfile,type FomoTradingProfile} from './fomo-trading-profile.js';
/** Private host only. Calls the normal profile GET; never drafts, exports login
 * state, signs transactions, or treats public wallet attribution as ownership. */
export function fomoLeaderLookup(config:{secret:string;ready:()=>boolean;read:(handle:string)=>Promise<FomoTradingProfile|null>;reserve:(handle:string)=>Promise<boolean>;save:(profile:FomoTradingProfile)=>Promise<FomoTradingProfile>;recipient?:(profile:FomoTradingProfile)=>Promise<string|null>;now?:()=>number}){
 if(!/^[A-Za-z0-9_-]{32,128}$/.test(config.secret))throw Error('Private leader lookup secret required.');
 const now=config.now||Date.now,cache=new Map<string,FomoTradingProfile>();let active=false;
 return async(req:IncomingMessage,res:ServerResponse)=>{
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  const send=(status:number,data:unknown)=>{res.statusCode=status;res.end(JSON.stringify(data));};
  const token=typeof req.headers.authorization==='string'?req.headers.authorization:'';
  const expected='Bearer '+config.secret;
  if(Buffer.byteLength(token)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(token),Buffer.from(expected)))return send(401,{error:'unauthorized'});
  const q=new URL(req.url||'/','http://localhost'),handle=q.searchParams.get('handle')||'';
  if(req.method!=='GET'||q.pathname!=='/leader'||[...q.searchParams.keys()].join()!=='handle'||fomoHandle(handle)!==handle)return send(400,{error:'invalid_lookup'});
  if(!config.ready())return send(503,{error:'lookup_unavailable'});
  const old=cache.get(handle);
  const output=async(p:FomoTradingProfile)=>{const recipientWallet=await config.recipient?.(p)||null;if(recipientWallet&&!isMint(recipientWallet))throw Error('Invalid recipient mapping');return {handle:p.handle,sourceWallet:p.sourceWallet,wallet:p.wallet,observedAt:p.observedAt,source:p.source,...(recipientWallet?{recipientWallet}:{})};};
  if(old&&now()>=old.observedAt&&now()-old.observedAt<60000){try{const saved=await config.save(old);if(!validFomoTradingProfile(saved,now())||saved.handle!==handle||saved.sourceWallet!==old.sourceWallet||saved.wallet!==old.wallet)throw Error('Mapping changed');return send(200,await output(saved));}catch{return send(503,{error:'mapping_unavailable'});}}
  if(active){res.setHeader('Retry-After','5');return send(429,{error:'lookup_busy'});}active=true;
  try{
   if(!await config.reserve(handle)){res.setHeader('Retry-After','60');return send(429,{error:'lookup_capacity'});}
   const p=await config.read(handle);
   if(!p||!validFomoTradingProfile(p,now())||p.handle!==handle||now()-p.observedAt>60000)return send(503,{error:'mapping_unavailable'});
   const saved=await config.save(p);
   if(!validFomoTradingProfile(saved,now())||saved.handle!==handle||saved.sourceWallet!==p.sourceWallet||saved.wallet!==p.wallet)throw Error('Mapping conflict.');
   if(cache.size>=200)cache.delete(cache.keys().next().value!);cache.set(handle,saved);return send(200,await output(saved));
  }catch{return send(503,{error:'mapping_unavailable'});}finally{active=false;}
 };
}
