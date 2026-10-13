import {decodeEventLog,decodeFunctionData,encodeFunctionData,encodePacked,getCreate2Address,keccak256,parseAbi,toEventSelector} from 'viem';
import type {CashLeaderBalance} from './cash-leader-receipt.js';
import type {Rpc} from './funding.js';
import {cashReturnNetwork,ZEROX_ALLOWANCE_HOLDER} from './cash-return-networks.js';
export const cashZeroV2Abi={
 transfer:parseAbi(['function TRANSFER_FROM(address recipient,((address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permit,bytes sig)']),
 swap:parseAbi(['function UNISWAPV2(address recipient,address sellToken,uint256 ppm,address pool,uint24 swapInfo,uint256 amountOutMin)']),
 event:parseAbi(['event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)']),
};
const factory='0xca143ce32fe78f1f7019d7d551a6402fc5350c73';
// Factory/init code from PancakeSwap's official SDK. Runtime hashes checked at
// BNB block 0x795fe29 through independent public RPCs. Changed code fails closed.
const initHash='0x00fb7f630766e6a796048ea87d01acd3068e8ff67d078148a3fa3f4a84f69bd5';
const hashes={holder:'0x99f5e8edaceacfdd183eb5f1da8a7757b322495b80cf7928db289a1b1a09f799',settler:'0xf89c12a28b43e982a9bb5e82beba5d077ec2c42cae6cbe3cba9361ad093e401d',pool:'0x60e4bcb14447615ab7c14fda2c2d70ca4191570e8841c75618e627c8f72662f8',factory:'0x9e8d17faaee69b053be6ac65b2b2c317741d770cb5fbdd9512536d17e9e076ca'};
const same=(a:unknown,b:string)=>typeof a==='string'&&a.toLowerCase()===b.toLowerCase();
const transferTopic='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const word=(address:string)=>'0x'+address.slice(2).padStart(64,'0');
function decode(abi:any,data:string):any{
 const decoded=decodeFunctionData({abi,data:data as `0x${string}`});
 if(!same(encodeFunctionData({abi,functionName:decoded.functionName,args:decoded.args}),data))throw Error('Noncanonical direct pool action.');
 return decoded.args;
}
/** Narrow 0x direct-pool route whose slippage is enforced in its final action,
 * not the empty top-level payout tuple. The caller still verifies the official
 * Settler registry, Relay proxy, solver funding and final token delivery. */
export async function cashLeaderZeroV2Minimum(b:CashLeaderBalance,rpc:Rpc,settler:string,actions:readonly string[],amount:bigint):Promise<bigint>{
 if(b.network!=='bnb'||actions.length!==2)throw Error('Unsupported direct pool fill.');
 const cfg=cashReturnNetwork(b.network),[fundTo,permit,sig]=decode(cashZeroV2Abi.transfer,actions[0]);
 const [recipient,sellToken,ppm,pool,swapInfo,minimum]=decode(cashZeroV2Abi.swap,actions[1]);
 const token0=cfg.usdc<b.token?cfg.usdc:b.token,token1=cfg.usdc<b.token?b.token:cfg.usdc;
 const zeroForOne=cfg.usdc===token0;
 const computed=getCreate2Address({from:factory,salt:keccak256(encodePacked(['address','address'],[token0 as `0x${string}`,token1 as `0x${string}`])),bytecodeHash:initHash});
 if(!same(pool,computed)||!same(fundTo,pool)||!same(permit.permitted.token,cfg.usdc)||permit.permitted.amount!==amount||permit.nonce!==0n||permit.deadline<BigInt(Math.floor(b.blockTime/1000))||sig!=='0x'||!same(recipient,cfg.router)||!same(sellToken,cfg.usdc)||ppm!==0n||swapInfo!==25*256+(zeroForOne?1:0)||minimum<=0n||minimum>BigInt(b.deltaRaw))throw Error('Direct pool fill differs.');
 await Promise.all([[ZEROX_ALLOWANCE_HOLDER,hashes.holder],[settler,hashes.settler],[pool.toLowerCase(),hashes.pool],[factory,hashes.factory]].map(async([address,expected])=>{
  const code=await rpc('eth_getCode',[address,b.blockNumber]);
  if(typeof code!=='string'||!/^0x(?:[0-9a-f]{2})+$/i.test(code)||keccak256(code as `0x${string}`)!==expected)throw Error('Direct pool deployment changed.');
 }));
 let funded=0n,received=0n,swaps=0;
 for(const log of b.receipt.logs){
  if(same(log.topics?.[0],transferTopic)&&same(log.address,cfg.usdc)&&same(log.topics?.[2],word(pool))){
   if(log.topics.length!==3||!same(log.topics[1],word(cfg.router))||!/^0x[0-9a-f]{64}$/i.test(log.data))throw Error('Direct pool input differs.');funded+=BigInt(log.data);
  }
  if(same(log.topics?.[0],transferTopic)&&same(log.address,b.token)&&same(log.topics?.[1],word(pool))){
   if(log.topics.length!==3||!same(log.topics[2],word(cfg.router))||!/^0x[0-9a-f]{64}$/i.test(log.data))throw Error('Direct pool output differs.');received+=BigInt(log.data);
  }
  if(same(log.address,pool)&&same(log.topics?.[0],toEventSelector(cashZeroV2Abi.event[0]))){
   const {args}=decodeEventLog({abi:cashZeroV2Abi.event,data:log.data,topics:log.topics,strict:true});
   if(++swaps!==1||!same(args.sender,settler)||!same(args.to,cfg.router)||(zeroForOne?args.amount0In:args.amount1In)!==amount||(zeroForOne?args.amount1In:args.amount0In)!==0n||(zeroForOne?args.amount0Out:args.amount1Out)!==0n||(zeroForOne?args.amount1Out:args.amount0Out)!==BigInt(b.deltaRaw))throw Error('Direct pool swap evidence differs.');
  }
 }
 if(swaps!==1||funded!==amount||received!==BigInt(b.deltaRaw))throw Error('Direct pool amounts differ.');
 return minimum;
}
