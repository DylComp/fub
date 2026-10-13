import {decodeFunctionData,encodeFunctionData,decodeEventLog,encodeAbiParameters,keccak256,parseAbi,parseAbiParameters,toEventSelector} from 'viem';
import type {CashLeaderBalance} from './cash-leader-receipt.js';
import type {Rpc} from './funding.js';
import {cashReturnNetwork,ZEROX_ALLOWANCE_HOLDER} from './cash-return-networks.js';
import {cashZeroV2Abi} from './cash-leader-zero-v2.js';
import {verifyLeaderZeroRegistry} from './cash-leader-zero-sale.js';
export const cashZeroMonadAbi={
 packedV3:parseAbi(['function UNISWAPV3(address recipient,uint256 ppm,bytes path,uint256 amountOutMin)']),
 pancakeSwap:parseAbi(['event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint128 protocolFeesToken0,uint128 protocolFeesToken1)']),
 basic:parseAbi(['function BASIC(address sellToken,uint256 ppm,address pool,uint256 offset,bytes data)']),
 exact:parseAbi(['function exactInput((bytes path,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum) params)']),
 withdraw:parseAbi(['function withdraw(uint256 amount)']),
 v4:parseAbi(['function UNISWAPV4(address recipient,address sellToken,uint256 ppm,bool feeOnTransfer,uint256 hashMul,uint256 hashMod,bytes fills,uint256 amountOutMin)']),
 v3Swap:parseAbi(['event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)']),
 v4Swap:parseAbi(['event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)']),
 withdrawal:parseAbi(['event Withdrawal(address indexed src,uint256 wad)']),
};
const wrapped='0x3bd359c1119da7da1d913d1c4d2b7c461115433a',router='0xdac97b6a3951641b177283028a8f428332333071',pool='0x116e7d070f1888b81e1e0324f56d6746b2d7d8f1',manager='0x188d586ddcf52439676ca21a244753fa19f9ea8e';
const expectedSettler='0x2e73afeb01595831a67e9e1a56e193b93331b8c7';
const factory='0x6b5f564339dbad6b780249827f2198a841feb7f3';
const zero='0x0000000000000000000000000000000000000000',native='0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const same=(a:unknown,b:string)=>typeof a==='string'&&a.toLowerCase()===b.toLowerCase(),word=(a:string)=>'0x'+a.slice(2).padStart(64,'0');
const transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
function decode(abi:any,data:string):any{const d=decodeFunctionData({abi,data:data as `0x${string}`});if(!same(encodeFunctionData({abi,functionName:d.functionName,args:d.args}),data))throw Error('Noncanonical Monad sale action.');return d.args;}
/** The observed V3 -> wrapped MON -> native MON -> hookless V4 USDC route.
 * All balances come from the authenticated operation's isolated receipt logs. */
