import {pacedQuoteFetch} from './paced-quote-fetch.js';
import { USDC } from '../src/funding-model.js';
import type { DirectExitTerms } from '../src/direct-exits.js';
import { validateExitTerms } from '../src/direct-exits.js';
import { prepareCopySwap, revalidateCopyReview, preflightCopySwap } from './copy-swap.js';
import type { Rpc } from './funding.js';
import type { ExitQuote } from './direct-exit-engine.js';
import {isNativeExit,nativeDirectExitSwap} from './direct-exit-native.js';
// Jupiter is a swap router here. All debits and proceeds belong to the same
// existing Solana wallet. This does not use Jupiter Trigger or its vault.
export function directExitSwap(rpc:Rpc,apiKey:string){
  const fetcher=pacedQuoteFetch(),native=nativeDirectExitSwap(rpc,apiKey,fetcher);
  const quoteOf=(prepared:Awaited<ReturnType<typeof prepareCopySwap>>):ExitQuote=>{
    const {review,preflight:p}=prepared;
    const quoted=BigInt(review.buildEvidence.outAmount as string),simulated=BigInt(p.simulation.outputRaw);
    // Stops use the lower executable result, and targets require the encoded
    // minimum. Simulation is not a guarantee that a later transaction will fill.
    const output=quoted<simulated?quoted:simulated;
    const minimum=quoted*BigInt(10000-review.intent.slippageBps)/10000n;
    return {review,observation:{outputRaw:output.toString(),minimumRaw:minimum.toString(),slot:p.simulation.slot,checkedAt:p.checkedAt},feeLamports:p.feeLamports,rentLamports:p.rentLamports,tokenDecimals:p.input.decimals};
  };
  return {
    async quote(t:DirectExitTerms,signal:AbortSignal):Promise<ExitQuote>{
      validateExitTerms(t);signal.throwIfAborted();
      if(t.version!==1)return native.quote(t,signal);
      const prepared=await prepareCopySwap({wallet:t.wallet,inputMint:t.mint,outputMint:USDC,inputRaw:t.amountRaw,minOutputRaw:'1',slippageBps:t.slippageBps,maxNetworkFeeLamports:t.maxFeeLamports,expiresAt:Math.min(t.expiresAt,Date.now()+30000)},rpc,apiKey,signal,fetcher);
      signal.throwIfAborted();return quoteOf(prepared);
    },
    async recheck(t:DirectExitTerms,q:ExitQuote,signal:AbortSignal):Promise<ExitQuote>{
      validateExitTerms(t);signal.throwIfAborted();
      if(isNativeExit(q.review))return native.recheck(t,q.review,signal);
      if(t.version!==1)throw Error('Exit adapter does not match its approval.');
      const review=await revalidateCopyReview(q.review,q.review.intent,rpc);
      const preflight=await preflightCopySwap(review,rpc);
      signal.throwIfAborted();return quoteOf({review,preflight});
    },
  };
}
