import {decodeEventLog,encodeFunctionData,keccak256,parseAbi,toEventSelector} from 'viem';
import type {CashLeaderBalance} from './cash-leader-receipt.js';
import type {Rpc} from './funding.js';
import {cashReturnNetwork} from './cash-return-networks.js';
// Canonical factory: https://developer.pancakeswap.finance/contracts/v3/addresses
// The inner router ABI is not verified. Classify actual pool settlement only;
// never invent a caller minimum or bypass separate source-payment verification.
export const BNB_RECEIPT_ROUTER='0x0005ea70fa6dbd2efd17697d2351301adb6318b2';
const implementation='0xc254fe10b465c3a0b377cee50116a76c29037013',slot='0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const factory='0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865',wrapped='0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
export const bnbReceiptAbi=parseAbi(['function factory() view returns(address)','function token0() view returns(address)','function token1() view returns(address)','function fee() view returns(uint24)','function getPool(address,address,uint24) view returns(address)','event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint128 protocolFeesToken0,uint128 protocolFeesToken1)']);
const swapTopic=toEventSelector(bnbReceiptAbi[5]),transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const same=(a:unknown,b:string)=>typeof a==='string'&&a.toLowerCase()===b.toLowerCase(),word=(a:string)=>'0x'+a.slice(2).padStart(64,'0');
export async function verifyBnbReceiptFill(b:CashLeaderBalance,rpc:Rpc,amount:bigint,calldata:string){
 const cfg=cashReturnNetwork(b.network),router=BNB_RECEIPT_ROUTER;
 if(b.network!=='bnb'||b.token===wrapped||b.token===cfg.usdc||!/^0xbb66eb41(?:[0-9a-f]{2})+$/i.test(calldata)||calldata.length>32770)throw Error('Unsupported BNB receipt route.');
 let previous=-1n;
 for(const l of b.receipt.logs){if(l.removed!==false||!same(l.transactionHash,b.transaction)||!same(l.blockHash,b.blockHash)||l.blockNumber!==b.blockNumber||l.transactionIndex!==b.transactionIndex||typeof l.logIndex!=='string'||!/^0x(0|[1-9a-f][0-9a-f]*)$/i.test(l.logIndex)||BigInt(l.logIndex)<=previous)throw Error('Invalid BNB receipt order.');previous=BigInt(l.logIndex);}
 const swaps=b.receipt.logs.filter((l:any)=>same(l.topics?.[0],swapTopic));
 if(swaps.length!==2)throw Error('BNB pool settlement is ambiguous.');
 const amounts:bigint[][]=[];
 await Promise.all(swaps.map(async(l:any,index:number)=>{
  const [input,output]=index===0?[cfg.usdc,wrapped]:[wrapped,b.token];
  const tokens=[input,output].sort(),pool=String(l.address).toLowerCase();
  if(!/^0x[0-9a-f]{40}$/.test(pool))throw Error('Invalid BNB pool.');
  const [f,t0,t1,fee]=await Promise.all((['factory','token0','token1','fee'] as const).map(functionName=>rpc('eth_call',[{to:pool,data:encodeFunctionData({abi:bnbReceiptAbi,functionName})},b.blockNumber])));
  if(!same(f,word(factory))||!same(t0,word(tokens[0]))||!same(t1,word(tokens[1]))||typeof fee!=='string'||!/^0x[0-9a-f]{64}$/i.test(fee)||BigInt(fee)>1000000n||BigInt(fee)<=0n)throw Error('BNB pool identity differs.');
  const canonical=await rpc('eth_call',[{to:factory,data:encodeFunctionData({abi:bnbReceiptAbi,functionName:'getPool',args:[tokens[0] as `0x${string}`,tokens[1] as `0x${string}`,Number(BigInt(fee))]})},b.blockNumber]);
  if(!same(canonical,word(pool)))throw Error('BNB pool is not canonical.');
  const {args}=decodeEventLog({abi:bnbReceiptAbi,eventName:'Swap',topics:l.topics,data:l.data,strict:true});
  const inputRaw=tokens[0]===input?args.amount0:args.amount1,outputRaw=-(tokens[0]===input?args.amount1:args.amount0);
  if(!same(args.sender,router)||!same(args.recipient,index===0?router:cfg.router)||inputRaw<=0n||outputRaw<=0n)throw Error('BNB swap direction differs.');
  amounts[index]=[inputRaw,outputRaw];
 }));
 if(amounts[0][0]!==amount||amounts[0][1]!==amounts[1][0]||amounts[1][1]!==BigInt(b.deltaRaw))throw Error('BNB swap amounts differ.');
 const expected:[string,string,string,bigint][]=[[cfg.usdc,cfg.solver,cfg.router,amount],[cfg.usdc,cfg.router,router,amount],[cfg.usdc,router,swaps[0].address,amount],[wrapped,swaps[0].address,router,amounts[0][1]],[wrapped,router,swaps[1].address,amounts[0][1]],[b.token,swaps[1].address,cfg.router,BigInt(b.deltaRaw)],[b.token,cfg.router,b.leader,BigInt(b.deltaRaw)]];
 for(const l of b.receipt.logs){if(!same(l.topics?.[0],transfer))continue;
  if(l.topics.length!==3||!/^0x[0-9a-f]{64}$/i.test(l.data))throw Error('Invalid BNB movement.');
  const i=expected.findIndex(([token,from,to,raw])=>same(l.address,token)&&same(l.topics[1],word(from))&&same(l.topics[2],word(to))&&BigInt(l.data)===raw);
  if(i<0)throw Error('Unexpected BNB movement.');expected.splice(i,1);
 }
 if(expected.length)throw Error('Missing BNB movement.');
 await Promise.all([
  ...Object.entries({[factory]:'0x8191d3ab1d55d3da9822199f28865415c99566b6f1aee4a4b16713f57930678c',[router]:'0x4b0b52fc2768d8257a1f375f0e8dd364c1d8cd7274b9b6a6d356f3a09e98a4a2',[implementation]:'0xafe9aca90207c3b00f7898ecfcf81a727c0b04da9496264b4e47f001150e7a18'}).map(async([address,hash])=>{const code=await rpc('eth_getCode',[address,b.blockNumber]);if(typeof code!=='string'||!/^0x(?:[0-9a-f]{2})+$/i.test(code)||keccak256(code as `0x${string}`)!==hash)throw Error('BNB receipt deployment changed.');}),
  rpc('eth_getStorageAt',[router,slot,b.blockNumber]).then(value=>{if(!same(value,word(implementation)))throw Error('BNB receipt implementation changed.');}),
 ]);
}
