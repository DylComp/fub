import type {CashSale} from '../server/cash-return-store';

// Refreshing an unsigned quote is routine. Continue to the wallet only when
// the user gets at least the displayed minimum under the same spending limits.
export function cashSaleReviewDecision(previous:CashSale|null,next:CashSale):'continue'|'review-minimum'{
 if(!previous)return 'review-minimum';
 const a=previous.simulation.route,b=next.simulation.route;
 if(previous.state!=='prepared'||next.state!=='prepared'||previous.signed||next.signed||previous.hashes||next.hashes||
   previous.id!==next.id||previous.wallet!==next.wallet||
   a.intent.network!==b.intent.network||a.intent.wallet!==b.intent.wallet||a.intent.cashWallet!==b.intent.cashWallet||
   a.intent.token!==b.intent.token||a.intent.amountRaw!==b.intent.amountRaw||a.intent.slippageBps!==b.intent.slippageBps||
   a.refundCurrency!==b.refundCurrency||a.refundWallet!==b.refundWallet||
   BigInt(next.gas.maxCostWei)>BigInt(previous.gas.maxCostWei)||
   !!a.approval!==!!b.approval||a.approval&&b.approval&&(a.approval.to!==b.approval.to||a.approval.data!==b.approval.data)||
   previous.gas.transactions.length!==next.gas.transactions.length||
   next.gas.transactions.some((tx,i)=>{const old=previous.gas.transactions[i];return tx.nonce!==old.nonce||tx.chainId!==old.chainId||tx.from!==old.from||tx.to!==old.to||tx.value!==old.value;}))
  throw Error('The sale limits changed. Review the existing trade before signing.');
 return BigInt(b.minimumRaw)>=BigInt(a.minimumRaw)?'continue':'review-minimum';
}
