import {isFubWebOrigin} from './fub-web-origin.js';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {validPayTerms} from '../src/pay-verification.js';
import {isMint} from '../src/assets.js';
import {rpcRequest} from './funding.js';
import {payRpc} from './pay-rpc.js';
import {payTransferStore} from './pay-transfer-store.js';
import {payTransferService} from './pay-transfer-service.js';
export function payTransferHandler(options:{enabled?:()=>boolean;pilotWallet?:()=>string|undefined;service?:ReturnType<typeof payTransferService>}={}){
 let service=options.service,active=0,start=0,calls=0;
 const pilotWallet=options.pilotWallet||(()=>process.env.PAY_TRANSFER_PILOT_WALLET);
 const enabled=options.enabled||(()=>process.env.PAY_TRANSFER_ENABLED==='true'&&!!process.env.DATABASE_URL&&!!(process.env.PAY_TRANSFER_RPC_URL||process.env.SOLANA_RPC_URL));
 const connection=payRpc();
 const rpc:typeof rpcRequest=async(method,params)=>{
  try{return await connection(method,params);}
  catch(e){console.warn(JSON.stringify({event:'pay_rpc_failure',method}));throw e;}
 };
 return async(req:IncomingMessage,res:ServerResponse)=>{
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  const send=(status:number,data:unknown)=>{res.statusCode=status;res.end(JSON.stringify(data));};
  if(req.method==='GET')return send(200,{enabled:enabled(),pilotWallet:pilotWallet()||null});
  if(req.method!=='POST'){res.setHeader('Allow','GET, POST');return send(405,{message:'POST required.'});}
  if(!enabled())return send(503,{message:'Direct payments are not active yet.'});
  if(!isFubWebOrigin(req.headers.origin))return send(403,{message:'Open the payment on Fub.'});
  if(req.headers['content-type']?.split(';')[0]!=='application/json'||new URL(req.url||'/','https://localhost').search)return send(400,{message:'Invalid payment request.'});
  if(Date.now()-start>60000){start=Date.now();calls=0;}if(active>=3||calls>=30){res.setHeader('Retry-After','10');return send(429,{message:'Payment checks are busy. Try again shortly.'});}active++;calls++;
  try{
   let body:any;try{const existing=(req as IncomingMessage&{body?:unknown}).body;if(existing!==undefined){const raw=typeof existing==='string'?existing:JSON.stringify(existing);if(Buffer.byteLength(raw)>14000)throw Error();body=JSON.parse(raw);}else{let size=0;const chunks:Buffer[]=[];const timer=setTimeout(()=>req.destroy(),5000);try{for await(const chunk of req){const b=Buffer.from(chunk);size+=b.length;if(size>14000)throw Error();chunks.push(b);}body=JSON.parse(Buffer.concat(chunks).toString());}finally{clearTimeout(timer);}}}catch{return send(400,{message:'Invalid payment request.'});}
   if(!body||typeof body!=='object'||Array.isArray(body))return send(400,{message:'Invalid payment request.'});
   const keys=Object.keys(body).sort().join(','),valid=body.action==='status'?keys==='action,terms'&&validPayTerms(body.terms):body.action==='prepare'?keys==='action,sender,terms'&&isMint(body.sender)&&validPayTerms(body.terms):body.action==='submit'?keys==='action,review,signed'&&body.review&&body.review.version===1&&isMint(body.review.sender)&&typeof body.review.unsigned==='string'&&body.review.unsigned.length<3000&&validPayTerms(body.review.terms)&&typeof body.signed==='string'&&body.signed.length<3000:false;
   if(!valid)return send(400,{message:'Check the payment fields.'});
   const pilot=pilotWallet();if(pilot&&body.action!=='status'&&(body.sender||body.review?.sender)!==pilot)return send(403,{message:'Direct payments are limited to the acceptance wallet while testing.'});
   service??=payTransferService(payTransferStore(process.env.DATABASE_URL!),rpc);
   return send(200,await(body.action==='prepare'?service.prepare(body.sender,body.terms):body.action==='status'?service.status(body.terms):service.submit(body.review,body.signed)));
  }catch(e){const message=e instanceof Error?e.message:'';const safe=['This wallet does not have enough USDC for this share.','This wallet needs more SOL for the network fee and receiving account.','Choose a different receiving wallet with valid payment details.','Refresh the payment review before signing.','Another payment is already recorded for this share. Check its status.'];
   // Never log raw errors: RPC and database failures can contain credentials.
   const diagnostics=['Chain verification unavailable.','Payment accounts unavailable.','Unsupported payment account.','Invalid payment account.','An active USDC account is required.','Payment blockhash is stale.','The payment network fee changed.','Payment simulation failed. Refresh balances before trying again.','Simulation differs from the exact payment.','Invalid payment history.','USDC mint verification failed.','Invalid payment chain context.'];
   console.warn(JSON.stringify({event:'pay_transfer_failure',reason:[...safe,...diagnostics].includes(message)?message:'internal_failure',timeout:e instanceof Error&&(e.name==='TimeoutError'||e.name==='AbortError')}));
   return send(503,{message:safe.includes(message)?message:'Payment could not be completed. Check its status before trying again.'});}
  finally{active--;}
 };
}
export const handlePayTransfer=payTransferHandler();
