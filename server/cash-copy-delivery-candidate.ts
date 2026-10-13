import type {CashCopyDocument} from './cash-copy-journal.js';
import type {CashPurchaseStore} from './cash-purchase-store.js';
import type {CashReturnStore} from './cash-return-store.js';
import type {CashCopyDelivery} from './cash-copy-delivery.js';

/** Select saved bytes before slow provider ownership checks. A transaction
 * already credited on-chain needs receipt reconciliation, not redelivery.
 * Selection grants no authority; callers must still validate signatures,
 * permissions, ownership and funding immediately before the handoff. */
export async function cashCopyDeliveryCandidate(job:CashCopyDocument['jobs'][string],stores:{purchases:Pick<CashPurchaseStore,'get'>;sales:Pick<CashReturnStore,'get'>},now=Date.now()):Promise<CashCopyDelivery|null>{
 if(!['signing','submitted','needs-attention'].includes(job.state)||job.leaderInvalidatedAt||job.provisionalCredit||job.provisionalDebit||job.scope.expiresAt<=now)return null;
 const wallet=job.scope.sourceWallet,base={version:1 as const,planId:job.scope.planId,jobId:job.id,wallet,network:job.event.network,expiresAt:Math.min(now+8000,job.scope.expiresAt)};
 let delivery:CashCopyDelivery;
 if(job.event.side==='buy'){
  const p=await stores.purchases.get(job.id,wallet);
  if(!p?.signed||!p.signature||p.state!=='submitted')return null;
  delivery={...base,expiresAt:Math.min(base.expiresAt,p.review.quote.expiresAt),side:'buy',unsigned:p.review.unsigned,signed:p.signed,signature:p.signature,slot:p.review.slot};
 }else{
  const p=await stores.sales.get(job.id,wallet);
  if(!p?.signed||!p.hashes||p.state!=='submitted')return null;
  delivery={...base,expiresAt:Math.min(base.expiresAt,p.gas.expiresAt),side:'sell',transactions:p.gas.transactions,signed:p.signed,hashes:p.hashes};
 }
 return delivery.expiresAt<now+250?null:delivery;
}
