import {fomoHandle} from '../src/fomo-identity.js';
import {isMint} from '../src/assets.js';
import {matchesFubOrigin} from '../src/fub-origin.js';
import type {cashCopyEnrollment} from './cash-copy-enrollment.js';

const LIMIT=12288;
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
function exact(value:unknown,keys:string[]):asserts value is Record<string,any>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==keys.sort().join(','))throw Error();
}
// Mounted behind the isolated host's peer/concurrency limiter. Never accepts
// observations, signed trade bytes, RPC URLs or caller-supplied owner records.
export function cashCopyEnrollmentApi(config:{origin:string;ownerSale?:ReturnType<typeof import('./cash-copy-owner-sale.js').cashCopyOwnerSale>;service:Pick<ReturnType<typeof cashCopyEnrollment>,'activate'|'status'|'revoke'|'list'|'history'>;readiness?:(token:string,scope:import('../src/cash-copy-model.js').CashCopyScope,ids:{solana:string;evm:string},signal:AbortSignal)=>Promise<object>;configuration?:(token:string,wallet:string,walletId:string,leaderSource:string,signal:AbortSignal,leaderHandle?:string)=>Promise<object>;ready:()=>boolean;enabled:()=>boolean}){
 if(new URL(config.origin).origin!==config.origin||!config.origin.startsWith('https://'))throw Error('Invalid enrollment origin.');
 return async(request:Request):Promise<Response>=>{
  const origin=request.headers.get('origin'),allowed=matchesFubOrigin(origin,config.origin);
  const headers:Record<string,string>={'Cache-Control':'no-store','Vary':'Origin','X-Content-Type-Options':'nosniff'};
  if(allowed)Object.assign(headers,{'Access-Control-Allow-Origin':origin!,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type'});
  const reply=(status:number,body:unknown)=>Response.json(body,{status,headers});
  if(!allowed)return reply(403,{error:'Request origin refused.'});
  const url=new URL(request.url),action=url.pathname.split('/').pop();
  if(url.search||!/^\/v1\/cash-enrollment\/(config|activate|status|stop|list|readiness|history|owner-sale-review|owner-sale-submit)$/.test(url.pathname))return reply(404,{error:'Not found.'});
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
  if(request.method!=='POST')return reply(405,{error:'Use POST.'});
  if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json'||request.headers.has('content-encoding')&&request.headers.get('content-encoding')!=='identity')return reply(415,{error:'Use uncompressed JSON.'});
  const auth=request.headers.get('authorization')||'';
  if(!/^Bearer [A-Za-z0-9_.-]{1,8192}$/.test(auth))return reply(401,{error:'Connect your wallet again.'});
  // A release pause must never disable status or revocation.
  if(action==='activate'&&(!config.ready()||!config.enabled()))return reply(503,{error:'Automatic cross-chain copying is not activated.'});
  const bodyLimit=action?.startsWith('owner-sale-')?300000:LIMIT;
  if(!request.body||Number(request.headers.get('content-length'))>bodyLimit)return reply(413,{error:'Request is too large.'});
  const signal=AbortSignal.any([request.signal,AbortSignal.timeout(action?.startsWith('owner-sale-')?30000:10000)]),reader=request.body.getReader();
  const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
  try{
   const chunks:Uint8Array[]=[];let size=0;signal.throwIfAborted();
   for(;;){const p=await reader.read();signal.throwIfAborted();if(p.done)break;size+=p.value.length;if(size>bodyLimit)return reply(413,{error:'Request is too large.'});chunks.push(p.value);}
   const body=JSON.parse(Buffer.concat(chunks).toString('utf8')),token=auth.slice(7);
   if(action==='owner-sale-review'||action==='owner-sale-submit'){
    exact(body,['wallet','planId','id',...(action==='owner-sale-submit'?['signed']:[])]);
    if(!config.ownerSale||!isMint(body.wallet)||!uuid(body.planId)||!uuid(body.id))throw Error();
    if(action==='owner-sale-submit'&&(!Array.isArray(body.signed)||body.signed.length<1||body.signed.length>2||body.signed.some((s:unknown)=>typeof s!=='string'||s.length>140000)))throw Error();
    return reply(200,await(action==='owner-sale-review'?config.ownerSale.review(token,body.planId,body.wallet,body.id,signal):config.ownerSale.submit(token,body.planId,body.wallet,body.id,body.signed,signal)));
   }
   if(action==='config'){
    exact(body,['wallet','walletId','leaderSource',...(body?.leaderHandle!==undefined?['leaderHandle']:[])]);
    if(body.leaderHandle!==undefined&&(typeof body.leaderHandle!=='string'||fomoHandle(body.leaderHandle)!==body.leaderHandle))throw Error();
    if(!config.configuration||!isMint(body.wallet)||!isMint(body.leaderSource)||typeof body.walletId!=='string'||!/^[a-z0-9]{20,40}$/.test(body.walletId))throw Error();
    return reply(200,await config.configuration(token,body.wallet,body.walletId,body.leaderSource,signal,body.leaderHandle));
   }
   if(action==='readiness'){
    exact(body,['scope','walletIds']);exact(body.walletIds,['solana','evm']);
    if(!config.readiness||body.scope?.origin!==origin||origin!==config.origin||![body.walletIds.solana,body.walletIds.evm].every(v=>typeof v==='string'&&/^[a-z0-9]{20,40}$/.test(v)))throw Error();
    return reply(200,await config.readiness(token,body.scope,{solana:body.walletIds.solana,evm:body.walletIds.evm},signal));
   }
   if(action==='history'){
    exact(body,['planId','wallet','after']);if(!uuid(body.planId)||!isMint(body.wallet)||body.after!==null&&!uuid(body.after))throw Error();
    return reply(200,await config.service.history(token,body.planId,body.wallet,body.after));
   }
   if(action==='list'){
    exact(body,['wallet','after']);if(!isMint(body.wallet)||body.after!==null&&!uuid(body.after))throw Error();
    const result=await config.service.list(token,body.wallet,body.after);return reply(200,{...result,plans:result.plans.map(p=>{const executionEnabled=config.ready()&&config.enabled()&&(p.status as any).monitorReady!==false;return {...p,status:{...p.status,permissionState:p.status.state,executionEnabled,state:p.status.state==='active'&&!executionEnabled?'paused':p.status.state}};})});
   }
   if(action==='activate'){
    exact(body,['scope','proof','walletIds']);exact(body.proof,['solana','evm']);exact(body.walletIds,['solana','evm']);
    if(body.scope?.origin!==origin||origin!==config.origin||![body.proof.solana,body.proof.evm,body.walletIds.solana,body.walletIds.evm].every(v=>typeof v==='string'))throw Error();
    if(!config.ready()||!config.enabled())return reply(503,{error:'Automatic cross-chain copying is not activated.'});
    const result=await config.service.activate(token,body.scope,{solana:body.proof.solana,evm:body.proof.evm},{solana:body.walletIds.solana,evm:body.walletIds.evm},signal);
    const listening=(result as any).monitorReady!==false;
    return reply(200,{...result,permissionState:result.state,executionEnabled:config.enabled()&&listening,state:result.state==='active'&&!listening?'paused':result.state});
   }
   exact(body,['planId','wallet']);if(!uuid(body.planId)||!isMint(body.wallet))throw Error();
   const status=await config.service[action==='stop'?'revoke':'status'](token,body.planId,body.wallet);
   const executionEnabled=config.ready()&&config.enabled()&&(status as any).monitorReady!==false;
   return reply(200,{...status,permissionState:status.state,executionEnabled,state:status.state==='active'&&!executionEnabled?'paused':status.state});
  }catch{return reply(400,{error:'Copy permission was not confirmed. Check the saved plan before retrying.'});}
  finally{signal.removeEventListener('abort',cancel);cancel();reader.releaseLock();}
 };
}
