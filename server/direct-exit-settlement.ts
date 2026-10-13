import {verifyCopyLanded} from './copy-outcome.js';
import {verifyDirectExit} from './direct-exit-authorization.js';
import {verifyCopySwapMessageSignature} from './copy-swap.js';
import {isLimitBuy,exitInputMint,exitRaw,exitProceeds} from '../src/direct-exits.js';
import {isNativeExit,verifyNativeExit} from './direct-exit-native.js';
import {verifyRaydium22Landed} from './token2022-recovery.js';
import type {DirectExitRecord} from './direct-exit-store.js';
import {createHash} from 'node:crypto';
import {getTransactionDecoder,getTransactionEncoder,getCompiledTransactionMessageDecoder} from '@solana/kit';
import {fromBase64,toBase64} from '../src/transaction-review.js';
export type DirectExitOutcome=ReturnType<typeof verifyDirectExitLanded>;
// Shared transaction/account verification, without inventing a copied leader
// trade. Authorization is the separately signed direct-exit order.
export function verifyDirectExitClaim(row:DirectExitRecord,origin:string){
  const {terms:t,review:r}=row;
  if(!r||!row.attemptId||Boolean(row.signed)!==Boolean(row.transactionSignature)||verifyDirectExit(t,row.signature,origin)!==row.termsHash||
    r.intent.wallet!==t.wallet||r.intent.inputMint!==exitInputMint(t)||
    r.intent.outputMint!==exitProceeds(t).mint||r.intent.inputRaw!==t.amountRaw||r.intent.slippageBps!==t.slippageBps||r.intent.maxNetworkFeeLamports!==t.maxFeeLamports||
    !Number.isSafeInteger(r.intent.expiresAt)||r.intent.expiresAt>t.expiresAt||r.intent.expiresAt<=row.watermark.checkedAt||row.watermark.slot<r.lifetime.slot||row.watermark.checkedAt<t.issuedAt||row.watermark.checkedAt>=t.expiresAt||
    !['target','stop','trailing'].includes(row.leg||'')||(t.kind==='limit'?row.leg!=='target':t.kind==='bracket'?row.leg==='trailing':row.leg!=='trailing')||
    (row.leg==='target'&&exitRaw(r.minimum)<exitRaw(t.targetRaw)))throw Error('Direct exit evidence does not match its authorization.');
  if((t.version!==1)!==isNativeExit(r))throw Error('Exit settlement adapter changed.');
  if(isNativeExit(r))verifyNativeExit(t,r);
  const q=row.trigger;
  if(!q||q.slot!==row.watermark.slot||q.checkedAt!==row.watermark.checkedAt||q.minimumRaw!==String(r.minimum)||
    exitRaw(q.minimumRaw)>exitRaw(q.outputRaw)||exitRaw(q.outputRaw)>exitRaw(row.watermark.highRaw)||
    (row.leg==='stop'&&exitRaw(q.outputRaw)>exitRaw(t.stopRaw))||
    (row.leg==='trailing'&&exitRaw(q.outputRaw)*10000n>exitRaw(row.watermark.highRaw)*BigInt(10000-t.trailingBps!)))throw Error('Exit trigger evidence changed.');
  const tx=getTransactionDecoder().decode(fromBase64(r.unsigned)),message=getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if(toBase64(new Uint8Array(getTransactionEncoder().encode(tx)))!==r.unsigned||message.version!==0||message.header.numSignerAccounts!==1||message.staticAccounts[0]!==t.wallet||Object.keys(tx.signatures).join()!==t.wallet||Object.values(tx.signatures).some(s=>s!==null&&s.some(b=>b!==0))||createHash('sha256').update(new Uint8Array(tx.messageBytes)).digest('hex')!==r.messageHash)throw Error('Exit unsigned message changed.');
  return r;
}
export function verifyDirectExitRecord(row:DirectExitRecord,origin:string){
  const r=verifyDirectExitClaim(row,origin);
  if(!row.signed||!row.transactionSignature||verifyCopySwapMessageSignature(r,row.signed)!==row.transactionSignature)throw Error('Exit signature changed.');
  return r;
}
export function verifyDirectExitLanded(row:DirectExitRecord,value:unknown,origin:string){
  const review=verifyDirectExitRecord(row,origin),t=row.terms;
  if(isNativeExit(review))return verifyRaydium22Landed(review.native,review.nativeHash,{version:1,reviewHash:review.nativeHash,signed:row.signed!,signature:row.transactionSignature!},value,t.amountRaw,isLimitBuy(t)?t.amountRaw:undefined);
  const outcome=verifyCopyLanded({wallet:t.wallet,mint:t.mint,side:'sell',reservedCents:0,inputRaw:t.amountRaw,inputDecimals:t.tokenDecimals,outputDecimals:6,
    minOutputRaw:review.intent.minOutputRaw,signature:row.transactionSignature!,messageHash:review.messageHash,prepared:{review,savedAt:row.watermark.checkedAt},
    execution:{version:1,signed:row.signed!,feeLamports:t.maxFeeLamports,rentLamports:t.maxRentLamports,minContextSlot:row.watermark.slot}},value);
  // Verification time is not part of receipt identity. Concurrent recovery must
  // settle the same finalized result idempotently.
  return outcome.kind==='failed'?{kind:outcome.kind,signature:outcome.signature,messageHash:outcome.messageHash,slot:outcome.slot,feeLamports:outcome.feeLamports}:outcome;
}
