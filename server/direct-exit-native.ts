import {hasActivePumpCurve,simulateCurveSwap} from './pump-curve-execution.js';
import {curveNativeResult} from './token2022-recovery.js';
import {TOKEN_2022} from './jupiter-routes.js';
import {exitRaw,exitInputMint,exitProceeds,isLimitBuy,validateExitTerms,type DirectExitTerms} from '../src/direct-exits.js';
import {TOKEN_PROGRAM} from '../src/funding-model.js';
import type {CopySwapIntent} from '../src/copy-swap.js';
import type {Rpc} from './funding.js';
import type {ReviewedCopySwap,SwapLifetime} from './copy-swap.js';
import type {ExitQuote} from './direct-exit-engine.js';
import {fetchNativeBuild,isPumpNativeBuild,nativeQuoteSlippage} from './token2022-prepare-worker.js';
import {simulateRaydium22Swap,simulateStandardNativeSwap,simulatePumpNativeSwap} from './token2022-raydium-simulation.js';
import {nativeReviewBuild,rebuildNativeReview} from './isolated-native-review.js';
import {raydium22ReviewHash,type Raydium22ExecutionReview} from './token2022-recovery.js';
import {MAINNET_GENESIS} from './solana-network.js';
import {NATIVE_PRIORITY_MICROLAMPORTS} from './native-priority.js';

