import { randomUUID } from 'node:crypto';
import { exitInputMint, evaluateExit, exitRaw, exitProceeds, type DirectExitTerms, type ExitObservation } from '../src/direct-exits.js';
import { verifyDirectExit } from './direct-exit-authorization.js';
import type { DirectExitStore, DirectExitRecord } from './direct-exit-store.js';
import type { EnrolledWallet } from './signer-enrollment.js';
import type { PrivySignRequest } from './privy-sign-only.js';
import { verifyCopySwapMessageSignature } from './copy-swap.js';
import {isNativeExit,verifyNativeExit,type DirectExitReview} from './direct-exit-native.js';

export type ExitQuote = {review:DirectExitReview;observation:ExitObservation;feeLamports:string;rentLamports:string;tokenDecimals:number};
// Private host only. Neither the browser nor an application worker can supply a
// quote, provider wallet ID or unsigned transaction to this execution boundary.
export function directExitEngine(config:{
  assertTerms?:(terms:DirectExitTerms)=>void;
  origin:string; store:DirectExitStore;
  enabled:()=>boolean; allows:(wallet:string)=>boolean;
  resolveWallet:(wallet:string,issuedAt:number,signal:AbortSignal)=>Promise<EnrolledWallet>;
  quote:(terms:DirectExitTerms,signal:AbortSignal)=>Promise<ExitQuote>;
  recheck:(terms:DirectExitTerms,quote:ExitQuote,signal:AbortSignal)=>Promise<ExitQuote>;
  provider:(request:PrivySignRequest,signal:AbortSignal)=>Promise<string>;
}){
  function authority(r:DirectExitRecord){
    config.assertTerms?.(r.terms);
    if(!config.enabled()||!config.allows(r.terms.wallet)||r.terms.issuedAt>Date.now()||r.terms.expiresAt<=Date.now()||
      verifyDirectExit(r.terms,r.signature,config.origin)!==r.termsHash)throw Error('Direct exit is not authorized.');
  }
  function quoteBounds(t:DirectExitTerms,q:ExitQuote){
    const i=q.review.intent;
    if(isNativeExit(q.review))verifyNativeExit(t,q.review);
    if((t.version!==1)!==isNativeExit(q.review))throw Error('Exit settlement adapter changed.');
    if(i.wallet!==t.wallet||i.inputMint!==exitInputMint(t)||i.outputMint!==exitProceeds(t).mint||i.inputRaw!==t.amountRaw||i.slippageBps!==t.slippageBps||
      i.maxNetworkFeeLamports!==t.maxFeeLamports||i.expiresAt>Date.now()+30000||i.expiresAt>t.expiresAt||i.expiresAt<=Date.now()||
      q.tokenDecimals!==t.tokenDecimals||exitRaw(q.feeLamports,true)>exitRaw(t.maxFeeLamports)||exitRaw(q.rentLamports,true)>exitRaw(t.maxRentLamports,true)||
      q.observation.minimumRaw!==String(q.review.minimum)||exitRaw(q.observation.minimumRaw)<exitRaw(i.minOutputRaw)||q.observation.slot<q.review.lifetime.slot)throw Error('Exit quote exceeds its signed terms.');
  }
  return {
    async tick(id:string,signal:AbortSignal){
      signal.throwIfAborted();
      const row=await config.store.get(id);
      if(!row||row.state!=='watching')return {state:'skipped' as const};
      authority(row);
      const t=row.terms,owner=await config.resolveWallet(t.wallet,t.issuedAt,signal);
      const quote=await config.quote(t,signal);quoteBounds(t,quote);
      const decision=evaluateExit(t,row.watermark,quote.observation);
      if(!decision.leg){
        signal.throwIfAborted();authority(row);
        const saved=await config.store.observe(row,decision.watermark);
        return {state:saved?'watching' as const:'superseded' as const};
      }
      // Re-simulate the exact transaction. An initial trigger cannot authorize a
      // later transaction whose fresh executable proceeds no longer trigger it.
      const checked=await config.recheck(t,quote,signal);quoteBounds(t,checked);
      if(checked.review.unsigned!==quote.review.unsigned)throw Error('Exit transaction changed.');
      const final=evaluateExit(t,row.watermark,checked.observation);
      if(final.leg!==decision.leg)return {state:'moved' as const};
      await owner.check(signal);authority(row);signal.throwIfAborted();
      const attemptId=randomUUID();
      if(!await config.store.claim(row,final.watermark,final.leg!,attemptId,checked.review,checked.observation))return {state:'superseded' as const};
      // A claim consumes both bracket legs. Any unknown signing outcome remains
      // reserved, including process failure. Never reset it to watching on timeout.
      try {
        authority(row);await owner.check(signal);signal.throwIfAborted();
        const current=await config.store.get(id);
        if(current?.state!=='signing'||current.attemptId!==attemptId||current.termsHash!==row.termsHash)throw Error('Exit claim changed.');
        if(Date.now()-checked.observation.checkedAt>10000)throw Error('Exit trigger expired.');
        const signed=await config.provider({wallet:t.wallet,walletId:owner.walletId,unsigned:checked.review.unsigned,idempotencyKey:`direct-exit:${id}:${attemptId}`,expiresAt:Math.min(t.expiresAt,checked.review.intent.expiresAt)},signal);
        const signature=verifyCopySwapMessageSignature(checked.review,signed);
        // Preserve a late signature even if the request/permission expired.
        await config.store.recordSigned(id,attemptId,signed,signature);
        signal.throwIfAborted();authority(row);if(checked.review.intent.expiresAt<=Date.now())throw Error('Exit signature arrived after its delivery window.');await owner.check(signal);
        return {state:'signed' as const,id,attemptId,signature};
      }catch(e){await config.store.uncertain(id,attemptId);throw e;}
    },
  };
}
