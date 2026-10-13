import {cashWalletStore} from './cash-wallet-store.js';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage,ServerResponse } from 'node:http';
import { readWalletSession } from './wallet-session.js';
import { isCashNetwork, cashAmountRaw } from '../src/cash-route.js';
import { isEvmAddress } from '../src/networks.js';
import { cashWalletMessage,type CashWalletChallenge } from '../src/cash-wallet-model.js';
import { verifyCashWalletBinding } from './cash-wallet-binding.js';
import { cashEvmRpc } from './cash-evm-rpc.js';
import { cashWalletCookies } from './cash-wallet-cookie.js';
import {quoteCashRoute} from './cash-route.js';
export function cashWalletHandler(options:{store?:ReturnType<typeof cashWalletCookies>;session?:typeof readWalletSession;rpc?:typeof cashEvmRpc;verify?:typeof verifyCashWalletBinding;quote?:typeof quoteCashRoute}={}){
 let minute=0,calls=0;const session=options.session||readWalletSession;
 return async(req:IncomingMessage,res:ServerResponse)=>{
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','private, no-store');res.setHeader('Vary','Cookie');res.setHeader('X-Content-Type-Options','nosniff');
  const send=(status:number,body:unknown)=>{res.statusCode=status;res.end(JSON.stringify(body));};
  if(req.method!=='POST'){res.setHeader('Allow','POST');return send(405,{message:'POST required.'});}
  const user=session(req);
  if(!user)return send(401,{message:'Connect and verify your Solana wallet first.'});
  if(req.headers.origin!==user.origin||req.headers['x-fomo-request']!=='1'||req.headers['x-fub-csrf']!==user.csrf||
   req.headers['content-type']?.split(';')[0]!=='application/json'||req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin')return send(403,{message:'Open wallet verification on Fub.'});
  const current=Math.floor(Date.now()/60000);if(current!==minute){minute=current;calls=0;}if(++calls>30)return send(429,{message:'Wallet checks are busy. Try again shortly.'});
  try{
   const query=new URL(req.url||'/','https://local.invalid').searchParams;
   if(query.toString()!=='action=cash-wallet')return send(400,{message:'Invalid wallet request.'});
   let value=(req as IncomingMessage&{body?:unknown}).body;
   if(value===undefined){let size=0;const chunks:Buffer[]=[];for await(const chunk of req){const b=Buffer.from(chunk);size+=b.length;if(size>20000)throw Error();chunks.push(b);}value=Buffer.concat(chunks).toString();}
   if(typeof value==='string'){if(Buffer.byteLength(value)>20000)throw Error();value=JSON.parse(value);}
   if(!value||typeof value!=='object'||Array.isArray(value)||Buffer.byteLength(JSON.stringify(value))>20000)return send(400,{message:'Invalid wallet fields.'});
   const b=value as Record<string,unknown>,keys=Object.keys(b).sort().join(',');
   const store=options.store||(process.env.CASH_DURABLE_STORAGE==='true'?cashWalletStore(process.env.DATABASE_URL||''):cashWalletCookies(req,res,user.origin));
   if(b.action==='status'&&keys==='action,network'&&isCashNetwork(b.network))return send(200,{binding:await store.binding(user.wallet,b.network)});
   if(b.action==='quote'&&keys==='action,amount,network,token'&&isCashNetwork(b.network)&&typeof b.amount==='string'&&typeof b.token==='string'&&isEvmAddress(b.token)){
    let amountRaw:string;try{amountRaw=cashAmountRaw(b.amount);}catch{return send(400,{message:'Enter between 1 and 10,000 USDC with up to six decimal places.'});}
    const binding=await store.binding(user.wallet,b.network);
    if(!binding||binding.sourceWallet!==user.wallet||binding.network!==b.network||binding.expiresAt<=Date.now()||binding.verifiedAt>Date.now()||binding.tradingAuthorized!==false)
     return send(409,{message:'Verify your cross-chain wallet before requesting a personal quote.'});
    const quote=await (options.quote||quoteCashRoute)({sourceWallet:user.wallet,recipient:binding.recipient,network:b.network,token:b.token.toLowerCase(),amountRaw,slippageBps:100});
    return send(200,quote);
   }
   if(b.action==='challenge'&&keys==='action,network,recipient'&&isCashNetwork(b.network)&&typeof b.recipient==='string'&&isEvmAddress(b.recipient)){
    const now=Date.now(),challenge:CashWalletChallenge={version:1,origin:user.origin,sourceWallet:user.wallet,recipient:b.recipient.toLowerCase(),network:b.network,nonce:randomBytes(32).toString('hex'),issuedAt:now,expiresAt:now+300000};
    const message=cashWalletMessage(challenge);await store.challenge(challenge);return send(200,{challenge,message});
   }
   if(b.action==='verify'&&keys==='action,evm,nonce,solana'&&typeof b.nonce==='string'&&/^[a-f0-9]{64}$/.test(b.nonce)&&typeof b.evm==='string'&&typeof b.solana==='string'){
    const c=await store.pending(b.nonce,user.wallet);if(!c||c.origin!==user.origin)return send(401,{message:'Wallet verification expired. Request a fresh message.'});
    const binding=await (options.verify||verifyCashWalletBinding)(c,{evm:b.evm,solana:b.solana},(options.rpc||cashEvmRpc)(c.network));
    return send(200,{binding:await store.consume(c,binding)});
   }
   return send(400,{message:'Invalid wallet fields.'});
  }catch{return send(503,{message:'Wallet ownership was not verified. Confirm both accounts and try again.'});}
 };
}
export const handleCashWallet=cashWalletHandler();