export type NativeExitReview={
  kind:'token2022'|'standard-native';intent:CopySwapIntent;unsigned:string;messageHash:string;
  minimum:string;lifetime:SwapLifetime;native:Raydium22ExecutionReview;nativeHash:string;
};
export type DirectExitReview=ReviewedCopySwap|NativeExitReview;
export function isNativeExit(r:DirectExitReview):r is NativeExitReview{return 'kind' in r&&(r.kind==='token2022'||r.kind==='standard-native');}
// The larger sell bound comes ONLY from separately signed direct-order terms.
// Copy trading separately derives its amount from credited plan inventory.
export function verifyNativeExit(t:DirectExitTerms,r:NativeExitReview){
  validateExitTerms(t);
  if(t.version===1)throw Error('This order does not approve wrapped SOL proceeds.');
  if((t.version===5||t.version===6)){if((r.native.accounts.tokenProgram??TOKEN_2022)!==t.tokenProgram||r.kind!==(t.tokenProgram===TOKEN_PROGRAM?'standard-native':'token2022'))throw Error('Order token program changed.');}
  else if(t.version===2?(r.kind!=='token2022'||r.native.version!==1||r.native.accounts.tokenProgram!==undefined):(r.kind!=='standard-native'||(r.native.version!==2&&!(t.version===4&&r.native.version===3))||r.native.accounts.tokenProgram!==TOKEN_PROGRAM))throw Error('Order token program changed.');
  const wire=nativeReviewBuild(r.native,r.nativeHash,t.amountRaw,isLimitBuy(t)?t.amountRaw:undefined),a=r.native.accounts;
  if(a.direction!==(isLimitBuy(t)?'buy':'sell')||a.wallet!==t.wallet||a.mint!==t.mint||a.inputRaw!==t.amountRaw||a.decimals!==t.tokenDecimals||
    r.unsigned!==r.native.unsigned||r.messageHash!==r.native.messageHash||r.minimum!==a.minimum||wire.build.inAmount!==a.inputRaw||wire.build.otherAmountThreshold!==a.minimum||
    r.intent.wallet!==t.wallet||r.intent.inputMint!==exitInputMint(t)||r.intent.outputMint!==exitProceeds(t).mint||r.intent.inputRaw!==a.inputRaw||
    r.intent.minOutputRaw!==a.minimum||r.intent.slippageBps!==t.slippageBps||wire.request.slippageBps>t.slippageBps||
    r.intent.maxNetworkFeeLamports!==t.maxFeeLamports||r.intent.expiresAt!==r.native.expiresAt||
    r.intent.expiresAt>t.expiresAt||r.lifetime.blockhash!==wire.blockhash||r.lifetime.slot!==r.native.minContextSlot||
    r.lifetime.lastValidBlockHeight!==r.native.lastValidBlockHeight||BigInt(r.native.feeLamports)>exitRaw(t.maxFeeLamports)||
    (r.native.wrappedCreated?exitRaw(r.native.wrappedReserve):0n)+BigInt(r.native.tokenRent)+BigInt(r.native.pumpTracker?.rent??0)+BigInt(r.native.curve?.trackerRent??0)+BigInt(r.native.curve?.curveRent??0)>exitRaw(t.maxRentLamports,true))throw Error('Native exit differs from its signed terms.');
  return wire;
}
type Simulated=Pick<Awaited<ReturnType<typeof simulateRaydium22Swap>>,'receivedRaw'|'slot'|'networkFeeLamports'|'rentLamports'>;
function observation(t:DirectExitTerms,r:NativeExitReview,s:Simulated):ExitQuote{
  const wire=nativeReviewBuild(r.native,r.nativeHash,t.amountRaw,isLimitBuy(t)?t.amountRaw:undefined),quoted=BigInt(wire.build.outAmount),simulated=BigInt(s.receivedRaw);
  return {review:r,observation:{outputRaw:String(quoted<simulated?quoted:simulated),minimumRaw:r.minimum,slot:s.slot,checkedAt:Date.now()},feeLamports:String(s.networkFeeLamports),rentLamports:String(s.rentLamports),tokenDecimals:r.native.accounts.decimals};
}
export function nativeDirectExitSwap(rpc:Rpc,apiKey:string,fetcher:typeof fetch=fetch){
  return {
    async quote(t:DirectExitTerms,signal:AbortSignal):Promise<ExitQuote>{
      validateExitTerms(t);signal.throwIfAborted();
      if(t.version===1||await rpc('getGenesisHash',[])!==MAINNET_GENESIS)throw Error('Native exits require an approved mainnet order.');
      const expiresAt=Math.min(t.expiresAt,Date.now()+30000);
      const request={wallet:t.wallet,mint:t.mint,direction:(isLimitBuy(t)?'buy':'sell') as 'buy'|'sell',inputRaw:t.amountRaw,minOutputRaw:'1',slippageBps:t.slippageBps};
      let simulated;
      if((t.version===5||t.version===6)&&await hasActivePumpCurve(t.mint,rpc)){
        const result=await simulateCurveSwap({wallet:t.wallet,mint:t.mint,direction:request.direction,inputRaw:t.amountRaw,slippageBps:t.slippageBps},rpc,undefined,exitRaw(t.maxFeeLamports)>=10000n?5000:0,isLimitBuy(t)?t.amountRaw:undefined);
        result.review.expiresAt=expiresAt;simulated=curveNativeResult(result);
      }else{
        // As in copying, quote tighter than the signed maximum so a small
        // favorable move does not consume the order at independent review.
        request.slippageBps=nativeQuoteSlippage(t.slippageBps);
        const standard='tokenProgram' in t&&t.tokenProgram===TOKEN_PROGRAM;
        const build=await fetchNativeBuild(request,apiKey,expiresAt,signal,fetcher,t.amountRaw,t.version>=4&&standard,isLimitBuy(t)?t.amountRaw:undefined);
        const priority=exitRaw(t.maxFeeLamports)>=7000n?NATIVE_PRIORITY_MICROLAMPORTS:0;
        signal.throwIfAborted();const pump=isPumpNativeBuild(build);if(pump&&(t.version<4||!standard))throw Error('PumpSwap is outside this order.');
        simulated=await(pump?simulatePumpNativeSwap:standard?simulateStandardNativeSwap:simulateRaydium22Swap)(build,request,rpc,t.amountRaw,false,priority,false,isLimitBuy(t)?t.amountRaw:undefined);
      }
      signal.throwIfAborted();const native={...simulated.executionReview,expiresAt},nativeHash=raydium22ReviewHash(native);
      const wire=nativeReviewBuild(native,nativeHash,t.amountRaw,isLimitBuy(t)?t.amountRaw:undefined);
      const review:NativeExitReview={kind:native.accounts.tokenProgram===TOKEN_PROGRAM?'standard-native':'token2022',native,nativeHash,unsigned:native.unsigned,messageHash:native.messageHash,minimum:native.accounts.minimum,
        lifetime:{blockhash:wire.blockhash,slot:native.minContextSlot,lastValidBlockHeight:native.lastValidBlockHeight},
        intent:{wallet:t.wallet,inputMint:exitInputMint(t),outputMint:exitProceeds(t).mint,inputRaw:t.amountRaw,minOutputRaw:native.accounts.minimum,slippageBps:t.slippageBps,maxNetworkFeeLamports:t.maxFeeLamports,expiresAt}};
      verifyNativeExit(t,review);return observation(t,review,simulated);
    },
    async recheck(t:DirectExitTerms,review:NativeExitReview,signal:AbortSignal):Promise<ExitQuote>{
      verifyNativeExit(t,review);signal.throwIfAborted();
      const simulated=await rebuildNativeReview(review.native,review.nativeHash,rpc,t.amountRaw,t.slippageBps,isLimitBuy(t)?t.amountRaw:undefined);
      signal.throwIfAborted();return observation(t,review,simulated);
    },
  };
}
