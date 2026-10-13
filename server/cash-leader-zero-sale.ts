import {decodeFunctionData,encodeFunctionData,decodeEventLog,encodeAbiParameters,keccak256,parseAbi,parseAbiParameters,toEventSelector} from 'viem';
import type {CashLeaderBalance} from './cash-leader-receipt.js';
import type {Rpc} from './funding.js';
import {cashReturnNetwork,ZEROX_ALLOWANCE_HOLDER,ZEROX_DEPLOYER} from './cash-return-networks.js';
import {cashZeroV2Abi} from './cash-leader-zero-v2.js';
export const cashZeroSaleAbi={
 infinity:parseAbi(['function PANCAKE_INFINITY(address recipient,address sellToken,uint256 ppm,bool feeOnTransfer,uint256 hashMul,uint256 hashMod,bytes fills,uint256 amountOutMin)']),
 v4:parseAbi(['function UNISWAPV4(address recipient,address sellToken,uint256 ppm,bool feeOnTransfer,uint256 hashMul,uint256 hashMod,bytes fills,uint256 amountOutMin)']),
 v4Swap:parseAbi(['event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)']),
 maverick:parseAbi(['function MAVERICKV2(address recipient,address sellToken,uint256 ppm,address pool,bool tokenAIn,int32 tickLimit,uint256 minBuyAmount)']),
 infinitySwap:parseAbi(['event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee,uint16 protocolFee)']),
};
const usdt='0x55d398326f99059ff775485246999027b3197955',vault='0x238a358808379702088667322f80ac48bad5e6c4',manager='0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b',pool='0x0843924689e0451885633c31cd135658e2ec3eea';
const same=(a:unknown,b:string)=>typeof a==='string'&&a.toLowerCase()===b.toLowerCase();
const word=(a:string)=>'0x'+a.slice(2).padStart(64,'0');
const transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
function decode(abi:any,data:string):any{const d=decodeFunctionData({abi,data:data as `0x${string}`});if(!same(encodeFunctionData({abi,functionName:d.functionName,args:d.args}),data))throw Error('Noncanonical 0x sale action.');return d.args;}
export async function verifyLeaderZeroRegistry(settler:string,block:string,rpc:Rpc){
 const current=await rpc('eth_call',[{to:ZEROX_DEPLOYER,data:'0x6352211e'+'2'.padStart(64,'0')},block]);
 if(typeof current!=='string'||!/^0x0{24}[0-9a-f]{40}$/i.test(current)||/^0x0{64}$/i.test(current))throw Error('Leader 0x registry unavailable.');
 if(!same(current,word(settler))){const previous=await rpc('eth_call',[{to:ZEROX_DEPLOYER,data:encodeFunctionData({abi:parseAbi(['function prev(uint128) view returns(address)']),functionName:'prev',args:[2n]})},block]);if(!same(previous,word(settler)))throw Error('Leader 0x settler is not registered.');}
}
/** Observed canonical Infinity -> USDT -> Maverick or hookless V4 USDC paths. No
 * arbitrary action, hook, callback payload or alternate destination is ignored. */
