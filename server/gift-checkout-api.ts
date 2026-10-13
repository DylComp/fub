import type {IncomingMessage,ServerResponse} from 'node:http';
import {readWalletSession} from './wallet-session.js';
import {giftOrderId,validGiftSelection} from '../src/gift-checkout-model.js';
import {giftCheckoutStore} from './gift-checkout-store.js';
import {giftCheckoutService} from './gift-checkout-service.js';
import {bitrefillCatalog} from './bitrefill-catalog.js';
import {payTransferService} from './pay-transfer-service.js';
import {payTransferStore} from './pay-transfer-store.js';
import {payRpc} from './pay-rpc.js';
export function giftCheckoutHandler(options:{service?:ReturnType<typeof giftCheckoutService>;session?:typeof readWalletSession;enabled?:()=>boolean;pilot?:()=>string|undefined}={}){
 let service=options.service,active=0;
 const usage=new Map<string,{since:number;calls:number}>();
 const enabled=options.enabled||(()=>process.env.BITREFILL_CHECKOUT_ENABLED==='true'&&!!process.env.DATABASE_URL&&!!process.env.BITREFILL_ORDER_SECRET);
 return async(req:IncomingMessage,res:ServerResponse)=>{
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','private, no-store');res.setHeader('Vary','Cookie');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  const send=(status:number,value:unknown)=>{res.statusCode=status;res.end(JSON.stringify(value));};
  const session=(options.session||readWalletSession)(req),pilot=(options.pilot||(()=>process.env.BITREFILL_CHECKOUT_PILOT_WALLET))();
  if(req.method==='GET')return send(200,{enabled:enabled(),allowed:enabled()&&!!session&&(!pilot||session.wallet===pilot)});
  if(req.method!=='POST'){res.setHeader('Allow','GET, POST');return send(405,{message:'POST required.'});}
  if(!enabled())return send(503,{message:'Gift-card checkout is not active yet.'});
  if(!session)return send(401,{message:'Sign in with your wallet to view purchases.'});
  if(req.headers.origin!==session.origin||req.headers['x-fub-csrf']!==session.csrf||req.headers['x-fomo-request']!=='1'||req.headers['content-type']?.split(';')[0]!=='application/json'||(req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin')||new URL(req.url||'/','https://local').search)return send(403,{message:'Open checkout on Fub.'});
  if(pilot&&session.wallet!==pilot)return send(403,{message:'Checkout is limited to the acceptance wallet while testing.'});
  // One customer's open receipts must not consume every other customer's
  // minute budget. Authenticate first; bound retained owners and concurrent work.
  const now=Date.now();for(const [wallet,row] of usage)if(now-row.since>=60000)usage.delete(wallet);
  let bucket=usage.get(session.wallet);
  if(active>=3||!bucket&&usage.size>=1000||bucket&&bucket.calls>=40){res.setHeader('Retry-After',active>=3?'5':'60');return send(429,{message:'Checkout is busy. Try again shortly.'});}
  if(!bucket){bucket={since:now,calls:0};usage.set(session.wallet,bucket);}bucket.calls++;active++;
  try{
   let b:any;try{let raw=(req as IncomingMessage&{body?:unknown}).body;
    if(raw===undefined){let size=0;const parts:Buffer[]=[],timer=setTimeout(()=>req.destroy(),5000);try{for await(const part of req){const bytes=Buffer.from(part);size+=bytes.length;if(size>14000)throw Error();parts.push(bytes);}raw=Buffer.concat(parts).toString();}finally{clearTimeout(timer);}}
    const encoded=typeof raw==='string'?raw:JSON.stringify(raw);if(Buffer.byteLength(encoded)>14000)throw Error();b=JSON.parse(encoded);if(!b||typeof b!=='object'||Array.isArray(b))throw Error();
   }catch{return send(400,{message:'Invalid checkout request.'});}
   const keys=Object.keys(b).sort().join();
   if(!(b.action==='list'&&keys==='action'||b.action==='create'&&keys==='action,id,selection'&&giftOrderId(b.id)&&validGiftSelection(b.selection)||['status','prepare','close'].includes(b.action)&&keys==='action,id'&&giftOrderId(b.id)||b.action==='submit'&&keys==='action,id,review,signed'&&giftOrderId(b.id)&&b.review?.version===1&&typeof b.signed==='string'&&b.signed.length<3000))return send(400,{message:'Check the purchase fields.'});
   service??=giftCheckoutService(giftCheckoutStore(process.env.DATABASE_URL!,process.env.BITREFILL_ORDER_SECRET!),bitrefillCatalog(),payTransferService(payTransferStore(process.env.DATABASE_URL!),payRpc()));
   const owner=session.wallet;
   return send(200,b.action==='list'?await service.list(owner):b.action==='create'?await service.create(owner,b.id,b.selection):b.action==='status'?await service.status(owner,b.id):b.action==='prepare'?await service.prepare(owner,b.id):b.action==='submit'?await service.submit(owner,b.id,b.review,b.signed):await service.close(owner,b.id));
  }catch(e){const allowed=['Wallet funding could not be checked.','An active Solana USDC account is required.','Gift-card price estimate is unavailable.','Receiving account rent could not be checked.','Purchase not found.','Check the merchant, amount, region and email.','Purchase details changed.','This product needs checkout on Bitrefill.','Invoice creation is unresolved. Open purchase history before trying again.','An open purchase already exists, or the daily purchase limit was reached. Open purchase history.','This invoice cannot accept a new payment. Check purchase status.','This wallet does not have enough USDC for this share.','This wallet needs more SOL for the network fee and receiving account.','This purchase has a recorded payment. Resolve it before closing.','Check the expired invoice before closing it.'];return send(503,{message:e instanceof Error&&allowed.includes(e.message)?e.message:'Purchase status is unavailable. Check this purchase before trying again.'});}
  finally{active--;}
 };
}
export const handleGiftCheckout=giftCheckoutHandler();
