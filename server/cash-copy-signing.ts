import canonicalize from 'canonicalize';
import type {CashNetwork} from '../src/cash-route.js';
import {cashCopyRaw,validateCashCopyEvent} from '../src/cash-copy-model.js';
import type {CashCopyJob,CashCopyJournal,CashSigningStage} from './cash-copy-service.js';
import {cashSigningDigest,cashSigningPartId,cashSigningAttempt,type CashSigningParts} from './cash-copy-signing-parts.js';
import {inspectCashQuote} from './cash-route.js';
import {inspectSignedCashDeposit,simulateCashDeposit} from './cash-deposit.js';
import {simulateCashReturn} from './cash-return-simulation.js';
import {inspectSignedCashEvm,prepareCashReturnGas} from './cash-return-transaction.js';
import type {PrivySignRequest} from './privy-sign-only.js';
import type {PrivyEvmSignRequest} from './privy-evm-sign-only.js';
import type {Rpc} from './funding.js';
const same=(a:unknown,b:unknown)=>canonicalize(a)===canonicalize(b);
type Enrollment={walletId:string;check:(signal:AbortSignal)=>Promise<void>};
// Compose only inside the private host. The journal is the PRIVATE budget and
// inventory authority, not a website-supplied review. Callers provide job IDs.
export function cashCopySigning(config:{journal:CashCopyJournal&{authorized:(job:CashCopyJob)=>Promise<boolean>};parts:CashSigningParts;
 enabled:()=>boolean;saleGasCeilingWei?:string;verifyLeader:(job:CashCopyJob,signal:AbortSignal)=>Promise<void>;
 resolveSolana:(job:CashCopyJob,signal:AbortSignal)=>Promise<Enrollment>;resolveEvm:(job:CashCopyJob,signal:AbortSignal)=>Promise<Enrollment>;
 solana:Rpc;evm:(network:CashNetwork)=>Rpc;solanaProvider:(r:PrivySignRequest,s:AbortSignal)=>Promise<string>;evmProvider:(r:PrivyEvmSignRequest,s:AbortSignal)=>Promise<string>;now?:()=>number},deps={inspectQuote:inspectCashQuote,simulateDeposit:simulateCashDeposit,simulateReturn:simulateCashReturn,prepareGas:prepareCashReturnGas}){
 const now=config.now||Date.now;
 if(config.saleGasCeilingWei!==undefined&&!/^[1-9]\d{0,29}$/.test(config.saleGasCeilingWei))throw Error('Invalid additional sale gas ceiling.');
 async function access(job:CashCopyJob,signal:AbortSignal){
  signal.throwIfAborted();validateCashCopyEvent(job.event,job.scope,now());
  const current=await config.journal.get(job.id);
  if(!config.enabled()||!current||!same(current.scope,job.scope)||!same(current.event,job.event)||current.amountRaw!==job.amountRaw||cashSigningAttempt(current)!==cashSigningAttempt(job)||
   !same(current.purchase,job.purchase)||!same(current.sale,job.sale)||current.state!=='signing'||!await config.journal.authorized(current))throw Error('Copy signing permission is no longer active.');
 }
 async function signPart(job:CashCopyJob,index:number,body:unknown,validate:(signed:string)=>Promise<unknown>|unknown,sign:()=>Promise<string>){
  const id=cashSigningPartId(job,index);
  const digest=cashSigningDigest({scope:job.scope,event:job.event,amountRaw:job.amountRaw,body});
  const saved=await config.parts.get(id);
  if(saved){if(saved.digest!==digest||saved.state!=='signed'||!saved.signed)throw Error('Signing outcome is unresolved. Keep the existing attempt.');await validate(saved.signed);return saved.signed;}
  if(!await config.parts.claim(id,digest))throw Error('Another worker owns this signing request.');
  const signed=await sign();await validate(signed);
  // Persist even if cancellation or revocation arrived while signing. Only a
  // later authority check can release these bytes for transaction submission.
  await config.parts.complete(id,digest,signed);return signed;
 }
 return {
  // Read only: recover fully persisted bytes after the executor loses its reply.
  // This never calls Privy, completes a partial request, or authorizes broadcast.
  async recover(id:string):Promise<string|string[]|null>{
   const job=await config.journal.get(id);if(!job||!['signing','needs-attention'].includes(job.state))return null;
   const read=async(index:number,body:unknown,validate:(signed:string)=>Promise<unknown>|unknown)=>{
    const key=cashSigningPartId(job,index);
    const part=await config.parts.get(key);if(!part||part.state!=='signed'||!part.signed)return null;
    if(part.digest!==cashSigningDigest({scope:job.scope,event:job.event,amountRaw:job.amountRaw,body}))throw Error('Recovered signing commitment changed.');
    await validate(part.signed);return part.signed;
   };
   if(job.event.side==='buy'){if(!job.purchase)return null;return read(0,job.purchase.review,s=>inspectSignedCashDeposit(job.purchase!.review,s));}
   const sale=job.sale;if(!sale||sale.gas.transactions.length<1||sale.gas.transactions.length>2)return null;
   const result=[];for(let index=0;index<sale.gas.transactions.length;index++){
    const transaction=sale.gas.transactions[index],signed=await read(index,{transaction,route:sale.simulation.route,maxGas:sale.gas.maxCostWei},s=>inspectSignedCashEvm(transaction,s));
    if(!signed)return null;result.push(signed);
   }return result;
  },async sign(id:string,external:AbortSignal):Promise<string|string[]>{
  let stage:CashSigningStage='access';try{
  const signal=AbortSignal.any([external,AbortSignal.timeout(25000)]),job=await config.journal.get(id);
  if(!job)throw Error('Copy job not found.');await access(job,signal);stage='leader-proof';await config.verifyLeader(job,signal);
  const scope=job.scope,network=job.event.network;
  if(job.event.side==='buy'){
   const p=job.purchase;if(!p||p.id!==id||p.wallet!==scope.sourceWallet||p.state!=='prepared'||p.signed||job.amountRaw!==scope.buyUsdcRaw)throw Error('Invalid copied purchase review.');
   stage='quote';const q=deps.inspectQuote(p.review.rawQuote,p.review.intent,p.review.quote.checkedAt);
   if(!same(q,p.review.quote)||q.network!==network||q.token!==job.event.token||q.sourceWallet!==scope.sourceWallet||q.recipient!==scope.recipient||q.amountRaw!==job.amountRaw||p.review.intent.slippageBps!==scope.slippageBps||p.review.intent.gasTopupUsdcRaw!==scope.gasTopupUsdcRaw||cashCopyRaw(p.review.maxFeeLamports)+cashCopyRaw(p.review.maxRentLamports)>cashCopyRaw(scope.maxSourceFeeLamports))throw Error('Copied purchase differs from permission.');
   // The simulation and initial live ownership lookup are independent read-only
   // checks. resolveSolana already checks current delegation and re-reads the
   // grant afterward; an immediate second provider lookup adds no authority.
   stage='simulation';const [,owner]=await Promise.all([
    deps.simulateDeposit(p.review,config.solana,undefined,now()),
    config.resolveSolana(job,signal),
   ]);
   stage='ownership';await access(job,signal);
   stage='provider-signature';const signed=await signPart(job,0,p.review,s=>inspectSignedCashDeposit(p.review,s),()=>config.solanaProvider({walletId:owner.walletId,wallet:scope.sourceWallet,unsigned:p.review.unsigned,idempotencyKey:cashSigningPartId(job,0),expiresAt:Math.min(now()+8000,scope.expiresAt,p.review.quote.expiresAt)},signal));
   stage='post-sign-check';const checks=await Promise.allSettled([access(job,signal),owner.check(signal)]);for(const result of checks)if(result.status==='rejected')throw result.reason;return signed;
  }
  const sale=job.sale;if(!sale||sale.id!==id||sale.wallet!==scope.sourceWallet||sale.state!=='prepared'||sale.signed||!scope.copySells||sale.gas.maxCostWei!==scope.maxSaleGas[network])throw Error('Invalid copied sale review.');
  const i=sale.simulation.route.intent;
  if(i.network!==network||i.wallet!==scope.recipient||i.cashWallet!==scope.sourceWallet||i.token!==job.event.token||i.amountRaw!==job.amountRaw||i.slippageBps!==scope.slippageBps)throw Error('Copied sale differs from permission.');
  const rpc=config.evm(network),raw=(sale.simulation as typeof sale.simulation&{rawQuote?:unknown}).rawQuote;
  stage='simulation';const fresh=await deps.simulateReturn(raw,i,rpc,now(),sale.gas.transactions.map(t=>t.gas));
  const {checkedAt:_freshTime,expiresAt:_freshExpiry,...freshRoute}=fresh.route;
  const {checkedAt:_savedTime,expiresAt:_savedExpiry,...savedRoute}=sale.simulation.route;
  if(!same(freshRoute,savedRoute))throw Error('Copied sale route changed.');
  stage='gas';const gas=await deps.prepareGas(fresh,rpc,sale.gas.maxCostWei,now());
  const used=[...(fresh.route.approval?[fresh.approvalGasUsed]:[]),fresh.saleGasUsed];
  const l1=BigInt(gas.maxL1FeeWei)>BigInt(sale.gas.maxL1FeeWei)?gas.maxL1FeeWei:sale.gas.maxL1FeeWei;
  if(gas.transactions.length!==sale.gas.transactions.length)throw Error('Copied sale transaction count changed.');
  for(let index=0;index<gas.transactions.length;index++){
   const t=gas.transactions[index],saved=sale.gas.transactions[index];
   if(BigInt(used[index])>BigInt(saved.gas))throw Error('Copied sale exceeds its saved gas units.');
   if(t.nonce!==saved.nonce)throw Error('Copied sale nonce changed.');
   if(t.chainId!==saved.chainId||t.type!==saved.type||t.value!==saved.value||t.from!==saved.from||t.to!==saved.to||t.data!==saved.data)throw Error('Copied sale transaction changed.');
   if(BigInt(gas.baseFeePerGas||t.maxFeePerGas)+BigInt(gas.baseFeePerGas?saved.maxPriorityFeePerGas:'0')>BigInt(saved.maxFeePerGas))throw Error('Copied sale fee bid is stale.');
  }
  const totalCost=sale.gas.transactions.reduce((n,t)=>n+BigInt(t.gas)*BigInt(t.maxFeePerGas),BigInt(l1));
  if(totalCost>BigInt(sale.gas.maxCostWei))throw Error('Copied sale exceeds its total gas budget.');
  if(BigInt(gas.balanceWei)<totalCost)throw Error('Copied sale gas balance is insufficient.');
  if(config.saleGasCeilingWei&&sale.gas.transactions.reduce((n,t)=>n+BigInt(t.value)+BigInt(t.gas)*BigInt(t.maxFeePerGas),BigInt(l1))>BigInt(config.saleGasCeilingWei))throw Error('Copied sale exceeds the additional gas ceiling.');
  stage='ownership';const owner=await config.resolveEvm(job,signal),signed:string[]=[];
  for(let index=0;index<sale.gas.transactions.length;index++){
   await access(job,signal);await owner.check(signal);const transaction=sale.gas.transactions[index];
   stage='provider-signature';signed.push(await signPart(job,index,{transaction,route:sale.simulation.route,maxGas:sale.gas.maxCostWei},s=>inspectSignedCashEvm(transaction,s),()=>config.evmProvider({walletId:owner.walletId,wallet:scope.recipient,transaction,idempotencyKey:cashSigningPartId(job,index),expiresAt:Math.min(now()+8000,scope.expiresAt,sale.gas.expiresAt)},signal)));
  }
  stage='post-sign-check';const checks=await Promise.allSettled([access(job,signal),owner.check(signal)]);for(const result of checks)if(result.status==='rejected')throw result.reason;return signed;
  }catch(error){const failure=error instanceof Error?error:Error('Copy signing failed.');Object.assign(failure,{cashSigningStage:stage});throw failure;}
 }};
}
