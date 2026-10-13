import {CASH_GAS_POLICY,cashNetworkByChainId,cashGasBudget} from '../src/cash-network-policy.js';
import {CASH_NETWORKS} from '../src/cash-route.js';
import {decodeFunctionResult,encodeFunctionData,parseAbi,parseTransaction,recoverTransactionAddress,keccak256,serializeTransaction} from 'viem';
import type {Rpc} from './funding.js';
import type {CashReturnCall} from './cash-return-route.js';
import type {simulateCashReturn} from './cash-return-simulation.js';
export type CashReturnSimulation=Awaited<ReturnType<typeof simulateCashReturn>>;
export type CashEvmTransaction={chainId:number;type:'eip1559';from:string;to:string;data:`0x${string}`;value:'0';nonce:number;gas:string;maxFeePerGas:string;maxPriorityFeePerGas:string};
export type CashReturnGas={blockHash:string;checkedAt:number;expiresAt:number;balanceWei:string;maxCostWei:string;maxL1FeeWei:string;baseFeePerGas?:string;transactions:CashEvmTransaction[]};
const quantity=(v:unknown):bigint=>{if(typeof v!=='string'||!/^0x(0|[1-9a-f][0-9a-f]{0,63})$/i.test(v))throw Error('Invalid gas response.');return BigInt(v);};
const word=(v:unknown):bigint=>{if(typeof v!=='string'||!/^0x[0-9a-f]{64}$/i.test(v))throw Error('Gas oracle unavailable.');return BigInt(v);};
const same=(a:unknown,b:string)=>typeof a==='string'&&a.toLowerCase()===b.toLowerCase();
// Base's chain-owned GasPriceOracle. getL1FeeUpperBound accepts the unsigned
// transaction size. Conservatively allow 256 additional signature/RLP bytes.
const oracle='0x420000000000000000000000000000000000000F';
const gasAbi=parseAbi(['function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)']);
export function serializeCashEvm(tx:CashEvmTransaction){return serializeTransaction({type:'eip1559',chainId:tx.chainId,to:tx.to as `0x${string}`,data:tx.data,value:0n,nonce:tx.nonce,gas:BigInt(tx.gas),maxFeePerGas:BigInt(tx.maxFeePerGas),maxPriorityFeePerGas:BigInt(tx.maxPriorityFeePerGas)});}
export async function inspectSignedCashEvm(expected:CashEvmTransaction,signed:string){
 if(typeof signed!=='string'||!/^0x02[0-9a-f]+$/i.test(signed)||signed.length%2!==0||signed.length>140000)throw Error('Invalid signed cash sale.');
 cashNetworkByChainId(expected.chainId);
 const tx=parseTransaction(signed as `0x${string}`);
 if(tx.type!=='eip1559'||tx.chainId!==expected.chainId||!same(tx.to,expected.to)||!same(tx.data||'0x',expected.data)||
  (tx.value||0n)!==0n||tx.nonce!==expected.nonce||tx.gas!==BigInt(expected.gas)||tx.maxFeePerGas!==BigInt(expected.maxFeePerGas)||
  tx.maxPriorityFeePerGas!==BigInt(expected.maxPriorityFeePerGas)||tx.accessList?.length||!tx.r||!tx.s||
  !same(await recoverTransactionAddress({serializedTransaction:signed as `0x02${string}`}),expected.from))throw Error('The signed sale differs from its review.');
 if(serializeTransaction(tx as Parameters<typeof serializeTransaction>[0])!==signed.toLowerCase())throw Error('Noncanonical sale transaction.');
 return keccak256(signed as `0x${string}`);
}
export async function prepareCashReturnGas(simulation:CashReturnSimulation,rpc:Rpc,maxCostWei:string,now=Date.now()):Promise<CashReturnGas>{
 const network=simulation.route.intent.network,policy=CASH_GAS_POLICY[network],chainId=CASH_NETWORKS[network].chainId;
 cashGasBudget(network,maxCostWei);
 if(simulation.expiresAt<=now||simulation.checkedAt>now)throw Error('Refresh the sale gas review.');
 const wallet=simulation.route.intent.wallet;
 if(quantity(await rpc('eth_chainId',[]))!==BigInt(chainId))throw Error('Wrong sale gas network.');
 const [latest,pending,balance,fees]=await Promise.all([
  rpc('eth_getTransactionCount',[wallet,'latest']),rpc('eth_getTransactionCount',[wallet,'pending']),rpc('eth_getBalance',[wallet,'latest']),rpc('eth_feeHistory',['0x1','latest',[50]])
 ]);
 const nonce=quantity(latest);if(nonce!==quantity(pending)||nonce>BigInt(Number.MAX_SAFE_INTEGER-2))throw Error('Wait for the existing EVM transaction to settle.');
 const history=fees as any;
 if(!Array.isArray(history?.baseFeePerGas)||history.baseFeePerGas.length!==2||!Array.isArray(history.reward)||history.reward.length!==1||history.reward[0].length!==1)throw Error('Sale gas prices unavailable.');
 const base=quantity(history.baseFeePerGas[1]),tip=quantity(history.reward[0][0])>BigInt(policy.minTip)?quantity(history.reward[0][0]):BigInt(policy.minTip);
 const maxFee=base*2n+tip;if(maxFee<=0n||maxFee>BigInt(policy.maxFeePerGas))throw Error('Sale gas price exceeds the limit.');
 const calls:CashReturnCall[]=[...(simulation.route.approval?[simulation.route.approval]:[]),simulation.route.sale];
 const gasUsed=[...(simulation.route.approval?[BigInt(simulation.approvalGasUsed)]:[]),BigInt(simulation.saleGasUsed)];
 let total=0n,l1Total=0n;
 const transactions:CashEvmTransaction[]=[];
 for(let index=0;index<calls.length;index++){
  const call=calls[index];if(call.chainId!==chainId||call.from.toLowerCase()!==wallet.toLowerCase())throw Error('Sale gas call changed.');
  let posterGas=0n;
  if(policy.l1==='nitro'){
   // Nitro charges parent data through gas units, not Base's separate L1 fee.
   const abi=parseAbi(['function gasEstimateL1Component(address to,bool contractCreation,bytes data) payable returns (uint64 gasEstimateForL1,uint256 baseFee,uint256 l1BaseFeeEstimate)']);
   const result=await rpc('eth_call',[{from:wallet,to:'0x00000000000000000000000000000000000000C8',data:encodeFunctionData({abi,functionName:'gasEstimateL1Component',args:[call.to as `0x${string}`,false,call.data]})},'latest']);
   if(typeof result!=='string'||!/^0x[0-9a-f]{192}$/i.test(result))throw Error('Destination data gas unavailable.');
   const [units]=decodeFunctionResult({abi,functionName:'gasEstimateL1Component',data:result as `0x${string}`});
   if(units>1000000n)throw Error('Destination data gas exceeds the limit.');posterGas=units*2n;
  }
  const verified=simulation.verifiedGasLimits;
  if(network==='monad'&&(!verified||verified.length!==calls.length||verified.some(n=>!/^[1-9]\d{0,6}$/.test(n))))throw Error('Monad sale gas limits were not simulated.');
  const gas=network==='monad'?BigInt(verified![index]):(gasUsed[index]*13n+9n)/10n+10000n+posterGas;
  if(network==='monad'&&gasUsed[index]>gas)throw Error('Monad sale exceeds its simulated gas limit.');
  if(gas<=21000n||gas>2700000n)throw Error('Sale gas usage is unsupported.');
  const tx:CashEvmTransaction={...call,type:'eip1559',nonce:Number(nonce)+index,gas:String(gas),maxFeePerGas:String(maxFee),maxPriorityFeePerGas:String(tip)};
  const size=BigInt((serializeCashEvm(tx).length-2)/2+256);
  const l1=policy.l1==='op'?word(await rpc('eth_call',[{to:oracle,data:encodeFunctionData({abi:gasAbi,functionName:'getL1FeeUpperBound',args:[size]})},'latest']))*2n:0n;
  l1Total+=l1;total+=gas*maxFee+l1;transactions.push(tx);
 }
 // Arc's ERC-20 USDC balance is the native gas balance expressed with six
 // decimals. Reserve the principal once before checking gas, never count it
 // as two independent accounts.
 const principal=network==='arc'&&simulation.route.intent.token?.toLowerCase()==='0x3600000000000000000000000000000000000000'?BigInt(simulation.route.intent.amountRaw)*1000000000000n:0n;
 const nativeBalance=quantity(balance);if(nativeBalance<principal)throw Error('Destination token balance is insufficient.');
 const balanceWei=nativeBalance-principal;
 if((network==='monad'||network==='ethereum')&&total>BigInt(maxCostWei)){
  // A fixed 2x base-fee buffer can exceed the user's ceiling even when the
  // real fee fits. Bound the signed fee bid by that ceiling, retaining 25%
  // base-fee headroom and the chain's minimum tip. Never raise the budget.
  const units=transactions.reduce((sum,tx)=>sum+BigInt(tx.gas),0n);
  const available=balanceWei<BigInt(maxCostWei)?balanceWei:BigInt(maxCostWei);
  const boundedFee=available/units;
  const minimumFee=(base*125n+99n)/100n+BigInt(policy.minTip);
  if(boundedFee<minimumFee)throw Error('Sale exceeds its total gas budget.');
  const boundedTip=tip<boundedFee-(base*125n+99n)/100n?tip:boundedFee-(base*125n+99n)/100n;
  for(const tx of transactions){tx.maxFeePerGas=String(boundedFee);tx.maxPriorityFeePerGas=String(boundedTip);}
  total=units*boundedFee;
 }
 if(total>BigInt(maxCostWei))throw Error('Sale exceeds its total gas budget.');
 if(balanceWei<total)throw Error('Destination gas has not arrived or is insufficient. No sale was submitted.');
 const block=await rpc('eth_getBlockByNumber',[simulation.blockNumber,false]) as any;
 if(!same(block?.hash,simulation.blockHash))throw Error('Sale simulation block changed.');
 return {blockHash:simulation.blockHash,checkedAt:now,expiresAt:Math.min(simulation.expiresAt,now+30000),balanceWei:String(balanceWei),maxCostWei,maxL1FeeWei:String(l1Total),baseFeePerGas:String(base),transactions};
}
// The first confirmed approval must not authorize a mutated sale. A pending
// signature is journaled before broadcasting and is never rebuilt on timeout.
export function finalizedCashEvm(tx:CashEvmTransaction,signed:string,rpc:Rpc){return checkedCashEvm(tx,signed,rpc,'finalized');}
// Confirmation permits independently accounted quick continuation, never final settlement.
export function confirmedCashEvm(tx:CashEvmTransaction,signed:string,rpc:Rpc){return checkedCashEvm(tx,signed,rpc,'latest');}
async function checkedCashEvm(tx:CashEvmTransaction,signed:string,rpc:Rpc,tag:'latest'|'finalized'):Promise<{state:'pending'|'confirmed'|'reverted';feeWei?:string;receipt?:any}>{
 const hash=await inspectSignedCashEvm(tx,signed),network=cashNetworkByChainId(tx.chainId),policy=CASH_GAS_POLICY[network];
 if(quantity(await rpc('eth_chainId',[]))!==BigInt(tx.chainId))throw Error('Wrong cash sale network.');
 const receipt=await rpc('eth_getTransactionReceipt',[hash]) as any;if(!receipt)return {state:'pending'};
 const actual=await rpc('eth_getTransactionByHash',[hash]) as any;
 if(!actual||!same(actual.hash,hash)||!same(actual.from,tx.from)||!same(actual.to,tx.to)||!same(actual.input,tx.data)||quantity(actual.nonce)!==BigInt(tx.nonce)||quantity(actual.value)!==0n||quantity(actual.chainId)!==BigInt(tx.chainId)||!same(receipt.transactionHash,hash)||!same(receipt.from,tx.from)||!same(receipt.to,tx.to)||!same(actual.blockHash,receipt.blockHash))throw Error('Sale receipt changed.');
 const final=await rpc('eth_getBlockByNumber',[tag,false]) as any;
 if(quantity(final?.number)<quantity(receipt.blockNumber))return {state:'pending'};
 const canonical=await rpc('eth_getBlockByNumber',[receipt.blockNumber,false]) as any;
 if(!same(canonical?.hash,receipt.blockHash))return {state:'pending'};
 const used=quantity(receipt.gasUsed),price=quantity(receipt.effectiveGasPrice);
 if(used>BigInt(tx.gas)||price>BigInt(tx.maxFeePerGas)||![0n,1n].includes(quantity(receipt.status)))throw Error('Sale fee evidence changed.');
 // Base charges L1 data fees in addition to EVM execution gas.
 if(policy.l1!=='op'&&receipt.l1Fee!==undefined&&quantity(receipt.l1Fee)!==0n)throw Error('Unexpected destination data fee.');
 const fee=used*price+(policy.l1==='op'?quantity(receipt.l1Fee):0n);
 return {state:quantity(receipt.status)===1n?'confirmed':'reverted',feeWei:String(fee),receipt};
}
