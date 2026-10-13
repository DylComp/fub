import {readArcReceiptSale} from './cash-leader-arc-sale.js';
import {ARC_RECEIPT} from './cash-leader-arc-receipt.js';
import {cashLeaderZeroArcSale} from './cash-leader-zero-arc-sale.js';
import {cashLeaderZeroMonadSale} from './cash-leader-zero-monad-sale.js';
import {cashLeaderZeroSale} from './cash-leader-zero-sale.js';
import {decodeEventLog,decodeFunctionData,encodeFunctionData,keccak256,parseAbi} from 'viem';
import {readCashLeaderBalance,readCashLeaderProvisionalBalance,readCashLeaderCapturedBalance} from './cash-leader-receipt.js';
import {cashReturnAbi} from './cash-return-route.js';
import {cashReturnNetwork,cashLeaderFynd,ZEROX_ALLOWANCE_HOLDER} from './cash-return-networks.js';
import {returnDepositEvent} from './cash-return-simulation.js';
import {verifyCashSourcePool} from './cash-source-pool.js';
import type {CashCopyEvent} from '../src/cash-copy-model.js';
import type {CashNetwork} from '../src/cash-route.js';
import type {Rpc} from './funding.js';
import {readFomoSmartCalls} from './cash-fomo-smart-wallet.js';

// Relay's immutable transfer-and-multicall deployment, checked on all six
// supported chains. An observation never selects its own contract anchors.
// TychoRouterV3 split graph entrypoint; kept separate so other adapters do not
// mistake its extra nTokens argument for a receiver.
const splitSaleAbi=parseAbi(['function splitSwap(uint256 amountIn,address tokenIn,address tokenOut,uint256 expectedAmountOut,uint256 minAmountOut,uint256 nTokens,address receiver,(uint32 clientFeeBps,address clientFeeReceiver,uint256 maxClientContribution,uint256 deadline,bytes clientSignature) clientFeeParams,bytes swaps) payable returns (uint256)']);
const PROXY_HASH='0xa3b36a6aa3c2fb588b92336d88b0735b40dea0282c110d2034edf688ca661b5b';
const same=(a:unknown,b:string)=>typeof a==='string'&&a.toLowerCase()===b.toLowerCase();
const hash=(a:unknown):a is `0x${string}`=>typeof a==='string'&&/^0x[0-9a-f]{64}$/i.test(a);
function decode(abi:any,data:unknown,tracking?:string):any{
 if(typeof data!=='string'||!/^0x(?:[0-9a-f]{2})+$/i.test(data)||data.length>140002)throw Error('Unsupported leader calldata.');
 const d=decodeFunctionData({abi,data:data as `0x${string}`});
 const canonical=encodeFunctionData({abi,functionName:d.functionName,args:d.args});
 if(!same(canonical,data)&&!(tracking&&same(canonical+tracking.slice(2),data)))throw Error('Noncanonical leader calldata.');
 return d.args;
}
const one=(a:any)=>{if(!Array.isArray(a)||a.length!==1)throw Error('Ambiguous leader route.');return a[0];};
async function codeHash(rpc:Rpc,address:string,block:string){const code=await rpc('eth_getCode',[address,block]);if(typeof code!=='string'||!/^0x(?:[0-9a-f]{2})+$/i.test(code))throw Error('Leader contract unavailable.');return keccak256(code as `0x${string}`);}

/** Proves a finalized, leader-signed token sale into a Relay settlement deposit.
 * Does not prove destination delivery, classify transfers as buys, or authorize
 * copying. Unknown aggregators are left unclassified. */
