import type {IncomingMessage,ServerResponse} from 'node:http';
import {createCipheriv,createDecipheriv,createHash,randomBytes,createPublicKey,verify} from 'node:crypto';
import bs58 from 'bs58';
import {isMint} from '../src/assets.js';
import {walletLoginMessage,type WalletLogin} from '../src/wallet-session-model.js';
const SESSION='fub_wallet_session',CHALLENGE='fub_wallet_challenge';
const names=[SESSION,CHALLENGE];
type Session={kind:'fub-session';wallet:string;origin:string;csrf:string;expiresAt:number};
type Challenge={kind:'fub-challenge';wallet:string;origin:string;expiresAt:number;challenge:WalletLogin};
type Envelope=Session|Challenge;
const secretValue=()=>process.env.FUB_SESSION_SECRET||'';
export const walletSessionConfigured=()=>secretValue().length>=43;
const jar=(req:IncomingMessage)=>new Map((req.headers.cookie||'').split(';').map(v=>{const [name,value]=v.trim().split('=');return [name,value] as [string,string];}));
const key=(secret:string)=>createHash('sha256').update('fub-wallet-session-v1\0'+secret).digest();
const aad=Buffer.from('fub-wallet-session-v1');
function seal(value:Envelope,secret:string){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key(secret),iv);c.setAAD(aad);return Buffer.concat([iv,c.update(JSON.stringify(value)),c.final(),c.getAuthTag()]).toString('base64url');}
function open(raw:string|undefined,secret:string):Envelope|null{
 try{if(secret.length<43||!raw||raw.length>3900)return null;const b=Buffer.from(raw,'base64url');if(b.length<29)return null;const d=createDecipheriv('aes-256-gcm',key(secret),b.subarray(0,12));d.setAAD(aad);d.setAuthTag(b.subarray(-16));const value=JSON.parse(Buffer.concat([d.update(b.subarray(12,-16)),d.final()]).toString());if(!isMint(value.wallet)||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=Date.now()||typeof value.origin!=='string')return null;return value;}catch{return null;}
}
const cookie=(name:string,value:string,seconds:number)=>`${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${process.env.VERCEL||process.env.NODE_ENV==='production'?'; Secure':''}`;
function matchesHost(req:IncomingMessage,origin:string){try{const u=new URL(origin);return u.origin===origin&&u.host===req.headers.host&&(u.protocol==='https:'||(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname)));}catch{return false;}}
export function readWalletSession(req:IncomingMessage):Session|null{const value=open(jar(req).get(SESSION),secretValue());return value?.kind==='fub-session'&&matchesHost(req,value.origin)&&/^[a-f0-9]{48}$/.test(value.csrf)?value:null;}
export function walletLogoutCookies(req:IncomingMessage,wallet?:string){return names.filter(n=>!wallet||open(jar(req).get(n),secretValue())?.wallet===wallet).map(n=>cookie(n,'',0));}
class Rejected extends Error{constructor(readonly status:number,message:string){super(message);}}
function exact(body:Record<string,unknown>,fields:string[]){if(Object.keys(body).sort().join(',')!==fields.sort().join(','))throw new Rejected(400,'Invalid sign-in request.');}
async function body(req:IncomingMessage){const parsed=(req as IncomingMessage&{body?:unknown}).body;let value=parsed;if(value===undefined){const parts:Buffer[]=[];let size=0;for await(const part of req){const b=Buffer.from(part);size+=b.length;if(size>4096)throw new Rejected(413,'Request too large.');parts.push(b);}value=JSON.parse(Buffer.concat(parts).toString());}else if(typeof value==='string')value=JSON.parse(value);if(!value||typeof value!=='object'||Array.isArray(value)||Buffer.byteLength(JSON.stringify(value))>4096)throw new Rejected(400,'Invalid sign-in request.');return value as Record<string,unknown>;}
export function createWalletSessionHandler(){let minute=0,calls=0;return async(req:IncomingMessage,res:ServerResponse)=>{
 res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','private, no-store');res.setHeader('Vary','Cookie');res.setHeader('X-Content-Type-Options','nosniff');const send=(status:number,value:unknown)=>{res.statusCode=status;res.end(JSON.stringify(value));};
 try{
  const url=new URL(req.url||'/','https://local.invalid'),action=url.searchParams.get('action');if(url.searchParams.getAll('action').length!==1||[...url.searchParams.keys()].some(k=>k!=='action')||!['status','challenge','verify','logout'].includes(action||''))throw new Rejected(400,'Choose one sign-in action.');
  if(req.method!==(action==='status'?'GET':'POST')){res.setHeader('Allow',action==='status'?'GET':'POST');throw new Rejected(405,'Method not allowed.');}
  const configured=walletSessionConfigured();
  if(action==='status'){const session=readWalletSession(req);send(200,{configured,address:session?.wallet||null,...(session?{csrf:session.csrf,expiresAt:session.expiresAt}:{})});return;}
  const origin=req.headers.origin;if(!origin||!matchesHost(req,origin)||req.headers['x-fomo-request']!=='1'||req.headers['content-type']?.split(';')[0].trim()!=='application/json'||(req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin'))throw new Rejected(403,'Open sign-in from Fub.');
  const value=await body(req);if(typeof value.wallet!=='string'||!isMint(value.wallet))throw new Rejected(400,'Choose a Solana wallet.');
  if(action==='logout'){exact(value,['wallet']);res.setHeader('Set-Cookie',walletLogoutCookies(req,value.wallet));send(200,{configured,address:null});return;}
  if(!configured)throw new Rejected(503,'Wallet sign-in is unavailable.');
  const current=Math.floor(Date.now()/60000);if(current!==minute){minute=current;calls=0;}if(++calls>60)throw new Rejected(429,'Too many requests. Try again in a minute.');
  const secret=secretValue();
  if(action==='challenge'){
   exact(value,['wallet']);const now=Date.now(),challenge:WalletLogin={version:1,wallet:value.wallet,origin,nonce:randomBytes(32).toString('hex'),issuedAt:now,acceptBy:now+300000,expiresAt:now+86400000};
   res.setHeader('Set-Cookie',cookie(CHALLENGE,seal({kind:'fub-challenge',wallet:value.wallet,origin,expiresAt:challenge.acceptBy,challenge},secret),300));send(200,{challenge,message:walletLoginMessage(challenge)});return;
  }
  exact(value,['wallet','signature']);const pending=open(jar(req).get(CHALLENGE),secret);
  if(pending?.kind!=='fub-challenge'||pending.wallet!==value.wallet||pending.origin!==origin)throw new Rejected(401,'Sign-in expired. Request a new message.');
  if(typeof value.signature!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value.signature))throw new Rejected(400,'Invalid wallet signature.');
  const signature=bs58.decode(value.signature),pubkey=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),bs58.decode(value.wallet)]),format:'der',type:'spki'});
  if(signature.length!==64||!verify(null,Buffer.from(walletLoginMessage(pending.challenge)),pubkey,signature))throw new Rejected(401,'The signature does not match this wallet and message.');
  const session:Session={kind:'fub-session',wallet:value.wallet,origin,csrf:randomBytes(24).toString('hex'),expiresAt:pending.challenge.expiresAt};
  res.setHeader('Set-Cookie',[cookie(CHALLENGE,'',0),cookie(SESSION,seal(session,secret),Math.floor((session.expiresAt-Date.now())/1000))]);send(200,{configured:true,address:session.wallet,csrf:session.csrf,expiresAt:session.expiresAt});
 }catch(error){send(error instanceof Rejected?error.status:400,{message:error instanceof Rejected?error.message:'Wallet sign-in could not be verified.'});}
};}
export const handleWalletSession=createWalletSessionHandler();
