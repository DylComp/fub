import {cashCopyOwnerSale} from './cash-copy-owner-sale.js';
import {prepareCashReturnQuote} from './cash-return-quote.js';
import {prepareCashReturnGas} from './cash-return-transaction.js';
import {cashCapturedSaleRetries} from './cash-captured-sale-retries.js';
import {cashCopyDeliveryCandidate} from './cash-copy-delivery-candidate.js';
import {recoverUnsignedCashSale,capturedSaleAnchor} from './cash-copy-unsigned-sale-recovery.js';
import {cashCopyReadiness} from './cash-copy-readiness.js';
import {validateCashCopyScope} from '../src/cash-copy-model.js';
import {cashCopySaleCredit} from './cash-copy-sale-credit.js';
import {reconcileCashCopyReturns} from './cash-copy-return-credit.js';
import canonicalize from 'canonicalize';
import type {cashLeaderRegistry} from './cash-leader-registry.js';
import {recoverCashLeaderSales} from './cash-sale-recovery.js';
import {cashFastFollowup} from './cash-fast-followup.js';
import {cashCopyInventory} from './cash-copy-inventory.js';
import {confirmedCashDeposit} from './cash-receipt.js';
import {drainCashPendingBuys} from './cash-pending-buys.js';
import {drainCashPendingSales} from './cash-pending-sales.js';
import {readCashLeaderSale,readCashLeaderCapturedSale} from './cash-leader-sale.js';
import {cashDeliveryWakeup} from './cash-delivery-wakeup.js';
import {cashLiveDispatch} from './cash-live-dispatch.js';
import type {CashCopyEvent} from '../src/cash-copy-model.js';
import {createPrivateKey,createPublicKey} from 'node:crypto';
import {keccak256} from 'viem';
import {isMint} from '../src/assets.js';
import {CASH_NETWORKS,type CashNetwork} from '../src/cash-route.js';
import type {Rpc} from './funding.js';
import {privyAccessVerifier,privyOwnershipReader,type SignerPolicy} from './privy-owner.js';
import {privyCashOwnershipReader} from './privy-cash-owner.js';
import {privySignOnly} from './privy-sign-only.js';
import {privyEvmSignOnly} from './privy-evm-sign-only.js';
import {cashCopyEnrollment} from './cash-copy-enrollment.js';
import {cashCopyEnrollmentApi} from './cash-copy-enrollment-api.js';
import {cashCopyJournal,type CashCopyCas} from './cash-copy-journal.js';
import type {CashSigningParts} from './cash-copy-signing-parts.js';
import {cashCopyExecutionStores} from './cash-copy-execution-store.js';
import {cashCopySigning} from './cash-copy-signing.js';
import {cashCopyService} from './cash-copy-service.js';
import {cashCopyObserver} from './cash-copy-observer.js';
import {cashLeaderVerifier} from './cash-leader-verifier.js';
import {cashPurchaseService} from './cash-purchase-service.js';
import {cashReturnService} from './cash-return-service.js';
import {cashRelay} from './cash-relay.js';
import {inspectSignedCashDeposit} from './cash-deposit.js';
import {saleHashes} from './cash-return-store.js';
import {validateCashCopyDelivery,type CashCopyDelivery} from './cash-copy-delivery.js';
import type {CashCopyScope} from '../src/cash-copy-model.js';
type Policy=SignerPolicy&{privateKey:string};
export type CashLeaderBinding={profileHandle?:string;sourceWallet:string;wallet:string;networks:CashNetwork[]};
// Private host composition. No browser/executor supplies an observation,
// provider owner, RPC endpoint, signing key, or leader wallet mapping.
export function hostedCashCopy(config:{origin:string;reviewLimits?:import('../src/cash-copy-client.js').CashCopyReviewLimits;appId:string;appSecret:string;saleGasCeilingWei?:string;solanaPolicy:Policy;evmPolicy:Policy;cas:CashCopyCas;parts:CashSigningParts;solana:Rpc;evm:(network:CashNetwork)=>Rpc;ready:()=>boolean;enabled:()=>boolean;allows:(wallet:string)=>boolean;allowsAsset:(network:CashNetwork,token:string)=>boolean;allowsScope:(scope:CashCopyScope)=>boolean;leaders:CashLeaderBinding[];registry?:ReturnType<typeof cashLeaderRegistry>;restoreLeaders?:()=>Promise<void>;monitorReady?:(leader:string,networks:CashNetwork[])=>boolean;shutdown?:AbortSignal;ownerPlans?:(wallet:string,userId:string,after:string|null)=>Promise<import('./cash-copy-journal.js').CashCopyDocument[]>;plans:(after:string|null)=>Promise<{planId:string;wallet:string}[]>;liveVerify?:(event:CashCopyEvent,signal:AbortSignal)=>Promise<CashCopyEvent|null>;fetcher?:typeof fetch}){
 for(const p of [config.solanaPolicy,config.evmPolicy]){
  const key=createPrivateKey({key:Buffer.from(p.privateKey,'base64'),format:'der',type:'pkcs8'});
  if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1'||createPublicKey(key).export({type:'spki',format:'der'}).toString('base64')!==p.publicKey)throw Error('Cash signer key mismatch.');
 }
 const leaders=structuredClone(config.leaders);
 if(leaders.length>100||leaders.some(l=>!isMint(l.sourceWallet)||!/^0x[0-9a-f]{40}$/.test(l.wallet)||!l.networks.length||l.networks.some(n=>!Object.hasOwn(CASH_NETWORKS,n)))||new Set(leaders.map(l=>l.wallet)).size!==leaders.length||new Set(leaders.map(l=>l.sourceWallet)).size!==leaders.length)throw Error('Invalid verified leader registry.');
 const wakeup=cashDeliveryWakeup(),handoffs=new Map<string,number>();
 const enabled=()=>config.ready()&&config.enabled();
 const followups=cashFastFollowup(config.shutdown||new AbortController().signal,()=>enabled()&&!!config.liveVerify);
 const followup=(id:string,wallet:string)=>followups.start(id,signal=>plan(id,wallet,signal).pending());
 const snapshot=()=>config.registry?.snapshot()||leaders;
 const source=async(wallet:string)=>{const l=snapshot().find(l=>l.wallet===wallet);if(!l)throw Error('Leader mapping has not been verified.');return l.sourceWallet;};
 const authenticate=privyAccessVerifier(config.appId),solanaOwnership=privyOwnershipReader({appId:config.appId,appSecret:config.appSecret,policy:config.solanaPolicy,fetcher:config.fetcher}),evmOwnership=privyCashOwnershipReader({appId:config.appId,appSecret:config.appSecret,policy:config.evmPolicy,fetcher:config.fetcher});
 const owner=cashCopyEnrollment({listPlans:config.ownerPlans,origin:config.origin,cas:config.cas,authenticate,solanaOwnership,evmOwnership,solanaPolicy:config.solanaPolicy,evmPolicy:config.evmPolicy,leaderSource:async wallet=>{const l=config.registry?.find(wallet);return l?l.sourceWallet:source(wallet);}});
 const ownerSale=cashCopyOwnerSale({cas:config.cas,parts:config.parts,authorize:owner.authorizeOwnerSale,
  prepare:async j=>{
   if(!config.ready()||!config.allows(j.scope.sourceWallet)||!config.allowsAsset(j.event.network,j.event.token))throw Error('Sale recovery is unavailable.');
   const intent={network:j.event.network,wallet:j.scope.recipient,cashWallet:j.scope.sourceWallet,token:j.event.token,amountRaw:j.amountRaw,slippageBps:j.scope.slippageBps};
   const rpc=config.evm(intent.network);
   const {quote,simulation}=await prepareCashReturnQuote(intent,cashRelay(config.fetcher).quote,rpc);
   const gas=await prepareCashReturnGas(simulation,rpc,j.scope.maxSaleGas[intent.network]!);
   if(config.saleGasCeilingWei&&gas.transactions.reduce((n,t)=>n+BigInt(t.gas)*BigInt(t.maxFeePerGas),BigInt(gas.maxL1FeeWei))>BigInt(config.saleGasCeilingWei))throw Error('Sale exceeds delivered gas.');
   return{id:j.id,wallet:j.scope.sourceWallet,simulation:{...simulation,rawQuote:quote},gas,state:'prepared',signed:null,hashes:null,receipt:null,feeWei:null};
  },recheck:async s=>{
   const service=cashReturnService({store:{} as any,solana:config.solana,evm:config.evm(s.simulation.route.intent.network),evmFor:config.evm,binding:async()=>null,enabled:()=>false,broadcast:async()=>{throw Error('Owner recovery never broadcasts from the signer.');}});
   await service.inspectPrepared(s);
  }});
 const enrollment=cashCopyEnrollmentApi({origin:config.origin,ready:config.ready,enabled,ownerSale,service:{...owner,list:async(...args)=>{const result=await owner.list(...args);return {...result,plans:result.plans.map(p=>({...p,status:{...p.status,monitorReady:!config.monitorReady||config.monitorReady(p.scope.leader,p.scope.networks)}}))};},revoke:async(...args)=>{const result=await owner.revoke(...args);await config.restoreLeaders?.();return result;},status:async(...args)=>{const result=await owner.status(...args);const row=await config.cas.read(args[1],args[2]),s=row?.value.grant.scope;return{...result,monitorReady:!!s&&(!config.monitorReady||config.monitorReady(s.leader,s.networks))};},activate:async(token,scope,proof,ids,signal)=>{
  await config.restoreLeaders?.();
  const leader=config.registry?.find(scope.leader)||snapshot().find(l=>l.wallet===scope.leader);if(!config.allows(scope.sourceWallet)||!config.allowsScope(scope)||!leader||scope.networks.some(n=>!leader.networks.includes(n)))throw Error('Copy plan is outside the verified release scope.');
  if(config.registry){const fresh=await config.registry.resolve(leader.sourceWallet,signal);if(fresh.wallet!==scope.leader||scope.networks.some(n=>!fresh.networks.includes(n)))throw Error('Leader mapping changed.');}
  const result=await owner.activate(token,scope,proof,ids,signal);try{config.registry?.restore(leader,scope.expiresAt);}catch{await config.restoreLeaders?.();}
  return{...result,monitorReady:!config.monitorReady||config.monitorReady(scope.leader,scope.networks)};
 }},readiness:async(token,scope,ids,signal)=>{
  validateCashCopyScope(scope);
  if(scope.origin!==config.origin||!config.allows(scope.sourceWallet)||!config.allowsScope(scope)||ids.solana===ids.evm)throw Error('Copy limits are outside the release scope.');
  const userId=await authenticate(token);
  await Promise.all([solanaOwnership({userId,wallet:scope.sourceWallet,walletId:ids.solana},false,signal),evmOwnership({userId,wallet:scope.recipient,walletId:ids.evm},false,signal)]);
  return cashCopyReadiness(scope,config.solana,enabled(),signal);
 },configuration:async(token,wallet,walletId,leaderSource,signal,leaderHandle)=>{
  const userId=await authenticate(token);await solanaOwnership({userId,wallet,walletId},false,signal);
  const leader=config.registry?await config.registry.resolve(leaderSource,signal,leaderHandle):leaders.find(l=>l.sourceWallet===leaderSource);if(!leader)throw Error('Leader mapping has not been verified.');
  return {enabled:enabled()&&config.allows(wallet),...(config.reviewLimits?{reviewLimits:config.reviewLimits}:{}),leader:{sourceWallet:leader.sourceWallet,wallet:leader.wallet,...(leader.profileHandle?{handle:leader.profileHandle,selectedSource:leaderSource}:{})},networks:leader.networks,solana:{signerId:config.solanaPolicy.signerId,policyId:config.solanaPolicy.policyId},evm:{signerId:config.evmPolicy.signerId,policyId:config.evmPolicy.policyId}};
 }});
 const relay=cashRelay(config.fetcher),solanaProvider=privySignOnly({appId:config.appId,appSecret:config.appSecret,authorizationPrivateKey:config.solanaPolicy.privateKey,fetcher:config.fetcher}),evmProvider=privyEvmSignOnly({appId:config.appId,appSecret:config.appSecret,authorizationPrivateKey:config.evmPolicy.privateKey,fetcher:config.fetcher});
 const verifyCapturedSale=async(job:import('./cash-copy-service.js').CashCopyJob,signal:AbortSignal)=>{
  const d=(await config.cas.read(job.scope.planId,job.scope.sourceWallet))?.value,p=d?capturedSaleAnchor(d,job):null;
  if(!p)return null;
  const r=await readCashLeaderCapturedSale(job.event,config.evm(job.event.network));signal.throwIfAborted();
  if(!r)return null;const event={...r.event,observedAt:p.event.observedAt,confirmation:'captured' as const};
  const fields=(e:CashCopyEvent)=>{const{observedAt,confirmation,...rest}=e;return rest;};
  if(canonicalize(fields(event))!==canonicalize(fields(p.event)))throw Error('Captured leader sale changed.');return event;
 };
 const retryCapturedSales=cashCapturedSaleRetries();
 const chainVerify=cashLeaderVerifier({rpc:config.evm,allowsAsset:config.allowsAsset,live:config.liveVerify,captured:verifyCapturedSale,buy:{solana:config.solana,requests:relay.requests,sourceWallet:source}});
 const verifyInventoryFunding=async(job:import('./cash-copy-service.js').CashCopyJob,signal:AbortSignal)=>{
  {
   const d=(await config.cas.read(job.scope.planId,job.scope.sourceWallet))?.value;if(!d)throw Error('Copy inventory missing.');
   const stores=cashCopyExecutionStores(config.cas,job.scope.planId,job.scope.sourceWallet);
   for(const buy of Object.values(d.jobs).filter(j=>j.event.side==='buy'&&j.provisionalCredit&&j.state!=='complete'&&(job.event.side==='buy'||j.event.network===job.event.network&&j.event.token===job.event.token))){
    const p=await stores.purchases.get(buy.id,job.scope.sourceWallet),r=buy.provisionalCredit!;
    if(buy.leaderInvalidatedAt||buy.state==='needs-attention'||!p?.signed||await confirmedCashDeposit(p.review,p.signed,config.solana)!=='confirmed')throw Error('Copy funding needs reconciliation.');
    const block=await config.evm(buy.event.network)('eth_getBlockByNumber',[r.blockNumber,false]) as any;
    if(block?.hash?.toLowerCase()!==r.blockHash)throw Error('Copy inventory block changed.');signal.throwIfAborted();
   }
   for(const sale of Object.values(d.jobs).filter(j=>j.provisionalDebit&&j.state!=='complete')){
    const p=await stores.sales.get(sale.id,job.scope.sourceWallet);
    if(sale.leaderInvalidatedAt||sale.state==='needs-attention'||!p)throw Error('Returned cash needs reconciliation.');
    const proof=await cashCopySaleCredit(p,config.solana,config.evm(sale.event.network),config.fetcher);
    if(!proof||canonicalize(proof)!==canonicalize(sale.provisionalDebit))throw Error('Returned cash evidence changed.');signal.throwIfAborted();
   }
  }
 };
 const verifyLeader:typeof chainVerify=async(job,signal)=>{if(config.monitorReady&&!config.monitorReady(job.scope.leader,job.scope.networks))throw Error('Live leader feed is reconnecting.');if(!config.allowsScope(job.scope))throw Error('Copy limits are outside the supported release scope.');await chainVerify(job,signal);await verifyInventoryFunding(job,signal);};
 function plan(planId:string,wallet:string,signal:AbortSignal){
  const journal=cashCopyJournal(config.cas,planId,wallet),stores=cashCopyExecutionStores(config.cas,planId,wallet),active=()=>enabled()&&config.allows(wallet)&&!signal.aborted;
  const binding=async(given:string,network:CashNetwork)=>{const d=(await config.cas.read(planId,wallet))?.value;if(!d?.enrollment||given!==wallet||d.revoked||!d.grant.scope.networks.includes(network))return null;const s=d.grant.scope;return{sourceWallet:wallet,recipient:s.recipient,network,verifiedAt:d.grant.acceptedAt,expiresAt:s.expiresAt,accountType:'eoa' as const,tradingAuthorized:false as const};};
  // The execution stores are bound before these callbacks. This only marks
  // bytes ready for delivery; it is NOT a network submission or final receipt.
  const solana:Rpc=async(method,params)=>{signal.throwIfAborted();if(method!=='sendTransaction')return config.solana(method,params);if(!active())throw Error('Copy delivery is paused.');const d=(await config.cas.read(planId,wallet))?.value;if(!d||d.revoked)throw Error('Copy permission missing.');for(const j of Object.values(d.jobs)){const p=await stores.purchases.get(j.id,wallet);if(p&&p.signed&&p.signed===params[0]&&await journal.authorized(j))return inspectSignedCashDeposit(p.review,p.signed);}throw Error('No saved cash deposit.');};
  const purchases=cashPurchaseService({store:stores.purchases,solana,evm:config.evm,binding,enabled:active,fetcher:config.fetcher});
  const returns=cashReturnService({store:stores.sales,solana:config.solana,evm:config.evm('base'),evmFor:config.evm,binding,enabled:active,fetcher:config.fetcher,broadcast:async(signed,network)=>{
   if(!active())throw Error('Copy delivery is paused.');const d=(await config.cas.read(planId,wallet))?.value;if(!d||d.revoked)throw Error('Copy permission missing.');
   for(const j of Object.values(d.jobs)){const p=await stores.sales.get(j.id,wallet);if(p?.signed?.includes(signed)&&p.simulation.route.intent.network===network&&await journal.authorized(j)){await saleHashes(p,p.signed);return keccak256(signed as `0x${string}`);}}throw Error('No saved cash return.');
  }});
  const signing=cashCopySigning({journal,saleGasCeilingWei:config.saleGasCeilingWei,parts:config.parts,enabled:active,verifyLeader,resolveSolana:(j,s)=>owner.resolve(j,'solana',s),resolveEvm:(j,s)=>owner.resolve(j,'evm',s),solana:config.solana,evm:config.evm,solanaProvider,evmProvider});
  const executor=cashCopyService({journal,purchases,returns,enabled:active,authorized:journal.authorized,recoverSigned:signing.recover,recoverUnsignedSale:id=>recoverUnsignedCashSale({cas:config.cas,parts:config.parts,planId,wallet,id,enabled:active,verify:async(event,s)=>{const job=await journal.get(id);if(job&&event.confirmation==='captured'&&Date.now()-event.blockTime<=120000)return verifyCapturedSale(job,s);const result=await readCashLeaderSale(event,config.evm(event.network));s.throwIfAborted();return result?.tradeVerified?{...result.event,confirmation:'finalized' as const}:null;}},signal),signer:{purchase:async j=>{const v=await signing.sign(j.id,signal);if(typeof v!=='string')throw Error();return v;},sale:async j=>{const v=await signing.sign(j.id,signal);if(!Array.isArray(v))throw Error();return v;}}});
  const pending=async()=>{
   signal.throwIfAborted();
   const d=(await config.cas.read(planId,wallet))?.value;if(!d)return false;
   await reconcileCashCopyReturns(d,{read:stores.sales.get,verify:sale=>cashCopySaleCredit(sale,config.solana,config.evm(sale.simulation.route.intent.network),config.fetcher),record:journal.debitReturned},signal);
   if(!active()||!config.liveVerify||d.revoked)return false;
   // A captured sale can already be reserved when quote preparation fails.
   // Retry that same job before unrelated receipt reads, without reserving
   // another sale or replacing any claimed signing part.
   const preparing=await retryCapturedSales({document:d,parts:config.parts,enabled:active,execute:async id=>{await executor.tick(id);wakeup.notify();}},signal);
   for(const j of Object.values(d.jobs).filter(j=>j.state==='submitted'&&j.event.side==='buy'&&!j.provisionalCredit&&!j.leaderInvalidatedAt)){
    const p=await stores.purchases.get(j.id,wallet);if(!p)continue;
    const receipt=await cashCopyInventory(p,config.solana,config.evm(j.event.network),config.fetcher);signal.throwIfAborted();
    if(receipt)await journal.creditSpendable(j,p,receipt);
   }
   await drainCashPendingSales({cas:config.cas,planId,wallet,enabled:active,verify:async(event,s)=>{
    const rpc=config.evm(event.network),input={network:event.network,leader:event.leader,token:event.token,transaction:event.transaction};
    const age=Date.now()-event.blockTime;
    const captured=event.confirmation==='provisional'&&age<=120000;
    const result=captured?await readCashLeaderCapturedSale(input,rpc):await readCashLeaderSale(input,rpc);
    s.throwIfAborted();return result?captured?{...result.event,observedAt:event.observedAt,confirmation:'captured' as const}:result.event:null;
   },execute:async id=>{await executor.tick(id);wakeup.notify();}},signal);
   await drainCashPendingBuys({cas:config.cas,planId,wallet,enabled:active,allowsAsset:e=>config.allowsAsset(e.network,e.token),verify:config.liveVerify,execute:async id=>{await executor.tick(id);wakeup.notify();}},signal);
   const retryDocument=(await config.cas.read(planId,wallet))?.value;
   const retrying=retryDocument?await retryCapturedSales({document:retryDocument,parts:config.parts,enabled:active,execute:async id=>{await executor.tick(id);wakeup.notify();}},signal):false;
   const current=(await config.cas.read(planId,wallet))?.value;
   return !!current&&!current.revoked&&(preparing||retrying||Object.values(current.pendingBuys||{}).some(p=>p.state==='waiting')||Object.values(current.pendingSales||{}).some(p=>p.state==='waiting')||Object.values(current.jobs).some(j=>j.state==='submitted'&&(j.event.side==='buy'?!j.provisionalCredit:!j.provisionalDebit))); 
  };
  const recoverSales=()=>recoverCashLeaderSales({cas:config.cas,planId,wallet,enabled:active,rpc:config.evm,allowsAsset:config.allowsAsset,verify:input=>readCashLeaderSale(input,config.evm(input.network),Date.now,{requireFinalizedEvidence:true}),enqueue:async event=>{const job=await journal.reserve(event);await executor.tick(job.id);wakeup.notify();}},signal);
  return{journal,stores,executor,pending,recoverSales,observer:cashCopyObserver({cas:config.cas,planId,wallet,enabled:active,executor,rpc:config.evm,solana:config.solana,relay,leaderSource:source,allowsAsset:config.allowsAsset})};
 }
 const live=cashLiveDispatch({pending:async(planId,wallet,_signal)=>{followup(planId,wallet);},cas:config.cas,plans:config.plans,enabled:()=>enabled()&&!!config.liveVerify,allows:config.allows,allowsAsset:e=>config.allowsAsset(e.network,e.token),verify:(event,signal)=>config.liveVerify?config.liveVerify(event,signal):Promise.resolve(null),execute:async(planId,wallet,id,signal)=>{try{await plan(planId,wallet,signal).executor.tick(id);}finally{wakeup.notify();followup(planId,wallet);}}});
 let cursor:string|null=null;
 const api={enrollment,live,leaders:snapshot,restoreLeaders:config.restoreLeaders||(()=>Promise.resolve()),runtime:()=>({executionEnabled:enabled(),liveEnabled:!!config.liveVerify,delivery:wakeup.snapshot(),followups:followups.snapshot()}),async tick(signal:AbortSignal){
  if(!config.ready())throw Error('Private storage unavailable.');const rows=await config.plans(cursor);if(!rows.length){cursor=null;return{checked:0,refused:0};}let checked=0,refused=0;
  for(const row of rows){signal.throwIfAborted();try{const p=plan(row.planId,row.wallet,signal);let failed=false;for(const task of [()=>p.recoverSales(),()=>p.observer.tick(signal),()=>p.pending()]){signal.throwIfAborted();try{await task();}catch{failed=true;}}wakeup.notify();if(failed)refused++;else checked++;}catch{refused++;}cursor=row.planId;}return{checked,refused};
 },async delivery(signal:AbortSignal):Promise<CashCopyDelivery|null>{
  if(!enabled())return null;let deliveryCursor:string|null=null;for(let page=0;page<25;page++){const rows=await config.plans(deliveryCursor);if(!rows.length){deliveryCursor=null;return null;}
  for(const row of rows){deliveryCursor=row.planId;signal.throwIfAborted();if(!config.allows(row.wallet))continue;
   const d=(await config.cas.read(row.planId,row.wallet))?.value;if(!d||d.revoked||Date.now()>=d.grant.scope.expiresAt)continue;
   const {journal,stores}=plan(row.planId,row.wallet,signal);
   for(const j of Object.values(d.jobs)){
    if((handoffs.get(j.id)||0)>Date.now()||!['signing','submitted','needs-attention'].includes(j.state)||!config.allowsScope(j.scope)||!config.allowsAsset(j.event.network,j.event.token)||!await journal.authorized(j))continue;
    const delivery=await cashCopyDeliveryCandidate(j,stores);if(!delivery)continue;
    await validateCashCopyDelivery(delivery);
    // resolve already checks ownership; check it again after funding proof,
    // not twice consecutively before checking whether bytes need delivery.
    const access=await owner.resolve(j,j.event.side==='buy'?'solana':'evm',signal);
    await verifyInventoryFunding(j,signal);await access.check(signal);signal.throwIfAborted();await validateCashCopyDelivery(delivery);if(!enabled()||config.monitorReady&&!config.monitorReady(j.scope.leader,j.scope.networks)||!await journal.authorized(j))return null;for(const [id,until] of handoffs)if(until<=Date.now())handoffs.delete(id);handoffs.set(j.id,Date.now()+2000);return delivery;
   }
  }}return null;
 }};
 return{...api,waitDelivery:(signal:AbortSignal)=>wakeup.next(()=>api.delivery(signal),signal)};
}
