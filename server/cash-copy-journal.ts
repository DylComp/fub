import {CASH_SIGNING_FAILURE_REASONS} from './cash-signing-failure.js';
import type {CashSaleCredit} from './cash-copy-sale-credit.js';
import {neon} from '@neondatabase/serverless';
import canonicalize from 'canonicalize';
import {randomUUID} from 'node:crypto';
import {CASH_MINT,CASH_NETWORKS,RELAY_SOLANA} from '../src/cash-route.js';
import {compareCashCopyEvents,cashCopyRaw,proportionalCashSale,validateCashCopyEvent,type CashCopyScope,type CashCopyEvent} from '../src/cash-copy-model.js';
import {verifyCashCopyPermission} from './cash-copy-permission.js';
import type {CashCopyJob,CashCopyJournal} from './cash-copy-service.js';
import type {CashPurchase} from './cash-purchase-store.js';
import type {CashReceipt} from '../src/cash-recovery.js';
import {saleHashes,type CashSale} from './cash-return-store.js';
import {inspectSignedCashDeposit} from './cash-deposit.js';
import type {CashLeaderScan,CashLeaderScanStore} from './cash-leader-discovery.js';
import type {OwnerBinding} from './privy-owner.js';

type Grant=Awaited<ReturnType<typeof verifyCashCopyPermission>>;
export type CashCopyEnrollment={solana:OwnerBinding;evm:OwnerBinding;solanaPolicyDigest:string;evmPolicyDigest:string;leaderSource:string};
export type CashCopyDocument={grant:Grant;revoked:boolean;revokedAt?:number;jobs:Record<string,CashCopyJob&{day:string;signed:string|string[]|null;leaderInvalidatedAt?:number;provisionalDebit?:CashSaleCredit;provisionalCredit?:CashReceipt&{blockHash:string;blockNumber:string}}>;positions:Record<string,string>;spent:Record<string,string>;pendingBuys?:Record<string,{event:CashCopyEvent;permissionId:string;waitingOn:string[];state:'waiting'|'consumed'|'cancelled';capturedAt:number;reason?:'expired'|'invalidated'|'sale'|'permission'|'budget'}>;pendingSales?:Record<string,{event:CashCopyEvent;permissionId:string;waitingOn:string[];state:'waiting'|'consumed'|'cancelled';capturedAt:number}>;saleRecovery?:Record<string,{permissionId:string;through:string}>;scan?:CashLeaderScan;enrollment?:CashCopyEnrollment};
export interface CashCopyCas {
 read(planId:string,wallet:string):Promise<{revision:number;value:CashCopyDocument}|null>;
 write(planId:string,wallet:string,revision:number|null,value:CashCopyDocument,admission?:boolean):Promise<boolean>;
}
export function cashCopyCas(url:string):CashCopyCas{
 return databaseCashCopyCas(url,'fub_cash_copy_journals');
}
// Only private service composition may use this store. Its database role must
// pass the private isolation audit with cashCopies enabled before any signing.
export function privateCashCopyCas(url:string,capacity?:number):CashCopyCas{
 return databaseCashCopyCas(url,'signer_cash_journals',capacity);
}
function databaseCashCopyCas(url:string,table:'fub_cash_copy_journals'|'signer_cash_journals',capacity?:number):CashCopyCas{
 if(capacity!==undefined&&(!Number.isSafeInteger(capacity)||capacity<1||capacity>100))throw Error('Invalid public copy capacity.');
 const query=()=>neon(url,{fetchOptions:{signal:AbortSignal.timeout(10000)}});
 return {
  async read(id,wallet){const sql=query(),rows=await sql.query(`SELECT revision,journal FROM ${table} WHERE plan_id=$1::uuid AND wallet=$2`,[id,wallet]);
   if(!rows[0])return null;const revision=Number(rows[0].revision);if(!Number.isSafeInteger(revision))throw Error('Copy journal revision overflow.');return {revision,value:rows[0].journal as CashCopyDocument};},
  async write(id,wallet,revision,value,admission=false){const sql=query(),json=JSON.stringify(value);try{
   // Serializable admission makes concurrent enrollments compete for the same
   // durable capacity, instead of accepting a browser-side count. Existing
   // submitted work remains counted even when its permission has expired.
   if(capacity!==undefined&&admission){
    const occupied=`(journal->>'revoked'='false' AND (journal->'grant'->'scope'->>'expiresAt')::bigint>$4) OR jsonb_path_exists(journal,'$.jobs.* ? (@.state != "complete" && @.state != "stopped")')`;
    const count=`(SELECT count(*) FROM ${table} WHERE plan_id<>$1::uuid AND (${occupied}))<$5`;
    const values=[id,wallet,json,Date.now(),capacity];
    const query=revision===null?`INSERT INTO ${table}(plan_id,wallet,journal) SELECT $1::uuid,$2,$3::jsonb WHERE ${count} ON CONFLICT DO NOTHING RETURNING plan_id`:
      `UPDATE ${table} SET journal=$3::jsonb,revision=revision+1,updated_at=clock_timestamp() WHERE plan_id=$1::uuid AND wallet=$2 AND revision=$6 AND ${count} RETURNING plan_id`;
    try{const [rows]=await sql.transaction([sql.query(query,revision===null?values:[...values,revision])],{isolationLevel:'Serializable'});return rows.length===1;}
    catch(error){if((error as any)?.code==='40001')throw Error('Copy admission is busy. Retry the saved permission.');throw error;}
   }
   const rows=revision===null?await sql.query(`INSERT INTO ${table}(plan_id,wallet,journal) VALUES($1::uuid,$2,$3::jsonb) ON CONFLICT DO NOTHING RETURNING plan_id`,[id,wallet,json]):
    await sql.query(`UPDATE ${table} SET journal=$3::jsonb,revision=revision+1,updated_at=clock_timestamp() WHERE plan_id=$1::uuid AND wallet=$2 AND revision=$4 RETURNING plan_id`,[id,wallet,json,revision]);
   return rows.length===1;}catch(error){if(table==='signer_cash_journals'&&(error as any)?.code==='23505'&&['signer_cash_wallet_active','signer_cash_evm_active'].includes((error as any)?.constraint))return false;throw error;}}
 };
}
const same=(a:unknown,b:unknown)=>canonicalize(a)===canonicalize(b);
const key=(event:CashCopyEvent)=>`${event.network}:${event.token}`;
const eventKey=(event:CashCopyEvent)=>`${event.network}:${event.transaction}`;
const sourceKey=(e:CashCopyEvent)=>e.sourceOrder?`${e.sourceOrder.wallet}:${e.sourceOrder.orderId}`:null;
const open=(j:CashCopyJob)=>!['complete','stopped'].includes(j.state);
// Timestamp equality is not transaction ordering. Same-block observations need
// both canonical indices before a sale may consume inventory from that buy.
const precedes=(a:CashCopyEvent,b:CashCopyEvent)=>a.network===b.network&&
 (a.blockNumber!==b.blockNumber||a.transactionIndex!==undefined&&b.transactionIndex!==undefined)&&
 compareCashCopyEvents(a,b)<0;
