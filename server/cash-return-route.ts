import {cashReturnNetwork,ZEROX_ALLOWANCE_HOLDER,FYND_ROUTER} from './cash-return-networks.js';
import {decodeFunctionData,encodeFunctionData,parseAbi} from 'viem';
import {getOrderId} from '../vendor/relay-order.mjs';
import type {Order} from '@relay-protocol/settlement-sdk';
import {CASH_MINT,RELAY_SOLANA,CASH_NETWORKS,isCashNetwork,type CashNetwork} from '../src/cash-route.js';
import {isMint} from '../src/assets.js';
import {isEvmAddress} from '../src/networks.js';
// Checked standard ERC20 -> source settlement asset -> Solana USDC adapters.
// Other chains/aggregators require their own checked deployment configuration.
// Authoritative interfaces: relayprotocol/relay-periphery, relay-depository,
// and KyberNetwork/ks-dex-aggregation-router-v2-sc. A quote cannot set anchors.
export const CASH_RETURN_BASE=cashReturnNetwork('base');
export const cashReturnAbi={
 approval:parseAbi(['function approve(address spender,uint256 amount) returns (bool)']),
 proxy:parseAbi(['function transferAndMulticall(address[] tokens,uint256[] amounts,(address target,bool allowFailure,uint256 value,bytes callData)[] calls,address refundTo,address nftRecipient,bytes metadata) payable']),
 kyber:parseAbi(['function swap((address callTarget,address approveTarget,bytes targetData,(address srcToken,address dstToken,address[] srcReceivers,uint256[] srcAmounts,address[] feeReceivers,uint256[] feeAmounts,address dstReceiver,uint256 amount,uint256 minReturnAmount,uint256 flags,bytes permit) desc,bytes clientData) execution) payable']),
 cleanup:parseAbi(['function cleanupErc20sViaCall(address[] tokens,address[] tos,bytes[] datas,uint256[] amounts)']),
 directDeposit:parseAbi(['function depositErc20(address depositor,address token,uint256 amount,bytes32 id)']),
 fynd:parseAbi(['function singleSwap(uint256 amountIn,address tokenIn,address tokenOut,uint256 expectedAmountOut,uint256 minAmountOut,address receiver,(uint32 clientFeeBps,address clientFeeReceiver,uint256 maxClientContribution,uint256 deadline,bytes clientSignature) clientFeeParams,bytes swap) payable returns (uint256)','function sequentialSwap(uint256 amountIn,address tokenIn,address tokenOut,uint256 expectedAmountOut,uint256 minAmountOut,address receiver,(uint32 clientFeeBps,address clientFeeReceiver,uint256 maxClientContribution,uint256 deadline,bytes clientSignature) clientFeeParams,bytes swaps) payable returns (uint256)']),
 zeroX:parseAbi(['function exec(address operator,address token,uint256 amount,address target,bytes data) payable returns (bytes)']),
 settler:parseAbi(['function execute((address recipient,address buyToken,uint256 minAmountOut) slippage,bytes[] actions,bytes32 zid) payable returns (bool)']),
 deposit:parseAbi(['function depositErc20(address depositor,address token,bytes32 id)'])
};
export type CashReturnIntent={network:CashNetwork;wallet:string;cashWallet:string;token:string;amountRaw:string;slippageBps:number};
export type CashReturnCall={from:string;to:string;data:`0x${string}`;value:'0';chainId:number};
export type CashReturnRoute={executable:false;intent:CashReturnIntent;requestId:string;orderId:string;outputRaw:string;minimumRaw:string;refundCurrency:string;refundWallet:string;adapter?:'kyberswap'|'0x'|'direct'|'fynd-hosted';settler?:string;sourcePool?:string;approval:CashReturnCall|null;sale:CashReturnCall;checkedAt:number;expiresAt:number};
const same=(a:unknown,b:string)=>typeof a==='string'&&a.toLowerCase()===b.toLowerCase();
const hash=(v:unknown):v is string=>typeof v==='string'&&/^0x[0-9a-f]{64}$/i.test(v);
const obj=(v:any):any=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('Invalid cash return quote.');return v;};
const arr=(v:any,min:number,max=min):any[]=>{if(!Array.isArray(v)||v.length<min||v.length>max)throw Error('Unexpected cash return steps.');return v;};
const raw=(v:unknown)=>{if(typeof v!=='string'||! /^(0|[1-9]\d{0,77})$/.test(v)||BigInt(v)>=2n**256n)throw Error('Invalid cash return amount.');return BigInt(v);};
function intent(i:CashReturnIntent){if(!isCashNetwork(i.network)||!isEvmAddress(i.wallet)||!isEvmAddress(i.token)||/^0x0{40}$/i.test(i.wallet)||/^0x0{40}$/i.test(i.token)||!isMint(i.cashWallet)||raw(i.amountRaw)<=0n||!Number.isInteger(i.slippageBps)||i.slippageBps<1||i.slippageBps>100)throw Error('Invalid cash sale.');}
export function cashReturnRequest(i:CashReturnIntent){intent(i);return {user:i.wallet,recipient:i.cashWallet,originChainId:CASH_NETWORKS[i.network].chainId,destinationChainId:RELAY_SOLANA,originCurrency:i.token,destinationCurrency:CASH_MINT,amount:i.amountRaw,tradeType:'EXACT_INPUT',slippageTolerance:String(Math.max(1,i.slippageBps-1)),refundTo:i.wallet,includeProtocolData:true,useDepositAddress:false,explicitDeposit:true,topupGas:false,...(['base','bnb','monad','arc','ethereum'].includes(i.network)?{includedOriginSwapSources:['kyberswap']}:i.network==='robinhood'?{includedOriginSwapSources:['fynd-hosted']}: {})};}
function currency(v:any,chain:number,address:string,decimals?:number){const c=obj(v);if(c.chainId!==chain||(chain===RELAY_SOLANA?c.address!==address:!same(c.address,address))||!Number.isInteger(c.decimals)||c.decimals<0||c.decimals>36||decimals!==undefined&&c.decimals!==decimals)throw Error('Cash return currency changed.');}
function decode(abi:any,data:unknown,tracking?:string):any{
 if(typeof data!=='string'||!/^0x(?:[a-f0-9]{2})+$/i.test(data)||data.length>65538)throw Error('Invalid cash return calldata.');
 const d=decodeFunctionData({abi,data:data as `0x${string}`});
 const canonical=encodeFunctionData({abi,functionName:d.functionName,args:d.args});
 if(!same(canonical,data)&&!(tracking&&same(canonical+tracking.slice(2),data)))throw Error('Noncanonical cash return calldata.');return d.args;
}
function approve(data:unknown,spender:string,amount:bigint){const a=decode(cashReturnAbi.approval,data);if(!same(a[0],spender)||a[1]!==amount)throw Error('Cash sale allowance changed.');}
export function inspectCashReturn(value:unknown,i:CashReturnIntent,now=Date.now()):CashReturnRoute{
 intent(i);const cfg=cashReturnNetwork(i.network),q=obj(value),d=obj(q.details),input=obj(d.currencyIn),output=obj(d.currencyOut),route=obj(obj(d.route).origin),bridge=obj(route.outputCurrency);
 currency(input.currency,cfg.chainId,i.token);currency(output.currency,RELAY_SOLANA,CASH_MINT,6);currency(bridge.currency,cfg.chainId,cfg.usdc,cfg.decimals);
 if(!same(d.sender,i.wallet)||d.recipient!==i.cashWallet||input.amount!==i.amountRaw||d.operation!=='swap'||!(same(i.token,cfg.usdc)?route.router==='relay':route.router==='0x'||i.network==='robinhood'&&route.router==='fynd-hosted'||['base','bnb','monad','arc','ethereum'].includes(i.network)&&route.router==='kyberswap')||obj(d.slippageTolerance).total!==String(Math.max(1,i.slippageBps-1)))throw Error('Cash sale differs from the request.');
 const expected=raw(output.amount),minimum=raw(output.minimumAmount),bridgeExpected=raw(bridge.amount),bridgeMinimum=raw(bridge.minimumAmount);
 if(minimum<=0n||minimum>expected||minimum<expected*BigInt(10000-i.slippageBps)/10000n||bridgeMinimum<=0n||bridgeMinimum>bridgeExpected||bridgeMinimum<bridgeExpected*BigInt(10000-i.slippageBps)/10000n)throw Error('Cash sale exceeds slippage.');
 const protocol=obj(obj(q.protocol).v2),order=obj(protocol.orderData),out=obj(order.output),first=obj(arr(order.inputs,1)[0]),payment=obj(first.payment),delivery=obj(arr(out.payments,1)[0]);
 if(protocol.hubType!=='onchain'||order.version!=='v1'||order.solverChainId!=='base'||!same(order.solver,cfg.solver)||payment.chainId!==cfg.protocol||!same(payment.currency,cfg.usdc)||payment.amount!==bridge.amount||payment.weight!=='1'||out.chainId!=='solana'||delivery.recipient!==i.cashWallet||delivery.currency!==CASH_MINT||delivery.minimumAmount!==minimum.toString()||delivery.expectedAmount!==expected.toString()||out.extraData!=='0x')throw Error('Cash return order changed.');
 arr(out.calls,0);arr(order.fees,0);
 if(!Number.isSafeInteger(out.deadline)||out.deadline*1000<=now+30000||out.deadline*1000>now+8*86400000)throw Error('Cash return order expired.');
 const refunds=arr(first.refunds,1,2);
 if(!refunds.some(r=>r.chainId===cfg.protocol&&same(r.currency,cfg.usdc)&&same(r.recipient,i.wallet)))throw Error('Cash return refund missing.');
 for(const r of refunds){if(r.deadline!==out.deadline||raw(r.minimumAmount)!==0n||(r.chainId===cfg.protocol?!same(r.currency,cfg.usdc)||!same(r.recipient,i.wallet)||!same(r.extraData,'0x'+cfg.router.slice(2).padStart(64,'0')):r.chainId!=='solana'||r.currency!==CASH_MINT||r.recipient!==i.cashWallet||r.extraData!=='0x'))throw Error('Cash return refund changed.');}
 const chainVms={base:'ethereum-vm',bnb:'ethereum-vm',monad:'ethereum-vm',robinhood:'ethereum-vm',arc:'ethereum-vm',ethereum:'ethereum-vm',solana:'solana-vm'} as const;
 if(!hash(protocol.orderId)||!same(getOrderId(order as Order,chainVms),protocol.orderId))throw Error('Cash return commitment changed.');
 const deposit=obj(protocol.paymentDetails);if(deposit.chainId!==cfg.protocol||!same(deposit.depository,cfg.depository)||!same(deposit.currency,cfg.usdc)||deposit.amount!==bridge.amount)throw Error('Cash return deposit changed.');
 const steps=arr(q.steps,1,2);let approval:CashReturnCall|null=null;
 function call(step:any):CashReturnCall{if(step.kind!=='transaction'||step.depositAddress)throw Error('Unsupported cash sale step.');const data=obj(arr(step.items,1)[0].data);if(!same(data.from,i.wallet)||data.chainId!==cfg.chainId||data.value!=='0')throw Error('Cash sale source changed.');return {from:i.wallet.toLowerCase(),to:data.to,data:data.data,value:'0',chainId:cfg.chainId};}
 if(steps.length===2){if(steps[0].id!=='approve')throw Error('Unsupported sale approval.');approval=call(steps[0]);if(!same(approval.to,i.token))throw Error('Wrong sale approval token.');approve(approval.data,same(i.token,cfg.usdc)?cfg.depository:cfg.proxy,raw(i.amountRaw));}
 const step=steps.at(-1),sale=call(step),check=obj(arr(step.items,1)[0].check);
 if(step.id!=='deposit'||!hash(step.requestId)||q.requestId!==step.requestId||check.method!=='GET'||check.endpoint!==`/intents/status/v3?requestId=${step.requestId}`||!same(sale.to,same(i.token,cfg.usdc)?cfg.depository:cfg.proxy))throw Error('Cash sale destination changed.');
 let sourcePool:string|undefined;
 const result=(adapter:'kyberswap'|'0x'|'direct'|'fynd-hosted',settler?:string):CashReturnRoute=>({executable:false,intent:{...i,wallet:i.wallet.toLowerCase(),token:i.token.toLowerCase()},requestId:step.requestId,orderId:protocol.orderId,outputRaw:expected.toString(),minimumRaw:minimum.toString(),refundCurrency:cfg.usdc,refundWallet:i.wallet.toLowerCase(),adapter,...(settler?{settler}:{}),...(sourcePool?{sourcePool}:{}),approval,sale,checkedAt:now,expiresAt:now+30000});
 if(same(i.token,cfg.usdc)){
  const [depositor,asset,amount,id]=decode(cashReturnAbi.directDeposit,sale.data);
  if(!same(depositor,i.wallet)||!same(asset,i.token)||amount!==raw(i.amountRaw)||!same(id,protocol.orderId)||bridgeExpected!==amount||bridgeMinimum!==amount)throw Error('Direct cash return changed.');
  return result('direct');
 }
 let settler:string|undefined;
 const [tokens,amounts,calls,refundTo,nftRecipient,metadata]=decode(cashReturnAbi.proxy,sale.data,protocol.orderId);
 if(arr(tokens,1)[0].toLowerCase()!==i.token.toLowerCase()||arr(amounts,1)[0]!==raw(i.amountRaw)||!same(refundTo,cfg.solver)||!same(nftRecipient,cfg.solver)||!/^0x[0-9a-f]{64}00$/i.test(metadata))throw Error('Cash sale transfer changed.');
 arr(calls,3);if(calls.some((c:any)=>c.allowFailure!==false||c.value!==0n))throw Error('Cash sale permits partial execution.');
 const swapTarget=route.router==='0x'?ZEROX_ALLOWANCE_HOLDER:route.router==='fynd-hosted'?FYND_ROUTER:cfg.kyber;
 if(!same(calls[0].target,i.token)||!same(calls[1].target,swapTarget)||!same(calls[2].target,cfg.router))throw Error('Unexpected sale target.');
 approve(calls[0].callData,swapTarget,raw(i.amountRaw));
 if(route.router==='0x'){
  const [operator,token,amount,target,data]=decode(cashReturnAbi.zeroX,calls[1].callData);
  if(!same(operator,target)||!isEvmAddress(target)||!same(token,i.token)||amount!==raw(i.amountRaw))throw Error('Cash sale allowance holder changed.');
  const [slippage,actions]=decode(cashReturnAbi.settler,data);
  if(!same(slippage.recipient,cfg.router)||!same(slippage.buyToken,cfg.usdc)||slippage.minAmountOut<bridgeMinimum||slippage.minAmountOut>bridgeExpected)throw Error('Cash sale settlement minimum changed.');
  arr(actions,1,64);settler=target.toLowerCase();
  // The execution simulator independently checks the current or previous official 0x
  // deployer registry at the same block before permitting this target.
 }else if(route.router==='fynd-hosted'){
  const [amount,tokenIn,tokenOut,expectedOut,minOut,receiver,fee,swaps]=decode(cashReturnAbi.fynd,calls[1].callData,'0x70726f70656c6c65722f52656c6179');
  if(amount!==raw(i.amountRaw)||!same(tokenIn,i.token)||!same(tokenOut,cfg.usdc)||expectedOut!==bridgeExpected||minOut<bridgeMinimum||minOut>bridgeExpected||!same(receiver,cfg.router)||fee.clientFeeBps!==0||!/^0x0{40}$/i.test(fee.clientFeeReceiver)||fee.maxClientContribution!==0n||fee.clientSignature!=='0x'||fee.deadline<BigInt(Math.ceil(now/1000)+30)||typeof swaps!=='string'||swaps.length<4||swaps.length>32770)throw Error('Cash sale Tycho route changed.');
 }else{

 const swap=decode(cashReturnAbi.kyber,calls[1].callData)[0],desc=swap.desc;
 const receiver=arr(desc.srcReceivers,1)[0];
 if(!same(receiver,cfg.executor)){
  if(!['bnb','base'].includes(i.network)||!isEvmAddress(receiver)||/^0x0{40}$/i.test(receiver))throw Error('Cash sale source pool is unsupported.');
  // The simulator must prove this is a canonical pair from a pinned chain-specific factory containing the
  // input token at the same block. A quote alone cannot approve a receiver.
  sourcePool=receiver.toLowerCase();
 }
 // 0x200 is unused by this verified router version. No partial fills, ETH
 // claims, burns, permits, fees or arbitrary approval target are accepted.
 if(!same(swap.callTarget,cfg.executor)||!/^0x0{40}$/i.test(swap.approveTarget)||!same(desc.srcToken,i.token)||!same(desc.dstToken,cfg.usdc)||arr(desc.srcAmounts,1)[0]!==raw(i.amountRaw)||!same(desc.dstReceiver,cfg.router)||desc.amount!==raw(i.amountRaw)||desc.minReturnAmount<bridgeMinimum-1n||desc.minReturnAmount>bridgeExpected||![0n,512n].includes(desc.flags)||desc.permit!=='0x')throw Error('Cash sale swap changed.');
 arr(desc.feeReceivers,0);arr(desc.feeAmounts,0);
 }
 const [assets,targets,datas,values]=decode(cashReturnAbi.cleanup,calls[2].callData);
 if(!same(arr(assets,1)[0],cfg.usdc)||!same(arr(targets,1)[0],cfg.depository)||arr(values,1)[0]!==0n)throw Error('Cash sale cleanup changed.');
 const [depositor,asset,orderId]=decode(cashReturnAbi.deposit,arr(datas,1)[0]);
 if(!same(depositor,i.wallet)||!same(asset,cfg.usdc)||!same(orderId,protocol.orderId))throw Error('Cash sale commitment changed.');
 return result(route.router==='0x'?'0x':route.router==='fynd-hosted'?'fynd-hosted':'kyberswap',settler);
}
