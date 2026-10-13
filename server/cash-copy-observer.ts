import {cashCopyJournal,type CashCopyCas} from './cash-copy-journal.js';
import {cashLeaderDiscovery} from './cash-leader-discovery.js';
import {readCashLeaderBuy} from './cash-leader-buy.js';
import {readCashLeaderSale} from './cash-leader-sale.js';
import type {CashNetwork} from '../src/cash-route.js';
import type {Rpc} from './funding.js';
import type {cashRelay} from './cash-relay.js';
import type {cashCopyService} from './cash-copy-service.js';

/** Private hosted orchestration. No HTTP payload supplies a grant, RPC URL,
 * signer or leader evidence. Recover existing submissions before discovering
 * more work, even after public execution is disabled or permission expires. */
export function cashCopyObserver(config:{cas:CashCopyCas;planId:string;wallet:string;enabled:()=>boolean;executor:Pick<ReturnType<typeof cashCopyService>,'tick'>;rpc:(network:CashNetwork)=>Rpc;solana:Rpc;relay:Pick<ReturnType<typeof cashRelay>,'requests'>;leaderSource:(leader:string)=>Promise<string>;allowsAsset?:(network:CashNetwork,token:string)=>boolean;now?:()=>number}){
 const now=config.now||Date.now,journal=cashCopyJournal(config.cas,config.planId,config.wallet,now);
 return {async tick(signal:AbortSignal){
  signal.throwIfAborted();let saved=await config.cas.read(config.planId,config.wallet);if(!saved)return{state:'no-permission' as const};
  await journal.pruneQueuedWork();
  const pending=Object.values(saved.value.jobs).filter(j=>!['complete','stopped'].includes(j.state));
  let recoveryFailed=false;
  const signed=pending.filter(j=>['signing','submitted','needs-attention'].includes(j.state));
  for(const job of signed){
   signal.throwIfAborted();
   try{await config.executor.tick(job.id);}catch{signal.throwIfAborted();recoveryFailed=true;}
  }
  // One failed receipt read must not starve later already-signed work. Keep
  // the pass failed for operations reporting and never discover new trades.
  if(recoveryFailed)throw Error('Some copy transactions still need reconciliation.');
  for(const job of pending.filter(j=>!['signing','submitted','needs-attention'].includes(j.state))){signal.throwIfAborted();await config.executor.tick(job.id);}
  saved=await config.cas.read(config.planId,config.wallet);if(!saved)throw Error('Copy permission disappeared.');
  if(Object.values(saved.value.jobs).some(j=>!['complete','stopped'].includes(j.state)))return{state:'recovering' as const};
  if(!config.enabled()||saved.value.revoked||now()>=saved.value.grant.scope.expiresAt)return{state:'paused' as const};
  const scope=saved.value.grant.scope;
  const discovery=cashLeaderDiscovery({scope,store:journal.scanStore,requests:filter=>config.relay.requests(filter),now,
   verify:async candidate=>config.allowsAsset&&!config.allowsAsset(candidate.network,candidate.token)?null:candidate.side==='sell'?readCashLeaderSale(candidate,config.rpc(candidate.network),now):readCashLeaderBuy({...candidate,sourceWallet:await config.leaderSource(candidate.leader)},{evm:config.rpc(candidate.network),solana:config.solana,requests:filter=>config.relay.requests(filter),now}),
   enqueue:async event=>{
    signal.throwIfAborted();if(!config.enabled())throw Error('Cross-chain copying is paused.');
    if(config.allowsAsset&&!config.allowsAsset(event.network,event.token))throw Error('Copy test asset changed.');
    const latest=await config.cas.read(config.planId,config.wallet);if(!latest||latest.value.grant.scope.id!==scope.id||latest.value.revoked)throw Error('Copy permission changed during discovery.');
    const job=await journal.reserve(event);await config.executor.tick(job.id);
   }});
  return discovery.tick(signal);
 }};
}