const returnedSale=(j:CashCopyDocument['jobs'][string])=>j.event.side==='sell'&&j.state==='submitted'&&!!j.provisionalDebit&&!j.leaderInvalidatedAt;
const spendableBuy=(j:CashCopyDocument['jobs'][string])=>j.event.side==='buy'&&j.state==='submitted'&&!!j.provisionalCredit&&!j.leaderInvalidatedAt;
// Expired queue entries are history, not executable work. This read-side
// cleanup also unblocks renewal if the host was offline past grant expiry.
function pruneDeferredBuys(d:CashCopyDocument,at:number){
 let count=0;
 for(const p of Object.values(d.pendingBuys||{}))if(p.state==='waiting'){
  let reason:'permission'|'expired'|undefined;
  if(d.revoked||p.permissionId!==d.grant.scope.id||at>=d.grant.scope.expiresAt)reason='permission';
  else try{validateCashCopyEvent(p.event,d.grant.scope,at);}catch{reason='expired';}
  if(reason){p.state='cancelled';p.reason=reason;count++;}
 }
 return count;
}
// Only unscheduled sale signals expire here. Jobs, signed bytes, inventory and
// reserved spending must survive permission expiry for independent recovery.
function pruneDeferredSales(d:CashCopyDocument,at:number){
 let count=0;
 for(const p of Object.values(d.pendingSales||{}))if(p.state==='waiting'&&
  (d.revoked||p.permissionId!==d.grant.scope.id||at>=d.grant.scope.expiresAt||at-p.event.blockTime>1800000)){
  p.state='cancelled';count++;
 }
 return count;
}
// Factory is private worker code. Observations must be independently verified
// against finalized swaps before reserve() is called. An API payload is not an
// observation, and ownership alone is not delegated signing permission.
export function cashCopyJournal(cas:CashCopyCas,planId:string,wallet:string,now=Date.now){
 async function change<T>(fn:(d:CashCopyDocument)=>T,admission=false):Promise<T>{
  for(let attempt=0;attempt<12;attempt++){
   const saved=await cas.read(planId,wallet);if(!saved)throw Error('Copy permission missing.');
   const d=structuredClone(saved.value),result=fn(d);
   if(same(d,saved.value)||await cas.write(planId,wallet,saved.revision,d,admission))return result;
  }
  throw Error('Copy plan is busy. Retry the same event.');
 }
 const getJob=(d:CashCopyDocument,id:string,expected?:CashCopyJob)=>{const job=d.jobs[id];if(!job)throw Error('Copy job missing.');if(expected&&(job.signingAttempt??0)!==(expected.signingAttempt??0))throw Error('Copy signing attempt changed.');return job;};
 const assertReview=(job:CashCopyJob,review:CashPurchase|CashSale)=>{
  if(review.id!==job.id||review.wallet!==wallet)throw Error('Copy review owner changed.');
  const q='review' in review?review.review.intent:review.simulation.route.intent,s=job.scope;
  if(q.network!==job.event.network||q.token!==job.event.token||q.amountRaw!==job.amountRaw||q.slippageBps!==s.slippageBps)throw Error('Copy review changed.');
  if('review' in review){const buy=review.review.intent;if(cashCopyRaw(review.review.maxFeeLamports)+cashCopyRaw(review.review.maxRentLamports)>cashCopyRaw(s.maxSourceFeeLamports))throw Error('Copy source fee cap exceeded.');if(job.event.side!=='buy'||buy.sourceWallet!==wallet||buy.recipient!==s.recipient||buy.gasTopupUsdcRaw!==s.gasTopupUsdcRaw)throw Error('Copy purchase recipient changed.');}
  else if(job.event.side!=='sell'||review.simulation.route.intent.cashWallet!==wallet||review.simulation.route.intent.wallet!==s.recipient||review.gas.maxCostWei!==s.maxSaleGas[job.event.network])throw Error('Copy return recipient changed.');
 };
 const api:CashCopyJournal={
  async get(id){const saved=await cas.read(planId,wallet);return saved?.value.jobs[id]?structuredClone(saved.value.jobs[id]):null;},
  async prepared(job,review){assertReview(job,review);return change(d=>{const j=getJob(d,job.id,job);if(j.state==='reserved'){if(review.state!=='prepared'||!same(j.scope,job.scope)||!same(j.event,job.event))throw Error('Copy preparation changed.');if('review' in review)j.purchase=review;else j.sale=review;j.state='prepared';}else if(!same(j.purchase||j.sale,review))throw Error('Copy review already exists.');return structuredClone(j);});},
  async claimSigning(job){return change(d=>{const j=getJob(d,job.id,job);if(j.leaderInvalidatedAt||d.revoked||d.grant.scope.id!==j.scope.id||now()>=j.scope.expiresAt||Object.values(d.jobs).some(b=>(b.provisionalCredit||b.provisionalDebit)&&(b.leaderInvalidatedAt||b.state==='needs-attention'))||j.state!=='prepared'||!same(j.purchase||j.sale,job.purchase||job.sale))return false;j.state='signing';return true;});},
  async recordSigned(job,signed){if(job.event.side==='buy'){if(typeof signed!=='string'||!job.purchase)throw Error('Invalid copied purchase.');inspectSignedCashDeposit(job.purchase.review,signed);}else{if(!Array.isArray(signed)||!job.sale)throw Error('Invalid copied sale.');await saleHashes(job.sale,signed);}
   await change(d=>{const j=getJob(d,job.id,job);if(!['signing','needs-attention'].includes(j.state)||!same(j.scope,job.scope)||!same(j.event,job.event)||!same(j.purchase||j.sale,job.purchase||job.sale)||j.signed&&!same(j.signed,signed))throw Error('Copy signature changed.');j.signed=signed;j.state='signing';});},
  async signatures(id){return (await cas.read(planId,wallet))?.value.jobs[id]?.signed||null;},
  async submitted(job){await change(d=>{const j=getJob(d,job.id,job);if(!j.signed||!['signing','submitted'].includes(j.state))throw Error('Copy submission changed.');j.state='submitted';});},
  async settle(job,result){assertReview(job,result);await change(d=>{
   const j=getJob(d,job.id,job);if(j.state==='complete')return;
   if(!['signing','submitted','needs-attention'].includes(j.state))throw Error('Copy settlement has no submission.');
   // Receipt evidence comes from the checked purchase/return services, not
   // Relay's success label. Uncertain attempts retain budget and inventory.
   if(result.state==='expired'&&'review' in result&&!result.signed&&!result.signature){const proof=(result.review as typeof result.review&{unlandedSubmission?:{signed?:unknown;evidence?:unknown;checkedAt?:unknown}}).unlandedSubmission;if(j.signed&&(!proof||proof.signed!==j.signed||proof.evidence!=='expired-blockhash-and-finalized-source-history'||!Number.isSafeInteger(proof.checkedAt)))throw Error('Signed copy requires finalized nonlanding proof.');j.purchase=result;j.state='stopped';return;}
   if(!['complete','refunded','reverted'].includes(result.state)){if(result.state==='needs-attention')j.state='needs-attention';return;}
   if(!result.signed)throw Error('Copy settlement has no signature.');
   const receipt=result.receipt,s=j.scope,network=j.event.network;
   if(result.state==='complete'){
    const buy=j.event.side==='buy';
    if(!receipt||!receipt.finalized||!receipt.successful||cashCopyRaw(receipt.receivedRaw)<=0n||receipt.requestId!==('review' in result?result.review.quote.requestId:result.simulation.route.requestId)||receipt.chainId!==(buy?CASH_NETWORKS[network].chainId:RELAY_SOLANA)||receipt.recipient!==(buy?s.recipient:wallet)||receipt.currency!==(buy?j.event.token:CASH_MINT))throw Error('Copy settlement receipt changed.');
    const pos=key(j.event),current=cashCopyRaw(d.positions[pos]||'0');
    if(buy){if(j.provisionalCredit){if(j.provisionalCredit.transaction!==receipt.transaction||j.provisionalCredit.receivedRaw!==receipt.receivedRaw){j.state='needs-attention';j.purchase=result as CashPurchase;return;}}else d.positions[pos]=String(current+cashCopyRaw(receipt.receivedRaw));}
    else{if(j.provisionalDebit){if(!same(j.provisionalDebit.cash,receipt)){j.state='needs-attention';j.sale=result as CashSale;return;}}else{if(current<cashCopyRaw(j.amountRaw))throw Error('Copy inventory underflow.');d.positions[pos]=String(current-cashCopyRaw(j.amountRaw));}}
    j.state='complete';
   }else if(j.provisionalCredit||j.provisionalDebit){j.state='needs-attention';
   }else if(j.event.side==='sell'&&result.state==='refunded'){
    // A source-chain stablecoin refund is not the original token position.
    // Keep it reserved for explicit reconciliation instead of reselling it.
    j.state='needs-attention';
   }else j.state='stopped';
   if('review' in result)j.purchase=result;else j.sale=result;
  });},
  async signingFailed(job,code,stage,reason){await change(d=>{const j=getJob(d,job.id,job);if(j.state!=='signing'||j.signed)return;j.signingFailure={at:now(),code,...(stage?{stage}:{}),...(reason&&(CASH_SIGNING_FAILURE_REASONS as readonly string[]).includes(reason)?{reason}:{})};});},
  async stop(job,state){await change(d=>{const j=getJob(d,job.id,job);if(j.state==='complete')return;if(state==='stopped'&&(j.signed||['signing','submitted','needs-attention'].includes(j.state)))throw Error('An uncertain copy trade cannot release its reservation.');j.state=state;});}
 };
 const scanStore:CashLeaderScanStore={read:async()=>structuredClone((await cas.read(planId,wallet))?.value.scan||null),save:async(expected,next)=>change(d=>{if(d.revoked||next.permissionId!==d.grant.scope.id||!same(d.scan||null,expected))return false;d.scan=structuredClone(next);return true;})};
 return {...api,scanStore,
  async pruneQueuedBuys(){return change(d=>pruneDeferredBuys(d,now()));},
  async pruneQueuedWork(){return change(d=>{const at=now();return pruneDeferredBuys(d,at)+pruneDeferredSales(d,at);});},
  async grant(scope:CashCopyScope,proof:{solana:string;evm:string},enrollment?:CashCopyEnrollment){
   if(scope.planId!==planId||scope.sourceWallet!==wallet)throw Error('Copy grant owner changed.');
   const grant=await verifyCashCopyPermission(scope,proof,now());
   const saved=await cas.read(planId,wallet);
   if(!saved){if(await cas.write(planId,wallet,null,{grant,revoked:false,jobs:{},positions:{},spent:{},...(enrollment?{enrollment:structuredClone(enrollment)}:{})},true))return;}
   await change(d=>{const at=now();pruneDeferredBuys(d,at);pruneDeferredSales(d,at);if(d.grant.scope.id===scope.id){if(!same(d.grant.scope,scope)||!same(d.enrollment||null,enrollment||null)||d.revoked)throw Error('Copy permission replay rejected.');return;}
    if(scope.issuedAt<=(d.revokedAt||0)||scope.planVersion<=d.grant.scope.planVersion||(Object.values(d.jobs).some(open)||Object.values(d.pendingSales||{}).some(p=>p.state==='waiting')||Object.values(d.pendingBuys||{}).some(p=>p.state==='waiting'))||Object.entries(d.positions).some(([k,v])=>cashCopyRaw(v)>0n&&!scope.networks.some(n=>k.startsWith(n+':')))||d.grant.scope.recipient!==scope.recipient||d.grant.scope.leader!==scope.leader)throw Error('Resolve existing copy positions before changing permission.');
    d.grant=grant;d.revoked=false;d.enrollment=enrollment?structuredClone(enrollment):undefined;delete d.scan;},true);
  },
  // An orphaned leader signal cannot undo an already-signed follower trade.
  // Preserve its budget, bytes and recovery; never queue a compensating sale.
  async invalidateLeader(transaction:string,blockHash:string,network?:CashCopyEvent['network']){
   if(!/^0x[0-9a-f]{64}$/.test(transaction)||!/^0x[0-9a-f]{64}$/.test(blockHash))throw Error('Invalid removed leader event.');
   return change(d=>{let count=0;for(const j of Object.values(d.jobs)){if(network&&j.event.network!==network||!['provisional','captured'].includes(j.event.confirmation||'')||j.event.transaction!==transaction||j.event.blockHash!==blockHash||j.leaderInvalidatedAt)continue;
    j.leaderInvalidatedAt=now();count++;if(['reserved','prepared'].includes(j.state)&&!j.signed)j.state='stopped';else if(j.state!=='complete'&&j.state!=='stopped')j.state='needs-attention';
   }for(const p of Object.values(d.pendingBuys||{})){if(p.state==='waiting'&&p.event.transaction===transaction&&p.event.blockHash===blockHash&&(!network||p.event.network===network)){p.state='cancelled';p.reason='invalidated';count++;}}for(const p of Object.values(d.pendingSales||{})){if(p.state==='waiting'&&p.event.transaction===transaction&&p.event.blockHash===blockHash&&(!network||p.event.network===network)){p.state='cancelled';count++;}}return count;});
  },
  async revoke(){await change(d=>{d.revoked=true;for(const p of Object.values(d.pendingBuys||{}))if(p.state==='waiting'){p.state='cancelled';p.reason='permission';}for(const p of Object.values(d.pendingSales||{}))if(p.state==='waiting')p.state='cancelled';d.revokedAt=Math.max(d.revokedAt||0,now());});},
  async authorized(job:CashCopyJob){const d=(await cas.read(planId,wallet))?.value;return !!d&&!!d.jobs[job.id]&&(d.jobs[job.id].signingAttempt??0)===(job.signingAttempt??0)&&same(d.jobs[job.id].event,job.event)&&d.jobs[job.id].amountRaw===job.amountRaw&&!d.jobs[job.id].leaderInvalidatedAt&&!(Object.values(d.jobs).some(b=>(b.provisionalCredit||b.provisionalDebit)&&(b.leaderInvalidatedAt||b.state==='needs-attention')))&&!d.revoked&&d.grant.scope.id===job.scope.id&&same(d.grant.scope,job.scope)&&now()<job.scope.expiresAt;},
  async creditSpendable(job:CashCopyJob,purchase:CashPurchase,receipt:CashReceipt&{blockHash?:string;blockNumber?:string}){
   assertReview(job,purchase);return change(d=>{const j=getJob(d,job.id,job);if(j.provisionalCredit){if(!same(j.provisionalCredit,receipt))throw Error('Spendable credit changed.');return;}
    if(j.event.side!=='buy'||j.state!=='submitted'||j.leaderInvalidatedAt||!j.signed||!purchase.signed||!same(j.signed,purchase.signed)||receipt.finalized!==false||!receipt.successful||!/^0x[0-9a-f]{64}$/.test(receipt.transaction)||cashCopyRaw(receipt.receivedRaw)<=0n||!/^0x[0-9a-f]{64}$/.test(receipt.blockHash||'')||!/^0x[0-9a-f]+$/.test(receipt.blockNumber||'')||receipt.requestId!==purchase.review.quote.requestId||receipt.chainId!==CASH_NETWORKS[j.event.network].chainId||receipt.recipient!==j.scope.recipient||receipt.currency!==j.event.token||cashCopyRaw(receipt.receivedRaw)<cashCopyRaw(purchase.review.quote.minimumRaw))throw Error('Invalid spendable copy receipt.');
    j.provisionalCredit=structuredClone(receipt) as NonNullable<typeof j.provisionalCredit>;d.positions[key(j.event)]=String(cashCopyRaw(d.positions[key(j.event)]||'0')+cashCopyRaw(receipt.receivedRaw));
   });
  },
  async debitReturned(job:CashCopyJob,sale:CashSale,proof:CashSaleCredit){assertReview(job,sale);await change(d=>{
   const j=getJob(d,job.id,job),r=proof.cash;
   if(j.provisionalDebit){if(!same(j.provisionalDebit,proof))throw Error('Returned cash evidence changed.');return;}
   if(j.state!=='submitted'||j.event.side!=='sell'||j.leaderInvalidatedAt||!sale.signed||!sale.hashes||!same(j.sale?.simulation,sale.simulation)||proof.sourceTransaction!==sale.hashes.at(-1)||!/^0x[0-9a-f]{64}$/.test(proof.sourceBlockHash)||!/^0x(0|[1-9a-f][0-9a-f]*)$/.test(proof.sourceBlockNumber)||proof.debitRaw!==j.amountRaw||r.requestId!==sale.simulation.route.requestId||!r.finalized||!r.successful||r.chainId!==RELAY_SOLANA||r.recipient!==wallet||r.currency!==CASH_MINT||cashCopyRaw(r.receivedRaw)<cashCopyRaw(sale.simulation.route.minimumRaw))throw Error('Invalid returned cash evidence.');
   const pos=key(j.event),current=cashCopyRaw(d.positions[pos]||'0');if(current<cashCopyRaw(j.amountRaw))throw Error('Copy inventory underflow.');
   d.positions[pos]=String(current-cashCopyRaw(j.amountRaw));j.provisionalDebit=structuredClone(proof);
  });},
  async queueBuy(event:CashCopyEvent){return change(d=>{
   const at=now();pruneDeferredBuys(d,at);pruneDeferredSales(d,at);
   validateCashCopyEvent(event,d.grant.scope,now());
   if(d.revoked||event.side!=='buy'||event.confirmation!=='provisional'||!event.sourceOrder||event.sourceOrder.wallet!==d.enrollment?.leaderSource)throw Error('Buy queue is not authorized.');
   if(Object.values(d.jobs).some(j=>eventKey(j.event)===eventKey(event)||sourceKey(j.event)===sourceKey(event)))return false;
   const prior=Object.values(d.pendingBuys||{}).find(p=>eventKey(p.event)===eventKey(event)||sourceKey(p.event)===sourceKey(event));
   if(prior){if(!same({...prior.event,observedAt:0},{...event,observedAt:0}))throw Error('Queued buy changed.');return prior.state==='waiting';}
   if(Object.values(d.pendingSales||{}).some(p=>p.state==='waiting'))return false;
   const unresolved=Object.values(d.jobs).filter(j=>open(j)&&!returnedSale(j)&&!spendableBuy(j));
   // Defer only behind prior buys, never an uncertain sale or invalidated job.
   if(!unresolved.length||unresolved.some(j=>j.event.side!=='buy'||j.state==='needs-attention'||j.leaderInvalidatedAt||(j.event.network===event.network?!precedes(j.event,event):j.event.blockTime>event.blockTime)))return false;
   const day=new Date(now()).toISOString().slice(0,10);
   if(cashCopyRaw(d.spent[day]||'0')+cashCopyRaw(d.grant.scope.buyUsdcRaw)>cashCopyRaw(d.grant.scope.dailyUsdcRaw))throw Error('Daily cross-chain copy limit reached.');
   if(Object.keys(d.pendingBuys||{}).length>=1000||Object.values(d.pendingBuys||{}).filter(p=>p.state==='waiting').length>=64)throw Error('Buy queue is full.');
   (d.pendingBuys??={})[eventKey(event)]={event:structuredClone(event),permissionId:d.grant.scope.id,waitingOn:unresolved.map(j=>j.id),state:'waiting',capturedAt:now()};return true;
  });},
  async cancelQueuedBuy(transaction:string,network:CashCopyEvent['network'],reason:NonNullable<CashCopyDocument['pendingBuys']>[string]['reason']){await change(d=>{const p=d.pendingBuys?.[network+':'+transaction];if(p?.state==='waiting'){p.state='cancelled';p.reason=reason;}});},
  async queueSale(event:CashCopyEvent){return change(d=>{
   const at=now();pruneDeferredBuys(d,at);pruneDeferredSales(d,at);
   validateCashCopyEvent(event,d.grant.scope,now());if(d.revoked||event.side!=='sell')throw Error('Sale queue is not authorized.');
   for(const p of Object.values(d.pendingBuys||{}))if(p.state==='waiting'&&key(p.event)===key(event)&&precedes(p.event,event)){p.state='cancelled';p.reason='sale';}
   if(Object.values(d.jobs).some(j=>eventKey(j.event)===eventKey(event)))return false;
   const prior=d.pendingSales?.[eventKey(event)];if(prior){if(!same({...prior.event,observedAt:0,confirmation:undefined},{...event,observedAt:0,confirmation:undefined}))throw Error('Queued sale changed.');return prior.state==='waiting';}
   const buying=Object.values(d.jobs).filter(j=>open(j)&&j.event.side==='buy'&&key(j.event)===key(event)&&!j.leaderInvalidatedAt&&precedes(j.event,event));
   if(!buying.length)return false;
   if(Object.keys(d.pendingSales||{}).length>=1000)throw Error('Sale history needs archival.');
   if(Object.values(d.pendingSales||{}).filter(p=>p.state==='waiting').length>=64)throw Error('Sale queue is full.');
   (d.pendingSales??={})[eventKey(event)]={event:structuredClone(event),permissionId:d.grant.scope.id,waitingOn:buying.map(j=>j.id),state:'waiting',capturedAt:now()};return true;
  });},
  async cancelQueuedSale(transaction:string,network:CashCopyEvent['network']){await change(d=>{const p=d.pendingSales?.[network+':'+transaction];if(p)p.state='cancelled';});},
  async reserve(event:CashCopyEvent){const id=randomUUID();return change(d=>{
   // Admission must not depend on a browser status read or a surviving fast
   // follow-up. Retire only expired waiting signals under the same CAS.
   const at=now();pruneDeferredBuys(d,at);pruneDeferredSales(d,at);
   const scope=d.grant.scope;if(d.revoked)throw Error('Copy plan is paused.');
   const existing=Object.values(d.jobs).find(j=>eventKey(j.event)===eventKey(event)||sourceKey(event)!==null&&sourceKey(j.event)===sourceKey(event));
   if(existing){if(existing.leaderInvalidatedAt)throw Error('Leader event was invalidated; its source order remains reserved.');if(!same({...existing.event,observedAt:0},{...event,observedAt:0}))throw Error('Leader event changed.');return structuredClone(existing);}
   validateCashCopyEvent(event,scope,now());
   if(event.confirmation==='captured'){const p=d.pendingSales?.[eventKey(event)];if(!p||p.state!=='waiting'||p.permissionId!==scope.id||p.capturedAt-p.event.blockTime>10000||p.capturedAt<p.event.blockTime||!same({...p.event,observedAt:0,confirmation:undefined},{...event,observedAt:0,confirmation:undefined}))throw Error('Captured sale was not recorded while live.');
    if(!p.waitingOn.length||p.waitingOn.some(id=>{const buy=d.jobs[id];return !buy||buy.event.side!=='buy'||key(buy.event)!==key(event)||!precedes(buy.event,event)||buy.leaderInvalidatedAt||buy.state!=='complete'&&!spendableBuy(buy);}))throw Error('Captured sale inventory order changed.');
   }
   const deferred=Object.values(d.pendingBuys||{}).find(p=>eventKey(p.event)===eventKey(event)||sourceKey(event)!==null&&sourceKey(p.event)===sourceKey(event));
   if(deferred){
    if(event.side!=='buy'||deferred.state!=='waiting'||deferred.permissionId!==scope.id||!same({...deferred.event,observedAt:0},{...event,observedAt:0})||!deferred.waitingOn.length||deferred.waitingOn.some(id=>{const j=d.jobs[id];return !j||j.event.side!=='buy'||j.leaderInvalidatedAt||j.state!=='complete'&&!spendableBuy(j);}))throw Error('Deferred buy funding changed.');
   }
   const waitingBuys=Object.values(d.pendingBuys||{}).filter(p=>p.state==='waiting').sort((a,b)=>compareCashCopyEvents(a.event,b.event)||a.capturedAt-b.capturedAt);
   if(event.side==='buy'&&waitingBuys.length&&eventKey(waitingBuys[0].event)!==eventKey(event))throw Error('An earlier deferred buy is unresolved.');
   if(event.sourceOrder&&(!d.enrollment||event.sourceOrder.wallet!==d.enrollment.leaderSource))throw Error('Leader source wallet changed.');
   if(Object.keys(d.jobs).length>=1000)throw Error('Copy history needs archival before new trades.');
   // A queued exit takes priority over another buy. Never overlap sales.
   const waiting=Object.values(d.pendingSales||{}).filter(p=>p.state==='waiting').sort((a,b)=>compareCashCopyEvents(a.event,b.event)||a.capturedAt-b.capturedAt);
   if(waiting.length&&(event.side==='buy'||eventKey(waiting[0].event)!==eventKey(event)))throw Error('A captured copy sale is unresolved.');
   if(d.pendingSales?.[eventKey(event)]?.state==='cancelled')throw Error('Captured copy sale was cancelled.');
   // Confirmed, independently credited buys no longer hold later buys until
   // economic finality. Signing rechecks their funding and canonical blocks.
   // Signing/reserved work and every unresolved sale still serialize the wallet.
   if(Object.values(d.jobs).some(j=>open(j)&&!returnedSale(j)&&!(spendableBuy(j)&&(event.side==='buy'||key(j.event)===key(event)&&precedes(j.event,event)))))throw Error('An existing copy trade is unresolved.');
   // A delayed sale cannot consume later-bought tokens from the aggregate
   // position. That case needs lot reconciliation, never an estimated sale.
   if(event.side==='sell'&&Object.values(d.jobs).some(j=>j.event.side==='buy'&&key(j.event)===key(event)&&(j.provisionalCredit||j.state==='complete')&&!precedes(j.event,event)))throw Error('Leader inventory order needs reconciliation.');
   const day=new Date(now()).toISOString().slice(0,10),spent=cashCopyRaw(d.spent[day]||'0');
   const amountRaw=event.side==='buy'?scope.buyUsdcRaw:proportionalCashSale(d.positions[key(event)]||'0',event);
   if(event.side==='buy'){if(spent+cashCopyRaw(amountRaw)>cashCopyRaw(scope.dailyUsdcRaw))throw Error('Daily cross-chain copy limit reached.');d.spent[day]=String(spent+cashCopyRaw(amountRaw));}
   // Counting attempted buys conservatively prevents retries or refunds from
   // creating a spending loop. Daily spending is retained across new grants.
   const job={id,scope:structuredClone(scope),event:structuredClone(event),amountRaw,state:'reserved' as const,purchase:null,sale:null,day,signed:null};d.jobs[id]=job;if(deferred)deferred.state='consumed';if(event.side==='sell')for(const p of Object.values(d.pendingBuys||{}))if(p.state==='waiting'&&key(p.event)===key(event)&&precedes(p.event,event)){p.state='cancelled';p.reason='sale';}const pending=d.pendingSales?.[eventKey(event)];if(pending)pending.state='consumed';return structuredClone(job);
  });},
 };
}
