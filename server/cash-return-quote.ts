import {cashReturnRequest,type CashReturnIntent} from './cash-return-route.js';
import {simulateCashReturn} from './cash-return-simulation.js';
import type {Rpc} from './funding.js';

// Only for a NEW unsigned review. Signed attempts and saved nonces keep their
// original bytes and go through the service's existing recheck/recovery path.
export async function prepareCashReturnQuote(intent:CashReturnIntent,quote:(body:unknown)=>Promise<unknown>,rpc:Rpc,now=Date.now(),simulate=simulateCashReturn){
 const request=cashReturnRequest(intent),primary=await quote(request);
 try{return {quote:primary,simulation:await simulate(primary,intent,rpc,now)};}
 catch(error){
  // A provider may choose a pool outside our pinned factories. Keep that
  // rejection and independently inspect one supported alternative instead.
  if(intent.network!=='bnb'||!(error instanceof Error)||error.message!=='Cash sale source pool changed.')throw error;
 }
 const alternative=await quote({...request,includedOriginSwapSources:['0x']});
 const simulation=await simulate(alternative,intent,rpc,now);
 if(simulation.route.adapter!=='0x')throw Error('The alternative sale route is unavailable.');
 return {quote:alternative,simulation};
}
