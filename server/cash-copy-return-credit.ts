import type {CashCopyDocument} from './cash-copy-journal.js';
import type {CashSale} from './cash-return-store.js';
import type {CashSaleCredit} from './cash-copy-sale-credit.js';

/** Receipt-only reconciliation remains available after a pause or expiry.
 * This records independently finalized cash; it cannot sign, submit, renew a
 * permission or mark the EVM sale final. The journal still validates the proof
 * and preserves the unresolved job for source-chain reconciliation. */
export async function reconcileCashCopyReturns(document:CashCopyDocument,c:{
 read:(id:string,wallet:string)=>Promise<CashSale|null>;
 verify:(sale:CashSale)=>Promise<CashSaleCredit|null>;
 record:(job:CashCopyDocument['jobs'][string],sale:CashSale,proof:CashSaleCredit)=>Promise<void>;
},signal:AbortSignal){
 let recorded=0;
 for(const job of Object.values(document.jobs)){
  signal.throwIfAborted();
  if(job.state!=='submitted'||job.event.side!=='sell'||job.provisionalDebit||job.leaderInvalidatedAt)continue;
  const sale=await c.read(job.id,job.scope.sourceWallet);if(!sale)continue;
  const proof=await c.verify(sale);signal.throwIfAborted();
  if(proof){await c.record(job,sale,proof);recorded++;}
 }
 return recorded;
}