export async function cashLeaderZeroMonadSale(b:CashLeaderBalance,rpc:Rpc,settler:string,actions:readonly string[],spent:bigint,slippage:{recipient:string;buyToken:string;minAmountOut:bigint}){
 const cfg=cashReturnNetwork(b.network);
 if(actions.length===3)return monadPackedSale(b,rpc,settler,actions,spent,slippage);
 if(b.network!=='monad'||!same(settler,expectedSettler)||actions.length!==4||!same(slippage.recipient,cfg.router)||!same(slippage.buyToken,cfg.usdc)||slippage.minAmountOut<=0n)throw Error('Unsupported Monad sale path.');
 const [fundTo,permit,sig]=decode(cashZeroV2Abi.transfer,actions[0]),[sell,ppm,target,offset,data]=decode(cashZeroMonadAbi.basic,actions[1]),[unwrap,unwrapPpm,unwrapTarget,unwrapOffset,unwrapData]=decode(cashZeroMonadAbi.basic,actions[2]);
 const [swap]=decode(cashZeroMonadAbi.exact,data),[withdraw]=decode(cashZeroMonadAbi.withdraw,unwrapData);
 if(!same(fundTo,settler)||!same(permit.permitted.token,b.token)||permit.permitted.amount!==spent||permit.nonce!==0n||permit.deadline<BigInt(Math.floor(b.blockTime/1000))||sig!=='0x'||!same(sell,b.token)||ppm!==1000000n||!same(target,router)||offset!==132n||!same(swap.path,b.token+'002710'+wrapped.slice(2))||!same(swap.recipient,settler)||swap.deadline!==permit.deadline||swap.amountIn!==0n||swap.amountOutMinimum!==0n||!same(unwrap,wrapped)||unwrapPpm!==1000000n||!same(unwrapTarget,wrapped)||unwrapOffset!==4n||withdraw!==0n)throw Error('Monad sale input differs.');
 const [recipient,sellNative,nativePpm,feeOnTransfer,hashMul,hashMod,fills,minimum]=decode(cashZeroMonadAbi.v4,actions[3]);
 if(!same(recipient,settler)||!same(sellNative,native)||nativePpm!==1000000n||feeOnTransfer||hashMul!==2n||hashMod!==18446744073709551557n||minimum!==0n||typeof fills!=='string'||!/^0x[0-9a-f]{146}$/i.test(fills))throw Error('Monad native sale differs.');
 // Official 0x format: ppm3, sqrtPriceLimit20, packing1, output20, fee3,
 // tickSpacing3, hooks20, hookDataLength3. Only one no-hook fill is accepted.
 const bytes=Buffer.from(fills.slice(2),'hex'),num=(a:number,z:number)=>BigInt('0x'+bytes.subarray(a,z).toString('hex'));
 if(num(0,3)!==1000000n||num(3,23)===0n||bytes[23]!==1||!same('0x'+bytes.subarray(24,44).toString('hex'),cfg.usdc)||num(44,47)!==500n||num(47,50)!==10n||num(50,70)!==0n||num(70,73)!==0n)throw Error('Monad V4 route differs.');
 const poolId=keccak256(encodeAbiParameters(parseAbiParameters('address,address,uint24,int24,address'),[zero,cfg.usdc as `0x${string}`,500,10,zero]));
 const getterAbi=parseAbi(['function factory() view returns(address)','function WETH9() view returns(address)','function getPool(address,address,uint24) view returns(address)']);
 const getters=[[router,'factory',[],factory],[pool,'factory',[],factory],[router,'WETH9',[],wrapped],[factory,'getPool',[b.token,wrapped,10000],pool]] as const;
 await Promise.all([
  ...Object.entries(MONAD_SALE_PINS).map(async([address,expected])=>{const code=await rpc('eth_getCode',[address,b.blockNumber]);if(typeof code!=='string'||!/^0x(?:[0-9a-f]{2})+$/i.test(code)||keccak256(code as `0x${string}`)!==expected)throw Error('Monad sale deployment changed.');}),
  ...getters.map(async([address,name,args,expected])=>{const got=await rpc('eth_call',[{to:address,data:encodeFunctionData({abi:getterAbi,functionName:name,args:args as any})},b.blockNumber]);if(!same(got,word(expected)))throw Error('Monad pool identity differs.');}),
  verifyLeaderZeroRegistry(settler,b.blockNumber,rpc),
 ]);
 if(!Object.hasOwn(MONAD_SALE_PINS,settler)||!Object.hasOwn(MONAD_SALE_PINS,ZEROX_ALLOWANCE_HOLDER))throw Error('Unknown Monad settler.');
 const logs=b.receipt.logs,moved=(token:string,from:string,to:string)=>logs.filter((l:any)=>same(l.address,token)&&same(l.topics?.[0],transfer)&&same(l.topics?.[1],word(from))&&same(l.topics?.[2],word(to))).reduce((sum:bigint,l:any)=>{if(l.topics.length!==3||!/^0x[0-9a-f]{64}$/i.test(l.data))throw Error('Invalid Monad token movement.');return sum+BigInt(l.data);},0n);
 const wrappedOut=moved(wrapped,pool,settler),output=moved(cfg.usdc,manager,settler);
 if(wrappedOut<=0n||output<slippage.minAmountOut||moved(b.token,b.leader,cfg.router)!==spent||moved(b.token,cfg.router,settler)!==spent||moved(b.token,settler,pool)!==spent||moved(cfg.usdc,settler,cfg.router)!==output||moved(cfg.usdc,cfg.router,cfg.depository)!==output)throw Error('Monad sale movements differ.');
 const one=(address:string,abi:any)=>{const found=logs.filter((l:any)=>same(l.address,address)&&same(l.topics?.[0],toEventSelector(abi[0])));if(found.length!==1)throw Error('Ambiguous Monad swap evidence.');return (decodeEventLog({abi,data:found[0].data,topics:found[0].topics,strict:true}) as any).args;};
 const v3=one(pool,cashZeroMonadAbi.v3Swap),v4=one(manager,cashZeroMonadAbi.v4Swap),withdrawal=one(wrapped,cashZeroMonadAbi.withdrawal),tokenFirst=b.token<wrapped;
 if(!same(v3.sender,router)||!same(v3.recipient,settler)||(tokenFirst?v3.amount0:v3.amount1)!==spent||(tokenFirst?v3.amount1:v3.amount0)!==-wrappedOut||!same(withdrawal.src,settler)||withdrawal.wad!==wrappedOut||!same(v4.sender,settler)||!same(v4.id,poolId)||v4.fee!==500||v4.amount0!==-wrappedOut||v4.amount1!==output)throw Error('Monad swap evidence differs.');
 return{minimum:slippage.minAmountOut,output};
}
// Exact historical runtime hashes populated from independently verified RPC evidence.
const MONAD_SALE_PINS:Record<string,string>={"0xdac97b6a3951641b177283028a8f428332333071":"0xba9e9b0fdf44ad986afeeda31cbfa965e575eaf5fb96bda6b9e5b9b13ae868d7","0x188d586ddcf52439676ca21a244753fa19f9ea8e":"0xf5d7a45765367807b101f825ec74004078c79bd96c621e481c608ee22f7336d4","0x0000000000001ff3684f28c67538d4d072c22734":"0x99f5e8edaceacfdd183eb5f1da8a7757b322495b80cf7928db289a1b1a09f799","0x3bd359c1119da7da1d913d1c4d2b7c461115433a":"0xa32df4f1226f1bb0d6ce9b917752ed687857899a35ebf902c9992edb73b138b6","0x2e73afeb01595831a67e9e1a56e193b93331b8c7":"0x686a675a87b933286fbcc7ef3fb81b0611f893ffe8f37a58d18c13080889f6ce","0x116e7d070f1888b81e1e0324f56d6746b2d7d8f1":"0xbd95a827231570ecd82852f97cef9c36addf09239526a18368992e55ca5be807","0x6b5f564339dbad6b780249827f2198a841feb7f3":"0x5502ab6e83fb7fb5047c316c78cded56182163165f342292cca0ec40980d16d9"};

