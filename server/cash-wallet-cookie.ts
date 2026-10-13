import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {cashWalletMessage,type CashWalletChallenge} from '../src/cash-wallet-model.js';
import {isCashNetwork} from '../src/cash-route.js';
import type {CashWalletBinding} from './cash-wallet-binding.js';
const aad=Buffer.from('fub-cash-ownership-v1');
const challengeName='fub_cash_challenge';
type Envelope={kind:'challenge';value:CashWalletChallenge}|{kind:'binding';origin:string;value:CashWalletBinding};
// Read-only ownership evidence. It cannot authorize a purchase or a background
// signer. Trading authorization and one-attempt journals are separate records.
export function cashWalletCookies(req:IncomingMessage,res:ServerResponse,origin:string,secret=process.env.FUB_SESSION_SECRET||''){
 if(secret.length<43)throw Error('Wallet verification is not configured.');
 const key=createHash('sha256').update(aad).update(secret).digest();
 function read(name:string):Envelope|null{
  try{const raw=(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='))?.slice(name.length+1);
   if(!raw||raw.length>3900)return null;const b=Buffer.from(raw,'base64url');if(b.length<29)return null;
   const d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAAD(aad);d.setAuthTag(b.subarray(-16));
   return JSON.parse(Buffer.concat([d.update(b.subarray(12,-16)),d.final()]).toString());
  }catch{return null;}
 }
 function write(name:string,value:Envelope|null,seconds:number){
  let encoded='';if(value){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(aad);encoded=Buffer.concat([iv,c.update(JSON.stringify(value)),c.final(),c.getAuthTag()]).toString('base64url');}
  const cookie=`${name}=${encoded}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`;
  const existing=res.getHeader('Set-Cookie');res.setHeader('Set-Cookie',[...(Array.isArray(existing)?existing:existing?[String(existing)]:[]),cookie]);
 }
 return {
  async challenge(c:CashWalletChallenge){if(c.origin!==origin)throw Error();cashWalletMessage(c);write(challengeName,{kind:'challenge',value:c},300);},
  async pending(nonce:string,wallet:string){const e=read(challengeName);if(e?.kind!=='challenge'||e.value.origin!==origin||e.value.sourceWallet!==wallet||e.value.nonce!==nonce||e.value.expiresAt<=Date.now())return null;cashWalletMessage(e.value);return e.value;},
  async consume(c:CashWalletChallenge,binding:CashWalletBinding){
   const pending=await this.pending(c.nonce,c.sourceWallet);
   if(!pending||cashWalletMessage(pending)!==cashWalletMessage(c)||binding.sourceWallet!==c.sourceWallet||binding.network!==c.network||binding.recipient!==c.recipient||binding.tradingAuthorized!==false||binding.expiresAt>c.expiresAt+3600000)throw Error('Wallet verification changed.');
   write(challengeName,null,0);write('fub_cash_'+c.network,{kind:'binding',origin,value:binding},Math.floor((binding.expiresAt-Date.now())/1000));return binding;
  },
  async binding(wallet:string,network:string){if(!isCashNetwork(network))return null;const e=read('fub_cash_'+network);
   return e?.kind==='binding'&&e.origin===origin&&e.value.sourceWallet===wallet&&e.value.network===network&&e.value.expiresAt>Date.now()&&e.value.tradingAuthorized===false?e.value:null;
  }
 };
}
