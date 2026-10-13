import {readArcNativeFill} from './cash-leader-arc-receipt.js';
import {cashLeaderZeroV2Minimum} from './cash-leader-zero-v2.js';
import {decodeEventLog,decodeFunctionData,encodeFunctionData,keccak256,parseAbi,toEventSelector} from 'viem';
import {cashReturnAbi} from './cash-return-route.js';
import {cashReturnNetwork,cashLeaderFynd,ZEROX_ALLOWANCE_HOLDER,ZEROX_DEPLOYER} from './cash-return-networks.js';
import type {CashLeaderBalance} from './cash-leader-receipt.js';
import type {Rpc} from './funding.js';

export const cashLeaderFillAbi={
 proxy:parseAbi(['function permit2TransferAndMulticall(address user,((address token,uint256 amount)[] permitted,uint256 nonce,uint256 deadline) permit,(address target,bool allowFailure,uint256 value,bytes callData)[] calls,address refundTo,address nftRecipient,bytes metadata,bytes permitSignature) payable']),
 cleanup:parseAbi(['function cleanupErc20s(address[] tokens,address[] recipients,uint256[] amounts,bytes metadata)']),
 movement:parseAbi(['event FundsMovement(address from,address to,address currency,uint256 amount,bytes metadata)']),
};
const proxyHash='0xa3b36a6aa3c2fb588b92336d88b0735b40dea0282c110d2034edf688ca661b5b';
const transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const same=(a:unknown,b:string)=>typeof a==='string'&&a.toLowerCase()===b.toLowerCase();
const owner=(a:string)=>'0x'+a.slice(2).padStart(64,'0');
// Relay places the request ID in reversed hex-nibble order, followed by a
// version byte. Unlike the trailing order hint, Permit2 signs this metadata.
export function cashFillRequestId(metadata:string){
 if(!/^0x[0-9a-f]{64}00$/i.test(metadata)||/^0x0{66}$/i.test(metadata))throw Error('Unsupported fill request metadata.');
 return '0x'+metadata.slice(2,-2).toLowerCase().split('').reverse().join('');
}
function decode(abi:any,data:string,trailer=false):any{
 if(!/^0x(?:[0-9a-f]{2})+$/i.test(data)||data.length>140002)throw Error('Invalid fill instruction.');
 const d=decodeFunctionData({abi,data:data as `0x${string}`});
 const canonical=encodeFunctionData({abi,functionName:d.functionName,args:d.args});
 if(!same(data,trailer?canonical+data.slice(-64):canonical)||trailer&&data.length!==canonical.length+64)throw Error('Noncanonical fill instruction.');
 return d.args;
}
/** Verifies the destination swap without Relay's integrator-scoped history.
 * This is NOT yet a leader buy: someone could buy a gift for this recipient.
 * The trailing order ID is only a lookup hint; Permit2 does not sign that
 * suffix. Source ownership and order association require separate evidence.
 * Call only with independently checked receipt/balance evidence. */
