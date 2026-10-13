import {parseAbi} from 'viem';
import type {CashLeaderBalance} from './cash-leader-receipt.js';
import type {Rpc} from './funding.js';
import {cashReturnNetwork} from './cash-return-networks.js';
import {cashZeroMonadAbi} from './cash-leader-zero-monad-sale.js';
import {verifyLeaderZeroRegistry} from './cash-leader-zero-sale.js';
import {ARC_RECEIPT,arcDecode,arcLogs,arcOne,arcPins,arcPoolId,arcSame,arcTransfers,arcTransfer,arcWord} from './cash-leader-arc-receipt.js';
// The terminal selector matches the published signature database, but its
// source is unverified. This is only a canonical byte-layout restriction.
// The enforced sale minimum below is the known outer Settler commitment.
export const cashArcSaleAbi={vip:parseAbi(['function UNISWAPV4_VIP(address recipient,((address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permit,bool feeOnTransfer,uint256 hashMul,uint256 hashMod,bytes fills,bytes sig,uint256 amountOutMin)']),swap:parseAbi(['function swap(address tokenIn,address tokenOut,int256 encodedAmount,uint256 encodedLimit,address recipient)'])};
const settlerAddress='0xb6a575ed3bb629a44b9ad24a4b0a2147f32c5424',terminal='0xcc856766ca2598d225a31420bd2e46c4783539dd',reserve='0xa74b86db79fb8161ac903365161235854da70cd4';
/** Authenticated 0x V4 VIP trade followed by the observed cirBTC/USDC adapter.
 * The reserve is an external account, not an AMM. Its output is proved by
 * real USDC transfers, the pinned settlement adapter, and the outer minimum. */
export async function cashLeaderZeroArcSale(b:CashLeaderBalance,rpc:Rpc,settler:string,actions:readonly string[],spent:bigint,slippage:{recipient:string;buyToken:string;minAmountOut:bigint}){
 const a=ARC_RECEIPT,cfg=cashReturnNetwork(b.network);
 if(b.network!=='arc'||b.token<=a.middle||!arcSame(settler,settlerAddress)||actions.length!==2||!arcSame(slippage.recipient,cfg.router)||!arcSame(slippage.buyToken,cfg.usdc)||slippage.minAmountOut<=0n)throw Error('Unsupported Arc sale path.');
 const [recipient,permit,feeOnTransfer,hashMul,hashMod,fills,sig,min]=arcDecode(cashArcSaleAbi.vip,actions[0]);
 const [sell,ppm,target,offset,data]=arcDecode(cashZeroMonadAbi.basic,actions[1]);
 const [tokenIn,tokenOut,quotedAmount,minimum,receiver]=arcDecode(cashArcSaleAbi.swap,data);
 if(!arcSame(recipient,settler)||!arcSame(permit.permitted.token,b.token)||permit.permitted.amount!==spent||permit.nonce!==0n||permit.deadline<BigInt(Math.floor(b.blockTime/1000))||feeOnTransfer||hashMul!==2n||hashMod!==18446744073709551557n||sig!=='0x'||min!==0n||!arcSame(sell,a.middle)||ppm!==1000000n||!arcSame(target,terminal)||offset!==68n||!arcSame(tokenIn,a.middle)||!arcSame(tokenOut,cfg.usdc)||quotedAmount<=0n||minimum<=0n||minimum>slippage.minAmountOut||!arcSame(receiver,settler))throw Error('Arc sale action differs.');
 if(typeof fills!=='string'||!/^0x[0-9a-f]{146}$/i.test(fills))throw Error('Unsupported Arc sale fill.');
 const bytes=Buffer.from(fills.slice(2),'hex'),num=(start:number,end:number)=>BigInt('0x'+bytes.subarray(start,end).toString('hex'));
 if(num(0,3)!==1000000n||num(3,23)===0n||bytes[23]!==1||!arcSame('0x'+bytes.subarray(24,44).toString('hex'),a.middle)||num(44,47)!==2500n||num(47,50)!==25n||num(50,70)!==0n||num(70,73)!==0n)throw Error('Arc V4 sale path differs.');
 await Promise.all([arcPins(rpc,b,ARC_SALE_PINS),verifyLeaderZeroRegistry(settler,b.blockNumber,rpc)]);
 const logs=arcLogs(b),v4=arcOne(logs,a.manager,cashZeroMonadAbi.v4Swap),middle=v4.amount0;
 const outputTransfers=logs.filter((l:any)=>arcSame(l.address,cfg.usdc)&&arcSame(l.topics?.[0],arcTransfer)&&arcSame(l.topics?.[1],arcWord(reserve))&&arcSame(l.topics?.[2],arcWord(settler)));
 if(outputTransfers.length!==1||!/^0x[0-9a-f]{64}$/i.test(outputTransfers[0].data))throw Error('Arc sale output missing.');
 const output=BigInt(outputTransfers[0].data);
 if(!arcSame(v4.sender,settler)||!arcSame(v4.id,arcPoolId(b.token))||middle<=0n||v4.amount1!==-spent||v4.fee<2500||v4.fee>3498||output<slippage.minAmountOut)throw Error('Arc sale settlement differs.');
 arcTransfers(logs,[[b.token,b.leader,cfg.router,spent],[b.token,cfg.router,a.manager,spent],[a.middle,a.manager,settler,middle],[a.middle,settler,reserve,middle],[cfg.usdc,reserve,settler,output],[a.native,reserve,settler,output*1000000000000n],[cfg.usdc,settler,cfg.router,output],[a.native,settler,cfg.router,output*1000000000000n],[cfg.usdc,cfg.router,cfg.depository,output],[a.native,cfg.router,cfg.depository,output*1000000000000n]]);
 return{minimum:slippage.minAmountOut,output};
}
const ARC_SALE_PINS:Record<string,string>={"0x8366a39cc670b4001a1121b8f6a443a643e40951": "0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626", "0xcc856766ca2598d225a31420bd2e46c4783539dd": "0x5641eebeca6dff2b2a44777b638db94e738453a03e9b1d156ecbdb77dccb8829", "0xf7ed56fb49dfb09b9e8558c40ef707da155333b9": "0x86c81c8a9ada65ff537601339e773ab18d511067d9a2354a22a8c0a4a6fbf14d", "0xb6a575ed3bb629a44b9ad24a4b0a2147f32c5424": "0x64b5e8595d5c413b587c0fde0b7798900c12918e7e28336d86a358879ffba132", "0x0000000000001ff3684f28c67538d4d072c22734": "0x99f5e8edaceacfdd183eb5f1da8a7757b322495b80cf7928db289a1b1a09f799"};
