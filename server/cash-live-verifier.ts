import type {CashCopyEvent} from '../src/cash-copy-model.js';
import type {CashNetwork} from '../src/cash-route.js';
import type {Rpc} from './funding.js';
import {readCashLeaderProvisionalBalance} from './cash-leader-receipt.js';
import {readCashLeaderFill} from './cash-leader-fill.js';
import {readCashLeaderProvisionalSale} from './cash-leader-sale.js';
import {cashStatusProof} from './cash-status-proof.js';
/** Rereads chain evidence for dispatch and again before signing. No cached
 * observer label can authorize a trade, and no caller chooses a source owner. */
export function cashLiveVerifier(config:{rpc:(network:CashNetwork,signal:AbortSignal)=>Rpc;solana:(signal:AbortSignal)=>Rpc;sourceWallet:(leader:string,network:CashNetwork)=>string|null;fetch?:typeof fetch;now?:()=>number;status?:(requestId:string)=>unknown}){
 return async(event:CashCopyEvent,signal:AbortSignal):Promise<CashCopyEvent|null>=>{
  signal.throwIfAborted();if(event.confirmation!=='provisional')throw Error('Expected live leader event.');
  const sourceWallet=config.sourceWallet(event.leader,event.network);if(!sourceWallet)throw Error('Unverified leader identity.');
  if(event.side==='buy'&&event.sourceOrder?.wallet!==sourceWallet)throw Error('Leader funding identity changed.');
  const base=config.rpc(event.network,signal),rpc:Rpc=async(m,p)=>{signal.throwIfAborted();const r=await base(m,p);signal.throwIfAborted();return r;};
  const input={network:event.network,leader:event.leader,token:event.token,transaction:event.transaction};
  if(event.side==='sell'){const sale=await readCashLeaderProvisionalSale(input,rpc,config.now);signal.throwIfAborted();return sale?.event||null;}
  const balance=await readCashLeaderProvisionalBalance(input,rpc,config.now);if(!balance)return null;
  const fill=await readCashLeaderFill(balance,rpc);if(!fill)return null;
  const proof=await cashStatusProof({balance,fill,sourceWallet},{solana:config.solana(signal),signal,fetch:config.fetch,now:config.now,status:config.status});
  signal.throwIfAborted();return proof.event;
 };
}