export async function cashLeaderZeroSale(b:CashLeaderBalance,rpc:Rpc,settler:string,actions:readonly string[],spent:bigint,slippage?:{recipient:string;buyToken:string;minAmountOut:bigint}){
 if(b.network!=='bnb'||actions.length!==3)throw Error('Unsupported 0x sale path.');
 const cfg=cashReturnNetwork(b.network),[fundTo,permit,sig]=decode(cashZeroV2Abi.transfer,actions[0]);
 const [middle,sell,ppm,feeOnTransfer,hashMul,hashMod,fills,firstMin]=decode(cashZeroSaleAbi.infinity,actions[1]);
 const v4=!!slippage;
 let minimum:bigint;
 if(v4){
  if(!same(slippage!.recipient,cfg.router)||!same(slippage!.buyToken,cfg.usdc)||slippage!.minAmountOut<=0n)throw Error('BNB outer sale minimum differs.');
  const [recipient,stable,ppm,fot,mul,mod,fill,min]=decode(cashZeroSaleAbi.v4,actions[2]);
  if(!same(recipient,settler)||!same(stable,usdt)||ppm!==1000000n||fot||mul!==2n||mod!==18446744073709551557n||min!==0n||typeof fill!=='string'||!/^0x[0-9a-f]{146}$/i.test(fill))throw Error('BNB V4 sale differs.');
  const bytes=Buffer.from(fill.slice(2),'hex'),num=(a:number,z:number)=>BigInt('0x'+bytes.subarray(a,z).toString('hex'));
  if(num(0,3)!==1000000n||num(3,23)===0n||bytes[23]!==1||!same('0x'+bytes.subarray(24,44).toString('hex'),cfg.usdc)||num(44,47)!==1n||num(47,50)!==1n||num(50,70)!==0n||num(70,73)!==0n)throw Error('BNB V4 fill differs.');
  minimum=slippage!.minAmountOut;
 }else{
  const [recipient,stable,ppm,terminal,tokenAIn,tickLimit,min]=decode(cashZeroSaleAbi.maverick,actions[2]);
  if(!same(recipient,cfg.router)||!same(stable,usdt)||ppm!==1000000n||!same(terminal,pool)||tokenAIn!==true||tickLimit!==2147483647||min<=0n)throw Error('Leader 0x sale action differs.');
  minimum=min;
 }
 if(!same(fundTo,settler)||!same(permit.permitted.token,b.token)||permit.permitted.amount!==spent||permit.nonce!==0n||permit.deadline<BigInt(Math.floor(b.blockTime/1000))||sig!=='0x'||!same(middle,settler)||!same(sell,b.token)||ppm!==1000000n||feeOnTransfer||hashMul!==3n||hashMod!==18446744073709551557n||firstMin!==0n)throw Error('Leader 0x sale action differs.');
 // 0x's documented packed single-fill format: ppm(3), price limit(20),
 // packing(1), output(20), hook(20), manager(1), fee(3), params(32), hooklen(3).
 if(typeof fills!=='string'||!/^0x[0-9a-f]{206}$/i.test(fills))throw Error('Unsupported Infinity sale fills.');
 const bytes=Buffer.from(fills.slice(2),'hex'),num=(start:number,end:number)=>BigInt('0x'+bytes.subarray(start,end).toString('hex'));
 if(num(0,3)!==1000000n||num(3,23)===0n||bytes[23]!==1||!same('0x'+bytes.subarray(24,44).toString('hex'),usdt)||num(44,64)!==0n||bytes[64]!==0||num(65,68)>=1000000n||num(100,103)!==0n)throw Error('Leader Infinity route differs.');
 const fee=Number(num(65,68)),parameters='0x'+bytes.subarray(68,100).toString('hex');
 const token0=b.token<usdt?b.token:usdt,token1=b.token<usdt?usdt:b.token;
 const poolId=keccak256(encodeAbiParameters(parseAbiParameters('address,address,address,address,uint24,bytes32'),[token0 as `0x${string}`,token1 as `0x${string}`,'0x0000000000000000000000000000000000000000',manager,fee,parameters as `0x${string}`]));
 const codePins={...BNB_ZERO_SALE_PINS,[settler]:BNB_ZERO_SETTLER_HASH};
 if(v4){delete codePins[pool];codePins[BNB_V4_MANAGER]=BNB_V4_HASH;}
 const tokensAbi=parseAbi(['function tokenA() view returns(address)','function tokenB() view returns(address)']);
 // Independent immutable-block reads run together; registry previous-version
 // lookup remains conditional on its current-version result.
 await Promise.all([
  ...Object.entries(codePins).map(async([address,expected])=>{const code=await rpc('eth_getCode',[address,b.blockNumber]);if(typeof code!=='string'||!/^0x(?:[0-9a-f]{2})+$/i.test(code)||keccak256(code as `0x${string}`)!==expected)throw Error('Leader 0x sale deployment changed.');}),
  ...(v4?[]:([['tokenA',usdt],['tokenB',cfg.usdc]] as const)).map(async([name,expected])=>{if(!same(await rpc('eth_call',[{to:pool,data:encodeFunctionData({abi:tokensAbi,functionName:name})},b.blockNumber]),word(expected)))throw Error('Leader stable pool tokens differ.');}),
  verifyLeaderZeroRegistry(settler,b.blockNumber,rpc),
 ]);
 const moved=(token:string,from:string,to:string):bigint=>b.receipt.logs.filter((l:any)=>same(l.address,token)&&same(l.topics?.[0],transfer)&&same(l.topics?.[1],word(from))&&same(l.topics?.[2],word(to))).reduce((total:bigint,l:any)=>{if(l.topics.length!==3||!/^0x[0-9a-f]{64}$/i.test(l.data))throw Error('Invalid 0x sale movement.');return total+BigInt(l.data);},0n);
 const intermediate=moved(usdt,vault,settler),output=moved(cfg.usdc,v4?BNB_V4_MANAGER:pool,v4?settler:cfg.router);
 if(moved(b.token,b.leader,cfg.router)!==spent||moved(b.token,cfg.router,settler)!==spent||moved(b.token,settler,vault)!==spent||intermediate<=0n||moved(usdt,settler,v4?BNB_V4_MANAGER:pool)!==intermediate||(v4&&moved(cfg.usdc,settler,cfg.router)!==output)||output<minimum||moved(cfg.usdc,cfg.router,cfg.depository)!==output)throw Error('Leader 0x sale movements differ.');
 const swaps=b.receipt.logs.filter((l:any)=>same(l.address,manager)&&same(l.topics?.[0],toEventSelector(cashZeroSaleAbi.infinitySwap[0])));
 if(swaps.length!==1)throw Error('Leader Infinity swap evidence is ambiguous.');
 const {args}=decodeEventLog({abi:cashZeroSaleAbi.infinitySwap,data:swaps[0].data,topics:swaps[0].topics,strict:true});
 if(!same(args.id,poolId)||!same(args.sender,settler)||args.protocolFee>4000||args.fee!==args.protocolFee+fee-Math.floor(args.protocolFee*fee/1000000)||(token0===b.token?args.amount0:args.amount1)!==-spent||(token0===b.token?args.amount1:args.amount0)!==intermediate)throw Error('Leader Infinity swap evidence differs.');
 if(v4){
  const matches=b.receipt.logs.filter((l:any)=>same(l.address,BNB_V4_MANAGER)&&same(l.topics?.[0],toEventSelector(cashZeroSaleAbi.v4Swap[0])));
  if(matches.length!==1)throw Error('Ambiguous BNB V4 swap.');
  const swap=decodeEventLog({abi:cashZeroSaleAbi.v4Swap,data:matches[0].data,topics:matches[0].topics,strict:true}).args;
  const id=keccak256(encodeAbiParameters(parseAbiParameters('address,address,uint24,int24,address'),[usdt,cfg.usdc as `0x${string}`,1,1,'0x0000000000000000000000000000000000000000']));
  if(!same(swap.id,id)||!same(swap.sender,settler)||swap.amount0!==-intermediate||swap.amount1!==output||swap.fee<1||swap.fee>1001)throw Error('BNB V4 swap evidence differs.');
 }
 return{minimum,output};
}
const BNB_ZERO_SETTLER_HASH='0xf89c12a28b43e982a9bb5e82beba5d077ec2c42cae6cbe3cba9361ad093e401d';
const BNB_ZERO_SALE_PINS:Record<string,string>={[ZEROX_ALLOWANCE_HOLDER]:'0x99f5e8edaceacfdd183eb5f1da8a7757b322495b80cf7928db289a1b1a09f799',[vault]:'0x678bab6ace02b3fc508054b194f3f70190a0621f51bcae69be33cc5416031908',[manager]:'0x3caf72836cb6603c6af03bba1578ec70ece8c3e5b1d0ef73667b5fbd74b02a0f',[pool]:'0x523bd030f5593fee7ac2690beacadae9f1f938c8dedfeaea6dcef8e9cebf2e62'};

// Official Uniswap BNB deployment; runtime pinned at the recorded sale block.
const BNB_V4_MANAGER='0x28e2ea090877bf75740558f6bfb36a5ffee9e9df',BNB_V4_HASH='0x48752321ee7abf0d2a17c30679df9a1ddd14dc75d28b26e2509b76396145a005';
