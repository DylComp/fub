import {rawLamports} from './launch-payout-model.js';
import type {QuoteFeeAsset} from './launch-quote-fees.js';
import type {QuoteFeeValuation} from './launch-quote-chain.js';
import {SOL_PAIR_MINT} from '../src/launch-pairs.js';
// A read-only executable-route estimate gates network-fee spending. It does
// not swap the recipient's fees, credit SOL revenue, or authorize conversion.
export function quoteFeeValuation(key:string,signal:AbortSignal,request:typeof fetch=fetch,now=Date.now){
 return async(asset:QuoteFeeAsset,inputRaw:string,minSlot:number):Promise<QuoteFeeValuation>=>{
  if(!key||rawLamports(inputRaw)===0n||!Number.isSafeInteger(minSlot)||minSlot<1)throw Error('Quote valuation configuration unavailable.');
  signal.throwIfAborted();
  const started=now(),query=new URLSearchParams({inputMint:asset.mint,outputMint:SOL_PAIR_MINT,amount:inputRaw,slippageBps:'100',swapMode:'ExactIn'});
  const response=await request(`https://api.jup.ag/swap/v1/quote?${query}`,{headers:{'x-api-key':key},cache:'no-store',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(8000)])});
  if(!response.ok||!response.body||Number(response.headers.get('content-length'))>131072)throw Error('Quote valuation unavailable.');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){signal.throwIfAborted();const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>131072)throw Error('Quote valuation exceeded limit.');chunks.push(value);}}finally{await reader.cancel();}
  const v=JSON.parse(Buffer.concat(chunks).toString('utf8')),checkedAt=now();
  if(checkedAt<started||checkedAt-started>10000||v.inputMint!==asset.mint||v.outputMint!==SOL_PAIR_MINT||v.inAmount!==inputRaw||v.swapMode!=='ExactIn'||v.slippageBps!==100||!Number.isSafeInteger(v.contextSlot)||v.contextSlot<minSlot||!Array.isArray(v.routePlan)||!v.routePlan.length||v.routePlan.length>12||v.platformFee&&rawLamports(v.platformFee.amount)!==0n)throw Error('Quote valuation identity or freshness mismatch.');
  const output=rawLamports(v.outAmount),minimum=rawLamports(v.otherAmountThreshold);
  if(output===0n||minimum===0n||minimum>output||minimum>output*99n/100n+1n)throw Error('Quote valuation output is invalid.');
  return{asset:{...asset},inputRaw,minimumSolLamports:minimum.toString(),slot:v.contextSlot,checkedAt};
 };
}
