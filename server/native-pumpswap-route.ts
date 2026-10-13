import {record} from '../src/live-orders.js';
import {isMint} from '../src/assets.js';
import {TOKEN_PROGRAM,WSOL} from '../src/funding-model.js';
import {associated} from '../src/transaction-review.js';
import {COPY_SWAP_PROGRAM,decodeCopyRoute,instructionBytes,swapInstruction,swapRaw} from '../src/copy-swap.js';
import {checkPumpSegment} from '../src/copy-pumpswap.js';
import {verifyPumpSegments} from './copy-pumpswap.js';
import type {Raydium22Request} from './token2022-raydium.js';
import type {Rpc} from './funding.js';

const invalid=():never=>{throw Error('Native PumpSwap route or fee recipients changed.');};
// A direct standard-SPL/WSOL pool only. Provider setup, cleanup and lookups
// never enter the transaction; native setup is constructed independently.
export async function inspectNativePumpSwapRoute(value:unknown,request:Raydium22Request,rpc:Rpc,minContextSlot:number){
 const {wallet,mint,direction,slippageBps}=request,buy=direction==='buy';
 if(![wallet,mint].every(isMint)||mint===WSOL||!['buy','sell'].includes(direction)||!Number.isInteger(slippageBps)||slippageBps<10||slippageBps>500)return invalid();
 const inputMint=buy?WSOL:mint,outputMint=buy?mint:WSOL,b=record(value),input=swapRaw(request.inputRaw),output=swapRaw(b.outAmount),numerator=output*BigInt(10000-slippageBps),minimum=numerator/10000n,providerMinimum=swapRaw(b.otherAmountThreshold);
 if(b.inputMint!==inputMint||b.outputMint!==outputMint||b.swapMode!=='ExactIn'||swapRaw(b.inAmount)!==input||b.slippageBps!==slippageBps||minimum<swapRaw(request.minOutputRaw)||(providerMinimum!==minimum&&providerMinimum!==(numerator+9999n)/10000n))return invalid();
 const swap=swapInstruction(b.swapInstruction,wallet),route=decodeCopyRoute(instructionBytes(swap.data));
 const pumpV4=route.steps[0]?.variant===(buy?193:194);
 if(swap.programId!==COPY_SWAP_PROGRAM||route.kind!=='direct'||route.intermediateNode!==undefined||route.steps.length!==1||route.steps[0].variant!==(pumpV4?(buy?193:194):(buy?99:100))||route.steps[0].input!==0||route.steps[0].output!==route.terminal||route.steps[0].bps!==10000||route.input!==input||route.output!==output||route.slippageBps!==slippageBps)return invalid();
 const [source,destination]=await Promise.all([associated(wallet,inputMint),associated(wallet,outputMint)]);
 const header=[wallet,source,destination,inputMint,outputMint,TOKEN_PROGRAM,TOKEN_PROGRAM,COPY_SWAP_PROGRAM,'D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf',COPY_SWAP_PROGRAM];
 if(header.some((key,i)=>swap.accounts[i]?.pubkey!==key||swap.accounts[i].isSigner!==(i===0)||swap.accounts[i].isWritable!==[1,2].includes(i)))return invalid();
 const segment=swap.accounts.slice(10,-1),end=swap.accounts.at(-1);
 if(!end||end.pubkey!==COPY_SWAP_PROGRAM||end.isSigner||end.isWritable)return invalid();
 checkPumpSegment(segment,wallet,source,destination,buy,pumpV4);
 if(segment[4].pubkey!==mint||segment[5].pubkey!==WSOL||!Array.isArray(b.routePlan)||b.routePlan.length!==1)return invalid();
 const plan=record(b.routePlan[0]),info=record(plan.swapInfo);
 if(plan.bps!==10000||info.label!=='Pump.fun Amm'||info.ammKey!==segment[1].pubkey||info.inputMint!==inputMint||info.outputMint!==outputMint||swapRaw(info.inAmount)!==input||swapRaw(info.outAmount)!==output)return invalid();
 const shift=buy?2:0;
 const v4Evidence: {buy:boolean;poolBefore?:Buffer;feeOwner?:string}|undefined=pumpV4?{buy}:undefined;
 const missingUserTrackers=new Set<string>();
 const slot=await verifyPumpSegments([segment],wallet,rpc,minContextSlot,missingUserTrackers,v4Evidence);
 const fees=pumpV4?[{account:segment[15].pubkey,owner:v4Evidence!.feeOwner!}]:[{account:segment[11].pubkey,owner:segment[10].pubkey},{account:segment[18].pubkey,owner:segment[19].pubkey},{account:segment[25+shift].pubkey,owner:segment[24+shift].pubkey}];
 const inputVault=segment[buy?9:8].pubkey,outputVault=segment[buy?8:9].pubkey,pool=segment[1].pubkey;
 const distinct=[wallet,mint,WSOL,source,destination,pool,inputVault,outputVault,...fees.flatMap(f=>[f.account,f.owner])];
 if(new Set(distinct).size!==distinct.length)return invalid();
 const missingTracker=[...missingUserTrackers][0];
 return {pumpV4,poolBefore:v4Evidence?.poolBefore,swap,segments:[segment],source,destination,pool,inputVault,outputVault,fees,missingTracker,minimum:minimum.toString(),output:output.toString(),slot};
}
