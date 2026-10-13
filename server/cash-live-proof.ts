import {readCashLeaderProvisionalIntent} from './cash-leader-intent.js';
import type {readCashLeaderFill} from './cash-leader-fill.js';
import type {readCashLeaderProvisionalBalance} from './cash-leader-receipt.js';
import type {cashSourceMonitor} from './cash-source-monitor.js';
import type {CashCopyEvent} from '../src/cash-copy-model.js';
import type {Rpc} from './funding.js';
type Balance=NonNullable<Awaited<ReturnType<typeof readCashLeaderProvisionalBalance>>>;
type Fill=NonNullable<Awaited<ReturnType<typeof readCashLeaderFill>>>;
/** Pure private evidence boundary. Provider order JSON is never authority: its
 * commitment must match the independently checked, leader-signed USDC deposit.
 * Missing source/payload means no event. This module cannot submit money. */
export async function cashLiveProof(input:{balance:Balance;fill:Fill;sourceWallet:string},dependencies:{source:Pick<ReturnType<typeof cashSourceMonitor>,'find'>;order:(id:string,signal:AbortSignal)=>Promise<unknown|null>;solana:Rpc;signal:AbortSignal;now?:()=>number}){
 const {balance:b,fill:f,sourceWallet}=input,{signal}=dependencies,now=dependencies.now||Date.now;
 signal.throwIfAborted();
 if(b.confirmation!=='provisional'||b.tradeVerified!==false||f.swapVerified!==true||f.tradeVerified!==false||f.sourceAssociation!=='unverified'||f.network!==b.network||f.transaction!==b.transaction||f.blockHash!==b.blockHash||f.token!==b.token||f.recipient!==b.leader||f.outputRaw!==b.deltaRaw||BigInt(b.deltaRaw)<=0n||now()-b.blockTime>10000||now()<b.blockTime)throw Error('Live fill proof changed.');
 const source=dependencies.source.find(sourceWallet,f.orderIdHint);
 if(!source)return{state:'awaiting-source' as const,event:null};
 if(source.wallet!==sourceWallet||source.orderId!==f.orderIdHint)throw Error('Source index binding changed.');
 const order=await dependencies.order(f.orderIdHint,signal);signal.throwIfAborted();
 if(!order)return{state:'awaiting-order' as const,event:null};
 const intent=await readCashLeaderProvisionalIntent({fill:f,sourceWallet,sourceSignature:source.signature,blockTime:b.blockTime,orderData:order},dependencies.solana,now);signal.throwIfAborted();
 if(!intent)return{state:'awaiting-source' as const,event:null};
 const event:CashCopyEvent={network:b.network,leader:b.leader,transaction:b.transaction,blockHash:b.blockHash,blockNumber:b.blockNumber,transactionIndex:b.transactionIndex,blockTime:b.blockTime,observedAt:now(),token:b.token,side:'buy',leaderTokenBeforeRaw:b.beforeRaw,leaderTokenDeltaRaw:b.deltaRaw,confirmation:'provisional',sourceOrder:{wallet:sourceWallet,signature:intent.sourceSignature,orderId:intent.orderId}};
 return{state:'verified' as const,event,executionEnabled:false as const};
}
