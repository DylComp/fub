import {Connection} from '@solana/web3.js';
import {MAINNET_GENESIS} from './solana-network.js';
import {rawLamports,verifyPayoutSignature} from './launch-payout-model.js';
import {prepareQuoteFees,quoteFeeReceipt,readQuoteFees,verifyQuoteFeePlan,type QuoteFeeAsset} from './launch-quote-fees.js';
import type {QuoteFeeChain} from './launch-quote-worker.js';
import {recoverWorkerReceipt} from './worker-block-recovery.js';
import type {Rpc} from './funding.js';
// A price estimate gates gas spending only. It cannot change payout amounts or
// destinations, which always come from Pump's permanent on-chain 80/20 split.
export type QuoteFeeValuation={asset:QuoteFeeAsset;inputRaw:string;minimumSolLamports:string;slot:number;checkedAt:number};
export function validateQuoteFeeValuation(v:QuoteFeeValuation,asset:QuoteFeeAsset,raw:bigint,slot:number,now:number){
 if(v.asset.mint!==asset.mint||v.asset.tokenProgram!==asset.tokenProgram||v.asset.decimals!==asset.decimals||rawLamports(v.inputRaw)!==raw||
  !Number.isSafeInteger(v.slot)||v.slot<slot||!Number.isSafeInteger(v.checkedAt)||v.checkedAt>now||now-v.checkedAt>15000)throw Error('Stale or mismatched quote-fee valuation.');
 return rawLamports(v.minimumSolLamports)>=3000000n;
}
export function launchQuoteChain(c:Connection,options:{payer:string;value:(asset:QuoteFeeAsset,raw:string,minSlot:number)=>Promise<QuoteFeeValuation>;recoveryRpc?:()=>Rpc;now?:()=>number}):QuoteFeeChain{
 const mainnet=async()=>{if(await c.getGenesisHash()!==MAINNET_GENESIS)throw Error('Mainnet required.');};
 return{
  async prepare(route){
   const snapshot=await readQuoteFees(c,route);if(snapshot.availableRaw===0n)return null;
   const value=await options.value(route.asset,snapshot.availableRaw.toString(),snapshot.slot);
   if(!validateQuoteFeeValuation(value,route.asset,snapshot.availableRaw,snapshot.slot,(options.now??Date.now)()))return null;
   // Re-read during preparation, requiring at least the amount just valued.
   return prepareQuoteFees(c,route,options.payer,snapshot.availableRaw.toString());
  },
  async reconcile(route,a){
   await mainnet();await verifyQuoteFeePlan(route,a.payer,a);
   if(verifyPayoutSignature(a,a.signed,a.payer)!==a.signature)throw Error('Quote-fee signature mismatch.');
   let tx=await c.getTransaction(a.signature,{commitment:'finalized',maxSupportedTransactionVersion:0}).catch(error=>{if(!options.recoveryRpc)throw error;return null;});
   if(!tx&&options.recoveryRpc)tx=await recoverWorkerReceipt({signature:a.signature,signed:a.signed,minContextSlot:a.contextSlot},options.recoveryRpc());
   if(tx){const receipt=await quoteFeeReceipt(route,a,tx);return receipt?{kind:'confirmed',receipt}:{kind:'failed'};}
   return{kind:await c.getBlockHeight('finalized')>a.lastValidBlockHeight?'expired_unresolved':'pending'};
  },
  async send(route,a){
   await mainnet();if(a.payer!==options.payer)throw Error('Quote-fee payer mismatch.');
   await verifyQuoteFeePlan(route,a.payer,a);if(verifyPayoutSignature(a,a.signed,a.payer)!==a.signature)throw Error('Quote-fee signature mismatch.');
   if(await c.getBlockHeight('confirmed')>a.lastValidBlockHeight)return'expired';
   const signature=await c.sendRawTransaction(Buffer.from(a.signed,'base64'),{skipPreflight:false,preflightCommitment:'confirmed'});
   if(signature!==a.signature)throw Error('Quote-fee submission mismatch.');return'sent';
  }
 };
}
