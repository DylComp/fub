import canonicalize from 'canonicalize';
import {validateCashLimitTerms,type CashLimitTerms} from '../src/cash-limit-model.js';
import type {CashNetwork} from '../src/cash-route.js';
import type {CashLimitJournal} from './cash-limit-engine.js';
import type {CashPurchase} from './cash-purchase-store.js';
import type {CashSale} from './cash-return-store.js';
import {cashLimitBalances} from './cash-limit-balances.js';
import {inspectCashLimitPurchase,inspectCashLimitSale,cashLimitSaleGas} from './cash-limit-review.js';
import {cashSigningDigest,type CashSigningParts} from './cash-copy-signing-parts.js';
import {inspectCashQuote} from './cash-route.js';
import {inspectSignedCashDeposit,simulateCashDeposit} from './cash-deposit.js';
import {simulateCashReturn} from './cash-return-simulation.js';
import {inspectSignedCashEvm,prepareCashReturnGas} from './cash-return-transaction.js';
import type {PrivySignRequest} from './privy-sign-only.js';
import type {PrivyEvmSignRequest} from './privy-evm-sign-only.js';
import type {Rpc} from './funding.js';
export type CashLimitSigningReview={side:'buy';purchase:CashPurchase}|{side:'sell';sale:CashSale};
type Owner={walletId:string;check:(signal:AbortSignal)=>Promise<unknown>};
const same=(a:unknown,b:unknown)=>canonicalize(a)===canonicalize(b);
// This signer reads only an independently enrolled limit order. It never accepts
// a copied-trade grant, external transaction body, or synthetic leader event.
export function cashLimitSigning(c:{journal:CashLimitJournal<CashLimitSigningReview>;parts:CashSigningParts;enabled:()=>boolean;
 authorized:(t:CashLimitTerms)=>Promise<boolean>;resolveSolana:(t:CashLimitTerms,s:AbortSignal)=>Promise<Owner>;resolveEvm:(t:CashLimitTerms,s:AbortSignal)=>Promise<Owner>;
 solana:Rpc;evm:(n:CashNetwork)=>Rpc;solanaProvider:(r:PrivySignRequest,s:AbortSignal)=>Promise<string>;evmProvider:(r:PrivyEvmSignRequest,s:AbortSignal)=>Promise<string>;now?:()=>number},
 d={balances:cashLimitBalances,inspectQuote:inspectCashQuote,simulateDeposit:simulateCashDeposit,simulateReturn:simulateCashReturn,prepareGas:prepareCashReturnGas,inspectDeposit:inspectSignedCashDeposit,inspectEvm:inspectSignedCashEvm}){
 const now=c.now||Date.now;
 const key=(t:CashLimitTerms,i:number)=>`cash-limit:${t.id}:${t.side}:${i}`;
 const commitment=(t:CashLimitTerms,r:CashLimitSigningReview,i:number)=>cashSigningDigest({terms:t,review:r,index:i});
 async function access(t:CashLimitTerms,r:CashLimitSigningReview,s:AbortSignal){s.throwIfAborted();validateCashLimitTerms(t);const job=await c.journal.get(t.id);
  if(!c.enabled()||now()<t.issuedAt||now()>=t.expiresAt||!job||job.state!=='signing'||!same(job.terms,t)||!same(job.review,r)||!await c.authorized(t))throw Error('Limit signing permission is inactive or changed.');
 }
 async function part(t:CashLimitTerms,r:CashLimitSigningReview,i:number,validate:(s:string)=>unknown,sign:()=>Promise<string>){
  const id=key(t,i),digest=commitment(t,r,i),saved=await c.parts.get(id);
  if(saved){if(saved.digest!==digest||saved.state!=='signed'||!saved.signed)throw Error('Limit signature outcome is unresolved.');await validate(saved.signed);return saved.signed;}
  if(!await c.parts.claim(id,digest))throw Error('Limit signature already claimed.');const signed=await sign();await validate(signed);await c.parts.complete(id,digest,signed);return signed;
 }
 return {async recover(id:string){const job=await c.journal.get(id);if(!job?.review||!['signing','needs-attention'].includes(job.state))return null;
  const r=job.review,count=r.side==='buy'?1:r.sale.gas.transactions.length;if(count<1||count>2)return null;const result:string[]=[];
  for(let i=0;i<count;i++){const saved=await c.parts.get(key(job.terms,i));if(!saved||saved.state!=='signed'||!saved.signed)return null;
   if(saved.digest!==commitment(job.terms,r,i))throw Error('Limit signing commitment changed.');
   if(r.side==='buy')d.inspectDeposit(r.purchase.review,saved.signed);else await d.inspectEvm(r.sale.gas.transactions[i],saved.signed);result.push(saved.signed);
  }return result;
 },async sign(id:string,external:AbortSignal){const signal=AbortSignal.any([external,AbortSignal.timeout(25000)]),job=await c.journal.get(id);
  if(!job?.review)throw Error('Limit review unavailable.');const t=job.terms,r=job.review;await access(t,r,signal);
  if(r.side!==t.side)throw Error('Limit side changed.');
  if(r.side==='buy'){
   const p=r.purchase;if(p.id!==id||p.wallet!==t.sourceWallet||p.state!=='prepared'||p.signed)throw Error('Limit purchase changed.');
   const q=d.inspectQuote(p.review.rawQuote,p.review.intent,p.review.quote.checkedAt);inspectCashLimitPurchase(t,q,now());
   if(!same(q,p.review.quote)||p.review.intent.slippageBps!==t.slippageBps||BigInt(p.review.maxFeeLamports)+BigInt(p.review.maxRentLamports)>BigInt(t.maxSourceFeeLamports))throw Error('Limit purchase budget changed.');
   await d.simulateDeposit(p.review,c.solana,undefined,now());const owner=await c.resolveSolana(t,signal);await access(t,r,signal);await owner.check(signal);
   const signed=await part(t,r,0,s=>d.inspectDeposit(p.review,s),()=>c.solanaProvider({walletId:owner.walletId,wallet:t.sourceWallet,unsigned:p.review.unsigned,idempotencyKey:key(t,0),expiresAt:Math.min(now()+8000,t.expiresAt,q.expiresAt)},signal));
   await access(t,r,signal);await owner.check(signal);return[signed];
  }
  const sale=r.sale,i=sale.simulation.route.intent;
  if(sale.id!==id||sale.wallet!==t.sourceWallet||sale.state!=='prepared'||sale.signed||i.slippageBps!==t.slippageBps||sale.gas.maxCostWei!==t.maxSaleGasRaw)throw Error('Limit sale review changed.');
  const rpc=c.evm(t.network),fresh=await d.simulateReturn((sale.simulation as typeof sale.simulation&{rawQuote?:unknown}).rawQuote,i,rpc,now(),sale.gas.transactions.map(v=>v.gas));
  const {checkedAt:_a,expiresAt:_b,...fr}=fresh.route,{checkedAt:_c,expiresAt:_e,...sr}=sale.simulation.route;if(!same(fr,sr))throw Error('Limit sale route changed.');
  const gas=await d.prepareGas(fresh,rpc,t.maxSaleGasRaw,now()),balances=await d.balances(t,rpc);
  inspectCashLimitSale(t,{network:i.network,wallet:i.wallet,cashWallet:i.cashWallet,token:i.token,amountRaw:i.amountRaw,minimumUsdcRaw:fresh.route.minimumRaw,maximumGasRaw:cashLimitSaleGas({...sale.gas,maxL1FeeWei:BigInt(gas.maxL1FeeWei)>BigInt(sale.gas.maxL1FeeWei)?gas.maxL1FeeWei:sale.gas.maxL1FeeWei}),checkedAt:Math.min(fresh.checkedAt,sale.gas.checkedAt),expiresAt:Math.min(fresh.expiresAt,sale.gas.expiresAt)},balances.tokenRaw,gas.balanceWei,now());
  if(gas.transactions.length!==sale.gas.transactions.length||gas.transactions.length<1||gas.transactions.length>2)throw Error('Limit sale transaction count changed.');
  const used=[...(fresh.route.approval?[fresh.approvalGasUsed]:[]),fresh.saleGasUsed];
  for(let n=0;n<gas.transactions.length;n++){const a=gas.transactions[n],b=sale.gas.transactions[n];
   if(a.chainId!==b.chainId||a.type!==b.type||a.value!==b.value||a.from!==b.from||a.to!==b.to||a.data!==b.data||a.nonce!==b.nonce||BigInt(used[n])>BigInt(b.gas)||BigInt(gas.baseFeePerGas||a.maxFeePerGas)+BigInt(gas.baseFeePerGas?b.maxPriorityFeePerGas:'0')>BigInt(b.maxFeePerGas))throw Error('Limit sale transaction or fee bid changed.');
  }
  const l1=BigInt(gas.maxL1FeeWei)>BigInt(sale.gas.maxL1FeeWei)?BigInt(gas.maxL1FeeWei):BigInt(sale.gas.maxL1FeeWei),total=sale.gas.transactions.reduce((sum,tx)=>sum+BigInt(tx.gas)*BigInt(tx.maxFeePerGas),l1);
  if(total>BigInt(t.maxSaleGasRaw)||total>BigInt(gas.balanceWei))throw Error('Limit sale gas budget exceeded.');
  const owner=await c.resolveEvm(t,signal),signed:string[]=[];
  for(let n=0;n<gas.transactions.length;n++){await access(t,r,signal);await owner.check(signal);const tx=sale.gas.transactions[n];signed.push(await part(t,r,n,s=>d.inspectEvm(tx,s),()=>c.evmProvider({walletId:owner.walletId,wallet:t.recipient,transaction:tx,idempotencyKey:key(t,n),expiresAt:Math.min(now()+8000,t.expiresAt,sale.gas.expiresAt)},signal)));}
  await access(t,r,signal);await owner.check(signal);return signed;
 }};
}