// Recorded 0x V3 -> Pancake V3 route. An empty outer minimum is valid only
// when the final canonical action specifies the exact USDC destination/minimum.
async function monadPackedSale(b:CashLeaderBalance,rpc:Rpc,settler:string,actions:readonly string[],spent:bigint,slippage:{recipient:string;buyToken:string;minAmountOut:bigint}){
 const cfg=cashReturnNetwork(b.network),terminal='0x63e48b725540a3db24acf6682a29f877808c53f2',pancakeFactory='0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865';
 if(b.network!=='monad'||!same(settler,expectedSettler)||!same(slippage.recipient,zero)||!same(slippage.buyToken,zero)||slippage.minAmountOut!==0n)throw Error('Unsupported Monad packed sale.');
 const [fundTo,permit,sig]=decode(cashZeroV2Abi.transfer,actions[0]),[sell,ppm,target,offset,data]=decode(cashZeroMonadAbi.basic,actions[1]),[swap]=decode(cashZeroMonadAbi.exact,data),[recipient,finalPpm,path,minimum]=decode(cashZeroMonadAbi.packedV3,actions[2]);
 // The pinned settler's one-hop Pancake path includes fork id, fee, and
 // sqrt-price limit. Accept only this observed path; no arbitrary callback.
 const expectedPath=wrapped+'010001f400000000000000000000000000000001000276a4'+cfg.usdc.slice(2);
 if(!same(fundTo,settler)||!same(permit.permitted.token,b.token)||permit.permitted.amount!==spent||permit.nonce!==0n||permit.deadline<BigInt(Math.floor(b.blockTime/1000))||sig!=='0x'||!same(sell,b.token)||ppm!==1000000n||!same(target,router)||offset!==132n||!same(swap.path,b.token+'002710'+wrapped.slice(2))||!same(swap.recipient,settler)||swap.deadline!==permit.deadline||swap.amountIn!==0n||swap.amountOutMinimum!==0n||!same(recipient,cfg.router)||finalPpm!==1000000n||!same(path,expectedPath)||minimum<=0n)throw Error('Monad packed sale input differs.');
 const pins:Record<string,string>={...MONAD_SALE_PINS,[terminal]:'0x35fd982b4dd2ca117a46c8ee159413c5fae65feb122ab257c5db26b78604e1be',[pancakeFactory]:'0xf6105f5817b3f67dd0f060fa27c1e23a14d9fca13c6ebd695545ca4d5c0fbe06'};delete pins[manager];
 const abi=parseAbi(['function factory() view returns(address)','function WETH9() view returns(address)','function token0() view returns(address)','function token1() view returns(address)','function fee() view returns(uint24)','function getPool(address,address,uint24) view returns(address)']);
 const getters:any[]=[[router,'factory',[],word(factory)],[pool,'factory',[],word(factory)],[router,'WETH9',[],word(wrapped)],[factory,'getPool',[b.token,wrapped,10000],word(pool)],[terminal,'factory',[],word(pancakeFactory)],[terminal,'token0',[],word(wrapped)],[terminal,'token1',[],word(cfg.usdc)],[terminal,'fee',[],'0x'+(500).toString(16).padStart(64,'0')],[pancakeFactory,'getPool',[wrapped,cfg.usdc,500],word(terminal)]];
 await Promise.all([...Object.entries(pins).map(async([address,hash])=>{const code=await rpc('eth_getCode',[address,b.blockNumber]);if(typeof code!=='string'||!/^0x(?:[0-9a-f]{2})+$/i.test(code)||keccak256(code as `0x${string}`)!==hash)throw Error('Monad packed deployment changed.');}),...getters.map(async([to,functionName,args,expected])=>{if(!same(await rpc('eth_call',[{to,data:encodeFunctionData({abi,functionName,args})},b.blockNumber]),expected))throw Error('Monad packed pool identity differs.');}),verifyLeaderZeroRegistry(settler,b.blockNumber,rpc)]);
 const logs=b.receipt.logs,moved=(token:string,from:string,to:string)=>logs.filter((l:any)=>same(l.address,token)&&same(l.topics?.[0],transfer)&&same(l.topics?.[1],word(from))&&same(l.topics?.[2],word(to))).reduce((sum:bigint,l:any)=>{if(l.topics.length!==3||!/^0x[0-9a-f]{64}$/i.test(l.data))throw Error('Invalid Monad movement.');return sum+BigInt(l.data);},0n);
 const middle=moved(wrapped,pool,settler),output=moved(cfg.usdc,terminal,cfg.router);
 if(middle<=0n||output<minimum||moved(b.token,b.leader,cfg.router)!==spent||moved(b.token,cfg.router,settler)!==spent||moved(b.token,settler,pool)!==spent||moved(wrapped,settler,terminal)!==middle||moved(cfg.usdc,cfg.router,cfg.depository)!==output)throw Error('Monad packed movements differ.');
 const one=(address:string,abi:any)=>{const ls=logs.filter((l:any)=>same(l.address,address)&&same(l.topics?.[0],toEventSelector(abi[0])));if(ls.length!==1)throw Error('Ambiguous Monad packed swap.');return(decodeEventLog({abi,data:ls[0].data,topics:ls[0].topics,strict:true})as any).args;};
 const first=one(pool,cashZeroMonadAbi.v3Swap),last=one(terminal,cashZeroMonadAbi.pancakeSwap),tokenFirst=b.token<wrapped;
 if(!same(first.sender,router)||!same(first.recipient,settler)||(tokenFirst?first.amount0:first.amount1)!==spent||(tokenFirst?first.amount1:first.amount0)!==-middle||!same(last.sender,settler)||!same(last.recipient,cfg.router)||last.amount0!==middle||last.amount1!==-output||last.protocolFeesToken0<0n||last.protocolFeesToken0>middle||last.protocolFeesToken1!==0n)throw Error('Monad packed swap evidence differs.');
 return{minimum,output};
}