export async function readCashLeaderFill(b:CashLeaderBalance,rpc:Rpc){
 const cfg=cashReturnNetwork(b.network);
 if(b.network==='arc'&&b.target===cfg.router)return readArcNativeFill(b,rpc);
 if(b.target!==cfg.proxy||b.token===cfg.usdc||BigInt(b.deltaRaw)<=0n)return null;
 const [user,permit,calls,refund,nft,metadata,signature]=decode(cashLeaderFillAbi.proxy,b.input,true);
 if(!same(user,cfg.solver)||!same(refund,b.leader)||!same(nft,b.leader)||!/^0x[0-9a-f]{64}00$/i.test(metadata)||!/^0x[0-9a-f]{130}$/i.test(signature)||permit.permitted.length!==1||!same(permit.permitted[0].token,cfg.usdc)||permit.permitted[0].amount<=0n||permit.deadline<BigInt(Math.floor(b.blockTime/1000)))throw Error('Fill funding authorization differs.');
 if(calls.length!==3&&calls.length!==4||calls.some((c:any)=>c.allowFailure!==false))throw Error('Partial or unsupported fill.');
 const amount=permit.permitted[0].amount,approval=calls[0],swap=calls.at(-2),cleanup=calls.at(-1);
 if(approval.value!==0n||swap.value!==0n||cleanup.value!==0n||!same(approval.target,cfg.usdc)||!same(cleanup.target,cfg.router))throw Error('Fill targets differ.');
 if(calls.length===4&&(!same(calls[1].target,b.leader)||calls[1].callData!=='0x'||calls[1].value<=0n))throw Error('Fill gas recipient differs.');
 const [spender,allowance]=decode(cashReturnAbi.approval,approval.callData);
 if(!same(spender,swap.target)||allowance!==amount)throw Error('Fill allowance differs.');
 let adapter:'kyberswap'|'0x'|'fynd-hosted',minimum:bigint,settler:string|undefined;
 const fynd=cashLeaderFynd(b.network);
 if(same(swap.target,cfg.kyber)){
  adapter='kyberswap';const [s]=decode(cashReturnAbi.kyber,swap.callData),d=s.desc;
  if(!same(s.callTarget,cfg.executor)||!/^0x0{40}$/i.test(s.approveTarget)||!same(d.srcToken,cfg.usdc)||!same(d.dstToken,b.token)||d.srcReceivers.length!==1||!same(d.srcReceivers[0],cfg.executor)||d.srcAmounts.length!==1||d.srcAmounts[0]!==amount||d.amount!==amount||!same(d.dstReceiver,cfg.router)||d.feeReceivers.length||d.feeAmounts.length||![0n,512n].includes(d.flags)||d.permit!=='0x')throw Error('Fill swap differs.');
  minimum=d.minReturnAmount;
 }else if(same(swap.target,ZEROX_ALLOWANCE_HOLDER)){
  adapter='0x';const [operator,token,input,target,data]=decode(cashReturnAbi.zeroX,swap.callData);
  if(!same(operator,target)||!same(token,cfg.usdc)||input!==amount)throw Error('Fill 0x allowance differs.');
  const [slippage,actions]=decode(cashReturnAbi.settler,data);
  settler=String(target).toLowerCase();
  if(/^0x0{40}$/i.test(slippage.recipient)&&/^0x0{40}$/i.test(slippage.buyToken)&&slippage.minAmountOut===0n)minimum=await cashLeaderZeroV2Minimum(b,rpc,settler,actions,amount);
  else{if(!same(slippage.recipient,cfg.router)||!same(slippage.buyToken,b.token)||actions.length<1||actions.length>64)throw Error('Fill 0x output differs.');minimum=slippage.minAmountOut;}
 }else if(fynd&&same(swap.target,fynd.router)){
  adapter='fynd-hosted';
  const fomoTag='70726f70656c6c65722f52656c61792d464f4d4f',relayTag='70726f70656c6c65722f52656c6179';
  const fomoClient=b.network==='base'&&swap.callData.toLowerCase().endsWith(fomoTag);
  const tag=fomoClient?fomoTag:relayTag;
  if(!swap.callData.toLowerCase().endsWith(tag))throw Error('Fill Tycho tracking differs.');
  const [input,tokenIn,tokenOut,expected,min,receiver,fee,swaps]=decode(cashReturnAbi.fynd,swap.callData.slice(0,-tag.length));
  const clientValid=fomoClient?same(fee.clientFeeReceiver,'0xda7da7acd714c407a37c635a42d5354d0c5b9136')&&/^0x[0-9a-f]{130}$/i.test(fee.clientSignature):/^0x0{40}$/i.test(fee.clientFeeReceiver)&&fee.clientSignature==='0x';
  if(input!==amount||!same(tokenIn,cfg.usdc)||!same(tokenOut,b.token)||min<=0n||expected<min||!same(receiver,cfg.router)||fee.clientFeeBps!==0||!clientValid||fee.maxClientContribution!==0n||fee.deadline*1000n<BigInt(b.blockTime)||typeof swaps!=='string'||swaps.length<4||swaps.length>32770)throw Error('Fill Tycho swap differs.');
  const code=await rpc('eth_getCode',[fynd.router,b.blockNumber]);
  if(typeof code!=='string'||!/^0x(?:[0-9a-f]{2})+$/i.test(code)||keccak256(code as `0x${string}`)!==fynd.codeHash)throw Error('Fill Tycho deployment changed.');
  minimum=min;
 }else throw Error('Unsupported fill adapter.');
 if(minimum<=0n||minimum>BigInt(b.deltaRaw))throw Error('Fill output is below its minimum.');
 const [tokens,recipients,amounts,cleanMetadata]=decode(cashLeaderFillAbi.cleanup,cleanup.callData);
 if(tokens.length!==1||recipients.length!==1||amounts.length!==1||!same(tokens[0],b.token)||!same(recipients[0],b.leader)||amounts[0]!==0n||!same(cleanMetadata,metadata))throw Error('Fill delivery differs.');
 const code=await rpc('eth_getCode',[cfg.proxy,b.blockNumber]);
 if(typeof code!=='string'||!/^0x(?:[0-9a-f]{2})+$/i.test(code)||keccak256(code as `0x${string}`)!==proxyHash)throw Error('Fill proxy deployment changed.');
 if(settler){
  // Official 0x deployer tokenId 2 identifies the current taker-submitted
  // settler. Accept the documented previous deployment during API dwell
  // time only after ownerOf succeeds. Check both at the receipt block.
  const registered=await rpc('eth_call',[{to:ZEROX_DEPLOYER,data:'0x6352211e'+'2'.padStart(64,'0')},b.blockNumber]);
  if(typeof registered!=='string'||!/^0x0{24}[0-9a-f]{40}$/i.test(registered)||/^0x0{64}$/i.test(registered))throw Error('Fill registry unavailable.');
  if(!same(registered,owner(settler))){
   const previous=await rpc('eth_call',[{to:ZEROX_DEPLOYER,data:encodeFunctionData({abi:parseAbi(['function prev(uint128) view returns (address)']),functionName:'prev',args:[2n]})},b.blockNumber]);
   if(!same(previous,owner(settler)))throw Error('Fill settler is not registered.');
  }
 }
 let funded=0n,delivered=0n;const indices=new Set<string>();
 for(const log of b.receipt.logs){
  if(log.removed!==false||!same(log.transactionHash,b.transaction)||!same(log.blockHash,b.blockHash)||!same(log.blockNumber,b.blockNumber)||!same(log.transactionIndex,b.transactionIndex)||!/^0x(0|[1-9a-f][0-9a-f]*)$/i.test(log.logIndex))throw Error('Invalid fill receipt.');
  const index=BigInt(log.logIndex).toString();if(indices.has(index))throw Error('Duplicate fill log.');indices.add(index);
  if(same(log.address,cfg.proxy)&&same(log.topics?.[0],toEventSelector(cashLeaderFillAbi.movement[0]))){
   const {args}=decodeEventLog({abi:cashLeaderFillAbi.movement,data:log.data,topics:log.topics,strict:true});
   if(!same(args.currency,cfg.usdc)||!same(args.from,cfg.solver)||!same(args.to,cfg.router)||!same(args.metadata,metadata)||funded!==0n)throw Error('Fill solver funding differs.');
   funded=args.amount;
  }
  if(same(log.address,b.token)&&same(log.topics?.[0],transfer)&&same(log.topics?.[2],owner(b.leader))){
   if(log.topics.length!==3||!same(log.topics[1],owner(cfg.router))||!/^0x[0-9a-f]{64}$/i.test(log.data))throw Error('Fill token delivery differs.');delivered+=BigInt(log.data);
  }
 }
 if(funded!==amount||delivered!==BigInt(b.deltaRaw))throw Error('Fill amounts differ from the receipt.');
 return{swapVerified:true as const,tradeVerified:false as const,sourceAssociation:'unverified' as const,adapter,network:b.network,recipient:b.leader,token:b.token,transaction:b.transaction,blockHash:b.blockHash,inputRaw:amount.toString(),outputRaw:b.deltaRaw,minimumRaw:minimum.toString(),orderIdHint:'0x'+b.input.slice(-64),requestId:cashFillRequestId(metadata)};
}
