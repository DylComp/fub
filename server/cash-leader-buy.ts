import {decodeEventLog,keccak256,parseAbi,toEventSelector} from 'viem';
import {CASH_MINT,CASH_NETWORKS,RELAY_SOLANA,type CashNetwork} from '../src/cash-route.js';
import type {CashCopyEvent} from '../src/cash-copy-model.js';
import type {Rpc} from './funding.js';
import {cashReturnNetwork} from './cash-return-networks.js';
import {readCashLeaderBalance} from './cash-leader-receipt.js';
import {LEADER_DEPOSITORY,readCashLeaderDeposit} from './cash-leader-deposit.js';
const PROXY_HASH='0xa3b36a6aa3c2fb588b92336d88b0735b40dea0282c110d2034edf688ca661b5b';
const movement=parseAbi(['event FundsMovement(address from,address to,address currency,uint256 amount,bytes metadata)']);
const movementTopic=toEventSelector(movement[0]);
const transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const same=(a:unknown,b:string)=>typeof a==='string'&&a.toLowerCase()===b.toLowerCase();
const raw=(v:unknown):bigint=>{if(typeof v!=='string'||!/^[1-9]\d{0,77}$/.test(v)||BigInt(v)>=2n**256n)throw Error('Invalid leader route amount.');return BigInt(v);};
export type CashLeaderBuyInput={network:CashNetwork;leader:string;sourceWallet:string;token:string;transaction:string};
/** Relay is an explicit indexing dependency for the association between chains.
 * Its status/amount labels alone are insufficient: both finalized chains are
 * reread, the source signer and USDC debit match the deposit commitment, and
 * the pinned destination proxy proves solver funding and token delivery.
 * sourceWallet must come from the server's resolved Fomo profile, not a client
 * event. Unsupported providers/transfer-only routes remain unclassified. */