export async function readCashLeaderSale(input:{network:CashNetwork;leader:string;token:string;transaction:string},rpc:Rpc,now=Date.now,options:{requireFinalizedEvidence?:boolean}={}):Promise<{event:CashCopyEvent;transactionIndex:string;tradeVerified:true;adapter:'relay-kyber'|'relay-fynd'|'relay-0x'|'relay-arc-receipt';orderId:string;settlementAmountRaw:string}|null>{
 return readSale(input,rpc,now,false,10000,options.requireFinalizedEvidence);
}
export async function readCashLeaderProvisionalSale(input:{network:CashNetwork;leader:string;token:string;transaction:string},rpc:Rpc,now=Date.now){
 return readSale(input,rpc,now,true);
}
export async function readCashLeaderCapturedSale(input:{network:CashNetwork;leader:string;token:string;transaction:string},rpc:Rpc,now=Date.now){
 return readSale(input,rpc,now,true,120000);
}
async function readSale(input:{network:CashNetwork;leader:string;token:string;transaction:string},rpc:Rpc,now:()=>number,provisional:boolean,maxAge=10000,requireFinalizedEvidence=false):Promise<Awaited<ReturnType<typeof readCashLeaderSale>>>{
 const b=await (provisional?(maxAge===120000?readCashLeaderCapturedBalance(input,rpc,now):readCashLeaderProvisionalBalance(input,rpc,now)):readCashLeaderBalance(input,rpc));
 // A recovery scan already has finalized transfer logs. A null balance here
 // means the RPC has not supplied matching chain evidence yet, not that this
 // transaction was a non-sale. Never let that race advance its checkpoint.
 if(!b){if(requireFinalizedEvidence)throw Error('Finalized leader sale evidence is not available yet.');return null;}
 const cfg=cashReturnNetwork(input.network),spent=-BigInt(b.deltaRaw);
 if(spent<=0n||b.token===cfg.usdc)return null;
 let saleInput=b.input,receiptLogs=b.receipt.logs;
 if(b.sender!==b.leader||b.target!==cfg.proxy){
  const wrapper=await readFomoSmartCalls(b,rpc);if(!wrapper)return null;
  const calls=wrapper.calls,last=calls[calls.length-1];
  if(!same(last.target,cfg.proxy))throw Error('Unsupported Fomo sale target.');
  // Only this token's allowance and the exact Relay sale may occur in the
  // account batch. Sweeps, transfers and unrelated swaps are not ignored.
  for(let i=0;i<calls.length-1;i++){
   const call=calls[i];if(!same(call.target,b.token))throw Error('Unsupported Fomo sale preparation.');
   const [spender,amount]=decode(cashReturnAbi.approval,call.data);
   if(!same(spender,cfg.proxy)||amount!==(i===calls.length-2?spent:0n))throw Error('Fomo sale allowance changed.');
  }
  saleInput=last.data;
  receiptLogs=wrapper.receiptLogs;
 }
 // Decode once to obtain the committed order ID; re-encode the complete call
 // after extracting it so trailing bytes cannot change its interpretation.
 const preliminary=decodeFunctionData({abi:cashReturnAbi.proxy,data:saleInput as `0x${string}`}).args;
 const calls=preliminary[2];
 if(calls.length!==3||calls.some(c=>c.allowFailure||c.value!==0n)||!same(calls[2].target,cfg.router))throw Error('Unsupported leader sale calls.');
 const [assets,targets,datas,values]=decode(cashReturnAbi.cleanup,calls[2].callData);
 if(!same(one(assets),cfg.usdc)||!same(one(targets),cfg.depository)||one(values)!==0n)throw Error('Leader settlement changed.');
 const [depositor,asset,orderId]=decode(cashReturnAbi.deposit,one(datas));
 if(!same(depositor,b.leader)||!same(asset,cfg.usdc)||!hash(orderId))throw Error('Leader deposit owner changed.');
 const [tokens,amounts,,refundTo,nftRecipient,metadata]=decode(cashReturnAbi.proxy,saleInput,orderId);
 if(!same(one(tokens),b.token)||one(amounts)!==spent||!same(refundTo,cfg.solver)||!same(nftRecipient,cfg.solver)||!/^0x[0-9a-f]{64}00$/i.test(metadata)||!same(calls[0].target,b.token))throw Error('Leader sale funding changed.');
 const [spender,allowance]=decode(cashReturnAbi.approval,calls[0].callData);
 const fyndDeployment=cashLeaderFynd(b.network),fynd=!!fyndDeployment&&same(calls[1].target,fyndDeployment.router);
 const zero=same(calls[1].target,ZEROX_ALLOWANCE_HOLDER),arcReceipt=b.network==='arc'&&same(calls[1].target,ARC_RECEIPT.swap);
 if(!same(calls[1].target,zero?ZEROX_ALLOWANCE_HOLDER:arcReceipt?ARC_RECEIPT.swap:fynd?fyndDeployment!.router:cfg.kyber)||!same(spender,calls[1].target)||allowance!==spent)return null;
 let minimum:bigint,zeroOutput:bigint|undefined;
 if(arcReceipt){const receipt=await readArcReceiptSale({...b,receipt:{...b.receipt,logs:receiptLogs}},rpc,spent,calls[1].callData);minimum=0n;zeroOutput=receipt.output;}else if(zero){
  const [operator,token,amount,target,data]=decode(cashReturnAbi.zeroX,calls[1].callData);
  if(!same(operator,target)||!same(token,b.token)||amount!==spent)throw Error('Leader 0x allowance changed.');
  const [slippage,actions]=decode(cashReturnAbi.settler,data);
  const selected={...b,receipt:{...b.receipt,logs:receiptLogs}};
  const empty=/^0x0{40}$/i.test(slippage.recipient)&&/^0x0{40}$/i.test(slippage.buyToken)&&slippage.minAmountOut===0n;
  const route=b.network==='bnb'?await cashLeaderZeroSale(selected,rpc,target.toLowerCase(),actions,spent,empty?undefined:slippage):b.network==='arc'?await cashLeaderZeroArcSale(selected,rpc,target.toLowerCase(),actions,spent,slippage):await cashLeaderZeroMonadSale(selected,rpc,target.toLowerCase(),actions,spent,slippage);
  minimum=route.minimum;zeroOutput=route.output;
 }else if(fynd){
  const fomoTracking='0x70726f70656c6c65722f52656c61792d464f4d4f';
  const fomoClient=b.network==='base'&&calls[1].callData.toLowerCase().endsWith(fomoTracking.slice(2));
  const split=calls[1].callData.slice(0,10).toLowerCase()==='0xfe745a0f';
  const args=decode(split?splitSaleAbi:cashReturnAbi.fynd,calls[1].callData,fomoClient?fomoTracking:'0x70726f70656c6c65722f52656c6179');
  if(split&&(args[5]<2n||args[5]>256n))throw Error('Leader Tycho token count changed.');
  const [amount,tokenIn,tokenOut,expected,min]=args;
  const [receiver,fee,swaps]=args.slice(split?6:5);
  // The pinned router validates Fomo's client signature on-chain. It still
  // must charge zero client fees and permit no extra client contribution.
  const clientValid=fomoClient?same(fee.clientFeeReceiver,'0xda7da7acd714c407a37c635a42d5354d0c5b9136')&&/^0x[0-9a-f]{130}$/i.test(fee.clientSignature):/^0x0{40}$/i.test(fee.clientFeeReceiver)&&fee.clientSignature==='0x';
  if(amount!==spent||!same(tokenIn,b.token)||!same(tokenOut,cfg.usdc)||min<=0n||expected<min||!same(receiver,cfg.router)||fee.clientFeeBps!==0||!clientValid||fee.maxClientContribution!==0n||fee.deadline*1000n<BigInt(b.blockTime)||typeof swaps!=='string'||swaps.length<4||swaps.length>32770)throw Error('Leader Tycho swap changed.');
  if(await codeHash(rpc,fyndDeployment!.router,b.blockNumber)!==fyndDeployment!.codeHash)throw Error('Leader Tycho deployment changed.');
  minimum=min;
 }else{
  const swap=decode(cashReturnAbi.kyber,calls[1].callData)[0],d=swap.desc,receiver=one(d.srcReceivers);
  if(!same(swap.callTarget,cfg.executor)||!/^0x0{40}$/i.test(swap.approveTarget)||!same(d.srcToken,b.token)||!same(d.dstToken,cfg.usdc)||one(d.srcAmounts)!==spent||!same(d.dstReceiver,cfg.router)||d.amount!==spent||d.minReturnAmount<=0n||![0n,512n].includes(d.flags)||d.permit!=='0x'||d.feeReceivers.length||d.feeAmounts.length)throw Error('Leader Kyber swap changed.');
  if(!same(receiver,cfg.executor))await verifyCashSourcePool(b.network,receiver.toLowerCase(),b.token,b.blockNumber,rpc);
  minimum=d.minReturnAmount;
 }
 if(await codeHash(rpc,cfg.proxy,b.blockNumber)!==PROXY_HASH)throw Error('Leader proxy deployment changed.');
 let deposited:bigint|undefined;const indices=new Set<string>();
 for(const log of receiptLogs){
  if(log.removed!==false||!same(log.transactionHash,b.transaction)||!same(log.blockHash,b.blockHash)||log.blockNumber!==b.blockNumber||log.transactionIndex!==b.transactionIndex||typeof log.logIndex!=='string'||!/^0x(0|[1-9a-f][0-9a-f]*)$/i.test(log.logIndex)||indices.has(BigInt(log.logIndex).toString()))throw Error('Invalid leader sale receipt.');
  indices.add(BigInt(log.logIndex).toString());
  if(!same(log.address,cfg.depository))continue;
  const event=decodeEventLog({abi:returnDepositEvent,data:log.data,topics:log.topics,strict:true});
  if(deposited!==undefined||event.eventName!=='RelayErc20Deposit'||!same(event.args.from,b.leader)||!same(event.args.token,cfg.usdc)||!same(event.args.id,orderId)||event.args.amount<minimum)throw Error('Leader settlement evidence changed.');
  deposited=event.args.amount;
 }
 if(deposited===undefined)throw Error('Leader settlement deposit is missing.');
 if(zeroOutput!==undefined&&deposited!==zeroOutput)throw Error('Leader 0x settlement amount differs.');
 const observedAt=now();if(provisional&&observedAt-b.blockTime>maxAge)throw Error('Leader sale expired.');if(!Number.isSafeInteger(observedAt)||observedAt<b.blockTime)throw Error('Invalid leader observation time.');
 return{tradeVerified:true,transactionIndex:b.transactionIndex,adapter:arcReceipt?'relay-arc-receipt':zero?'relay-0x':fynd?'relay-fynd':'relay-kyber',orderId:orderId.toLowerCase(),settlementAmountRaw:String(deposited),event:{...(provisional?{confirmation:'provisional' as const}:{}),network:b.network,leader:b.leader,transaction:b.transaction,blockHash:b.blockHash,blockNumber:b.blockNumber,transactionIndex:b.transactionIndex,blockTime:b.blockTime,observedAt,token:b.token,side:'sell',leaderTokenBeforeRaw:b.beforeRaw,leaderTokenDeltaRaw:String(spent)}};
}
