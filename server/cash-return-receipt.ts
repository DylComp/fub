import {cashReturnNetwork} from './cash-return-networks.js';
import {decodeEventLog} from 'viem';
import canonicalize from 'canonicalize';
import {inspectCashReturn,type CashReturnRoute} from './cash-return-route.js';
import {returnDepositEvent} from './cash-return-simulation.js';
const same=(a:unknown,b:string)=>typeof a==='string'&&a.toLowerCase()===b.toLowerCase();
const transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const word=(v:unknown):v is string=>typeof v==='string'&&/^0x[0-9a-f]{64}$/i.test(v);
// Revalidate the archived quote at its original review time. Recovery uses
// the minimum committed by that route, not a mutable simulation's estimate.
// This also handles older journals without changing any signed transaction.
export function cashSaleReceiptMinimum(simulation:{route:CashReturnRoute;rawQuote?:unknown}){
 const route=inspectCashReturn(simulation.rawQuote,simulation.route.intent,simulation.route.checkedAt);
 if(canonicalize(route)!==canonicalize(simulation.route))throw Error('Sale receipt route changed.');
 const minimum=(simulation.rawQuote as any).details.route.origin.outputCurrency.minimumAmount;
 if(typeof minimum!=='string'||!/^[1-9]\d{0,77}$/.test(minimum))throw Error('Sale receipt minimum is unavailable.');
 return minimum;
}
// Called only after canonical finalized source receipt validation. The Relay
// status endpoint cannot establish that the user's token was actually sold.
export function inspectCashSaleReceipt(route:CashReturnRoute,receipt:any,bridgeMinimumRaw:string){
 const cfg=cashReturnNetwork(route.intent.network);
 if(!Array.isArray(receipt.logs)||receipt.logs.length>2000)throw Error('Sale logs unavailable.');
 let sourceNet=0n,depositRaw:string|undefined;const indices=new Set<string>();
 const owner='0x'+route.intent.wallet.slice(2).padStart(64,'0');
 for(const log of receipt.logs){
  if(log.removed!==false||!same(log.transactionHash,receipt.transactionHash)||!same(log.blockHash,receipt.blockHash)||
   typeof log.logIndex!=='string'||!/^0x(0|[1-9a-f][0-9a-f]*)$/i.test(log.logIndex)||indices.has(log.logIndex))throw Error('Invalid sale log.');
  indices.add(log.logIndex);
  if(same(log.address,route.intent.token)&&same(log.topics?.[0],transfer)){
   if(log.topics.length!==3||!log.topics.every(word)||!word(log.data))throw Error('Invalid sold token transfer.');
   if(same(log.topics[1],owner))sourceNet+=BigInt(log.data);
   if(same(log.topics[2],owner))sourceNet-=BigInt(log.data);
  }
  if(same(log.address,cfg.depository)){
   const decoded=decodeEventLog({abi:returnDepositEvent,data:log.data,topics:log.topics,strict:true});
   if(depositRaw||decoded.eventName!=='RelayErc20Deposit'||!same(decoded.args.from,route.intent.wallet)||!same(decoded.args.token,cfg.usdc)||!same(decoded.args.id,route.orderId)||decoded.args.amount<BigInt(bridgeMinimumRaw))throw Error('Sale deposit differs from the route.');
   depositRaw=String(decoded.args.amount);
  }
 }
 if(sourceNet!==BigInt(route.intent.amountRaw)||!depositRaw)throw Error('Actual sale debit or bridge deposit is missing.');
 return {sourceDebitRaw:String(sourceNet),depositedUsdcRaw:depositRaw};
}
