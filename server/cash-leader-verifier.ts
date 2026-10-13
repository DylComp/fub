import canonicalize from 'canonicalize';
import type {CashCopyJob} from './cash-copy-service.js';
import type {CashCopyEvent} from '../src/cash-copy-model.js';
import {validateCashCopyEvent} from '../src/cash-copy-model.js';
import type {CashNetwork} from '../src/cash-route.js';
import type {Rpc} from './funding.js';
import {readCashLeaderSale} from './cash-leader-sale.js';
import {readCashLeaderBuy} from './cash-leader-buy.js';

// Re-read chain evidence inside the private signing process. The observer's
// label, amount, timestamp and balance cannot authorize a transaction.
export function cashLeaderVerifier(config:{rpc:(network:CashNetwork)=>Rpc;now?:()=>number;allowsAsset?:(network:CashNetwork,token:string)=>boolean;live?:(event:CashCopyEvent,signal:AbortSignal)=>Promise<CashCopyEvent|null>;captured?:(job:CashCopyJob,signal:AbortSignal)=>Promise<CashCopyEvent|null>;buy?:{solana:Rpc;requests:(filter:{fillTxHash:string})=>Promise<unknown>;sourceWallet:(leader:string)=>Promise<string>}},readSale=readCashLeaderSale,readBuy=readCashLeaderBuy){
 return async(job:CashCopyJob,signal:AbortSignal)=>{
  signal.throwIfAborted();validateCashCopyEvent(job.event,job.scope,(config.now||Date.now)());
  if(config.allowsAsset&&!config.allowsAsset(job.event.network,job.event.token))throw Error('The token is outside the approved copy test.');
  if(job.event.side==='buy'&&job.event.confirmation!=='provisional'&&!config.buy)throw Error('Cross-chain leader buys require verified source-payment evidence.');
  const expected=job.event;
  if(expected.confirmation==='captured'){
   if(!config.captured)throw Error('Captured sale verification is unavailable.');
   const verified=await config.captured(job,signal);signal.throwIfAborted();
   if(!verified||canonicalize(verified)!==canonicalize(expected))throw Error('Captured sale evidence changed.');
   validateCashCopyEvent(verified,job.scope,(config.now||Date.now)());return;
  }
  if(expected.confirmation==='provisional'){
   if(!config.live)throw Error('Live copy verification is not connected to signing yet.');
   const verified=await config.live(expected,signal);signal.throwIfAborted();
   if(!verified)throw Error('Live leader evidence is unavailable.');
   validateCashCopyEvent(verified,job.scope,(config.now||Date.now)());
   const {observedAt:_expectedAt,...a}=expected,{observedAt:_verifiedAt,...b}=verified;
   if(canonicalize(a)!==canonicalize(b))throw Error('Live leader evidence changed.');
   return;
  }
  const input={network:expected.network,leader:expected.leader,token:expected.token,transaction:expected.transaction};
  const result=expected.side==='sell'?await readSale(input,config.rpc(expected.network),config.now):await readBuy({...input,sourceWallet:await config.buy!.sourceWallet(expected.leader)},{evm:config.rpc(expected.network),solana:config.buy!.solana,requests:config.buy!.requests,now:config.now});
  signal.throwIfAborted();
  if(expected.sourceOrder){
   const buy=result as Awaited<ReturnType<typeof readCashLeaderBuy>>;
   if(!buy||buy.orderId!==expected.sourceOrder.orderId||buy.sourceSignature!==expected.sourceOrder.signature||await config.buy!.sourceWallet(expected.leader)!==expected.sourceOrder.wallet)throw Error('Leader source commitment changed.');
  }
  if(!result||result.tradeVerified!==true)throw Error('The leader trade is not independently verified.');
  // observedAt is the local discovery time, not a consensus field. Every
  // chain-derived value, including exact pre-sale inventory, must match.
  const fields:readonly (keyof CashCopyEvent)[]=['network','leader','transaction','blockHash','blockNumber','blockTime','token','side','leaderTokenBeforeRaw','leaderTokenDeltaRaw'];
  if(fields.some(field=>result.event[field]!==expected[field])||expected.transactionIndex!==undefined&&result.event.transactionIndex!==expected.transactionIndex)throw Error('The leader trade differs from the saved observation.');
 };
}
