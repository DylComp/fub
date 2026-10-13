// Unsigned operator preflight, shared by the new venue acceptance commands.
import {type ControlledTestPolicy} from './controlled-leader-test.js';
import {simulateCurveSwap,hasActivePumpCurve} from './pump-curve-execution.js';
import {curveNativeResult} from './token2022-recovery.js';
import {fetchNativeBuild,isPumpNativeBuild,nativeQuoteSlippage} from './token2022-prepare-worker.js';
import {simulateRaydium22Swap,simulateStandardNativeSwap,simulatePumpNativeSwap} from './token2022-raydium-simulation.js';
import {MAINNET_GENESIS} from './solana-network.js';
import type{Rpc}from './funding.js';
export async function simulateControlledVenue(policy:ControlledTestPolicy,wallet:string,side:'buy'|'sell',inputRaw:string,rpc:Rpc,apiKey:string,followProductionRouting=false){
 if(await rpc('getGenesisHash',[])!==MAINNET_GENESIS)throw Error('Mainnet is required.');
 const request={wallet,mint:policy.mint,direction:side,inputRaw,minOutputRaw:'1',slippageBps:Number(policy.slippageBps)};
 if(followProductionRouting&&policy.venue&&(await hasActivePumpCurve(policy.mint,rpc))!==(policy.venue==='pump-curve'))throw Error('Production curve selection differs from the test venue.');
 if(policy.venue==='pump-curve'){
  const result=await simulateCurveSwap({wallet,mint:policy.mint,direction:side,inputRaw,slippageBps:policy.slippageBps},rpc);
  return{...curveNativeResult(result),minimumRaw:result.review.minimumRaw,transactionBytes:result.transactionBytes};
 }
 if(followProductionRouting)request.slippageBps=nativeQuoteSlippage(policy.slippageBps);
 const build=await fetchNativeBuild(request,apiKey,Date.now()+15000,AbortSignal.timeout(15000),fetch,side==='sell'?inputRaw:undefined,policy.venue==='pumpswap'||followProductionRouting&&policy.venue==='raydium-standard');
 if(isPumpNativeBuild(build)!==(policy.venue==='pumpswap'))throw Error('Test venue changed.');
 return (policy.venue==='pumpswap'?simulatePumpNativeSwap:policy.venue==='raydium-standard'?simulateStandardNativeSwap:simulateRaydium22Swap)(build,request,rpc,side==='sell'&&policy.venue?inputRaw:undefined,side==='sell',5000,followProductionRouting);
}
