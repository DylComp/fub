import {matchesFubOrigin} from '../src/fub-origin.js';
import {isMint} from '../src/assets.js';
import type {cashLimitEnrollment} from './cash-limit-enrollment.js';
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const exact=(v:any,keys:string)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys;
export function cashLimitApi<R>(c:{origin:string;service:ReturnType<typeof cashLimitEnrollment<R>>;configuration?:(token:string,body:{wallet:string;walletId:string;recipient:string;evmWalletId:string;network:string;token:string},signal:AbortSignal)=>Promise<object>}){
 return async(request:Request)=>{
  const origin=request.headers.get('origin'),allowed=matchesFubOrigin(origin,c.origin),headers:Record<string,string>={'Cache-Control':'no-store','Vary':'Origin','X-Content-Type-Options':'nosniff'};
  if(allowed)Object.assign(headers,{'Access-Control-Allow-Origin':origin!,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type'});
  const reply=(status:number,body:object)=>Response.json(body,{status,headers});
  if(!allowed)return reply(403,{error:'Request origin refused.'});const url=new URL(request.url);
  if(url.search||!/^\/v1\/cash-limits\/(config|activate|status|stop|list)$/.test(url.pathname))return reply(404,{error:'Not found.'});
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers});if(request.method!=='POST')return reply(405,{error:'Use POST.'});
  if(request.headers.get('content-type')?.split(';')[0]!=='application/json'||request.headers.has('content-encoding'))return reply(415,{error:'Use uncompressed JSON.'});
  const auth=request.headers.get('authorization')||'';if(!/^Bearer [A-Za-z0-9_.-]{1,8192}$/.test(auth))return reply(401,{error:'Connect your wallet again.'});
  if(!request.body||Number(request.headers.get('content-length'))>16384)return reply(413,{error:'Request is too large.'});
  const signal=AbortSignal.any([request.signal,AbortSignal.timeout(15000)]),reader=request.body.getReader(),cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
  try{const chunks:Uint8Array[]=[];let length=0;for(;;){signal.throwIfAborted();const part=await reader.read();signal.throwIfAborted();if(part.done)break;length+=part.value.length;if(length>16384)return reply(413,{error:'Request is too large.'});chunks.push(part.value);}
   const b=JSON.parse(Buffer.concat(chunks).toString()),token=auth.slice(7),action=url.pathname.split('/').pop();
   if(action==='config'){if(!c.configuration||!exact(b,'evmWalletId,network,recipient,token,wallet,walletId'))throw Error();return reply(200,await c.configuration(token,b,signal));}
   if(action==='activate'){if(!exact(b,'proof,terms,walletIds')||!exact(b.proof,'evm,solana')||!exact(b.walletIds,'evm,solana')||b.terms?.origin!==origin||origin!==c.origin)throw Error();return reply(200,await c.service.activate(token,b.terms,b.proof,b.walletIds,signal));}
   if(action==='list'){if(!exact(b,'wallet')||!isMint(b.wallet))throw Error();return reply(200,await c.service.list(token,b.wallet));}
   if(!exact(b,'id')||!uuid(b.id))throw Error();return reply(200,await c.service[action==='stop'?'stop':'status'](token,b.id));
  }catch{return reply(400,{error:'Limit request was not confirmed. Check its saved status before retrying.'});}finally{signal.removeEventListener('abort',cancel);cancel();reader.releaseLock();}
 };
}