export async function readCashLeaderBuy(input:CashLeaderBuyInput,dependencies:{evm:Rpc;solana:Rpc;requests:(filter:{fillTxHash:string})=>Promise<unknown>;now?:()=>number}){
 const b=await readCashLeaderBalance(input,dependencies.evm);if(!b||BigInt(b.deltaRaw)<=0n)return null;
 const cfg=cashReturnNetwork(input.network);
 if(b.target!==cfg.proxy||b.token===cfg.usdc||b.sender===input.leader)return null;
 const response=await dependencies.requests({fillTxHash:b.transaction}) as any;
 if(!response||!Array.isArray(response.requests)||response.requests.length!==1)throw Error('Leader bridge association is unavailable.');
 const request=response.requests[0],p=request.protocol,d=p?.deposit?.origin,fills=p?.settlement?.destination?.fills,refunds=p?.settlement?.destination?.refunds;
 if(request.status!=='success'||request.supersededByRequestId||request.duplicateDeposits?.length||request.depositAddress||request.sender!==input.sourceWallet||request.user!==input.sourceWallet||request.refundTo!==input.sourceWallet||!same(request.recipient,b.leader)||p?.hubType!=='onchain'||!same(p.solver?.address,cfg.solver)||!/^0x[0-9a-f]{64}$/.test(p.orderId)||d?.chainId!==RELAY_SOLANA||d.currency!==CASH_MINT||d.depositor!==input.sourceWallet||d.depository!==LEADER_DEPOSITORY||!Array.isArray(fills)||fills.length!==1||fills[0].chainId!==CASH_NETWORKS[input.network].chainId||!same(fills[0].transactionId,b.transaction)||!Array.isArray(refunds)||refunds.length)throw Error('Leader bridge association changed.');
 const route=request.data?.route?.actual,inbound=route?.origin?.inputCurrency,origin=route?.origin?.outputCurrency,funding=route?.destination?.inputCurrency,out=route?.destination?.outputCurrency;
 if(inbound?.currency?.chainId!==RELAY_SOLANA||inbound.currency.address!==CASH_MINT||inbound.amount!==d.amount||origin?.amount!==d.amount||origin?.currency?.address!==CASH_MINT||origin.currency.chainId!==RELAY_SOLANA||funding?.currency?.chainId!==cfg.chainId||!same(funding.currency.address,cfg.usdc)||out?.currency?.chainId!==cfg.chainId||!same(out.currency.address,b.token)||raw(out.amount)!==BigInt(b.deltaRaw)||raw(out.minimumAmount)>BigInt(b.deltaRaw)||!['kyberswap','fynd-hosted','0x'].includes(route.destination.router))throw Error('Leader swap amounts changed.');
 const paid=await readCashLeaderDeposit({wallet:input.sourceWallet,signature:d.transactionId,orderId:p.orderId,amountRaw:d.amount},dependencies.solana);
 if(!paid)return null;
 // Prevent a stale funded deposit from being associated with a fresh gift.
 // Fast fills can precede source finality by a small clock/confirmation gap.
 if(paid.blockTime>b.blockTime+30000||b.blockTime-paid.blockTime>1800000||!b.input.endsWith(p.orderId.slice(2)))throw Error('Leader bridge commitment differs.');
 const code=await dependencies.evm('eth_getCode',[cfg.proxy,b.blockNumber]);
 if(typeof code!=='string'||!/^0x(?:[0-9a-f]{2})+$/i.test(code)||keccak256(code as `0x${string}`)!==PROXY_HASH)throw Error('Leader proxy deployment changed.');
 let funded=0n,delivered=0n;const indices=new Set<string>(),topic=(address:string)=>'0x'+address.slice(2).padStart(64,'0');
 for(const log of b.receipt.logs){
  if(log.removed!==false||!same(log.transactionHash,b.transaction)||!same(log.blockHash,b.blockHash)||log.blockNumber!==b.blockNumber||log.transactionIndex!==b.transactionIndex||typeof log.logIndex!=='string'||!/^0x(0|[1-9a-f][0-9a-f]*)$/i.test(log.logIndex)||indices.has(BigInt(log.logIndex).toString()))throw Error('Invalid leader buy receipt.');
  indices.add(BigInt(log.logIndex).toString());
  if(same(log.address,cfg.proxy)&&same(log.topics?.[0],movementTopic)){
   const event=decodeEventLog({abi:movement,data:log.data,topics:log.topics,strict:true});
   if(!same(event.args.currency,cfg.usdc))continue;
   if(funded!==0n||!same(event.args.from,cfg.solver)||!same(event.args.to,cfg.router)||!/^0x[0-9a-f]{64}00$/i.test(event.args.metadata))throw Error('Leader solver funding changed.');
   funded=event.args.amount;
  }
  if(same(log.address,b.token)&&same(log.topics?.[0],transfer)&&same(log.topics?.[2],topic(b.leader))){
   if(!same(log.topics[1],topic(cfg.router)))throw Error('Leader delivery did not come from the swap router.');
   delivered+=BigInt(log.data);
  }
 }
 if(funded!==raw(funding.amount)||delivered!==BigInt(b.deltaRaw))throw Error('Leader swap funding or delivery missing.');
 const observedAt=(dependencies.now||Date.now)();if(!Number.isSafeInteger(observedAt)||observedAt<b.blockTime)throw Error('Invalid leader observation time.');
 const event:CashCopyEvent={network:b.network,leader:b.leader,transaction:b.transaction,blockHash:b.blockHash,blockNumber:b.blockNumber,transactionIndex:b.transactionIndex,blockTime:b.blockTime,observedAt,token:b.token,side:'buy',leaderTokenBeforeRaw:b.beforeRaw,leaderTokenDeltaRaw:b.deltaRaw};
 return{tradeVerified:true as const,evidence:'relay-index-and-finalized-chains' as const,event,transactionIndex:b.transactionIndex,orderId:p.orderId as string,sourceSignature:paid.signature,sourceAmountRaw:paid.amountRaw};
}
