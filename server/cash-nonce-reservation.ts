import {neon} from '@neondatabase/serverless';
import {cashSigningDigest} from './cash-copy-signing-parts.js';
import type {PrivyEvmSignRequest} from './privy-evm-sign-only.js';
export type CashNonceClaim={wallet:string;chainId:number;nonce:number;digest:string;requestId:string};
export function reserveCashEvmNonce(claim:(c:CashNonceClaim)=>Promise<boolean>,provider:(r:PrivyEvmSignRequest,s:AbortSignal)=>Promise<string>){
 return async(r:PrivyEvmSignRequest,s:AbortSignal)=>{
  s.throwIfAborted();const t=r.transaction,wallet=r.wallet.toLowerCase();
  if(t.from!==wallet||!/^0x[0-9a-f]{40}$/.test(wallet)||!Number.isSafeInteger(t.chainId)||t.chainId<1||!Number.isSafeInteger(t.nonce)||t.nonce<0)throw Error('Invalid nonce reservation.');
  if(!await claim({wallet,chainId:t.chainId,nonce:t.nonce,digest:cashSigningDigest(t),requestId:r.idempotencyKey}))throw Error('Another signed operation owns this wallet nonce.');
  s.throwIfAborted();return provider(r,s);
 };
}
// Claims never expire: an unknown provider outcome cannot free a nonce for a
// different transaction. Advancing the chain nonce naturally uses another key.
export function privateCashNonceClaim(url:string){return async(c:CashNonceClaim)=>{
 const sql=neon(url,{fetchOptions:{signal:AbortSignal.timeout(5000)}});
 await sql`INSERT INTO signer_cash_nonce_claims(wallet,chain_id,nonce,digest,request_id) VALUES(${c.wallet},${c.chainId},${c.nonce},${c.digest},${c.requestId}) ON CONFLICT DO NOTHING`;
 const rows=await sql`SELECT digest,request_id FROM signer_cash_nonce_claims WHERE wallet=${c.wallet} AND chain_id=${c.chainId} AND nonce=${c.nonce}`;
 return rows.length===1&&rows[0].digest===c.digest&&rows[0].request_id===c.requestId;
};}
