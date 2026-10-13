import { CASH_MINT, CASH_NETWORKS, RELAY_SOLANA } from './cash-route.js';
import type { CashRouteQuote } from './cash-route.js';

export type CashSettlementState = 'awaiting-deposit' | 'settling' | 'delayed' | 'verify-delivery' | 'verify-refund' | 'needs-attention' | 'complete' | 'refunded';
export type CashSettlement = {
  state: CashSettlementState; retryDeposit: false; releaseReservation: boolean;
};
export type CashReceipt = {
  requestId: string; chainId: number; transaction: string; recipient: string;
  currency: string; receivedRaw: string; finalized: boolean; successful: boolean;
};
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const signature = (v: unknown) => typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(v);
const evmHash = (v: unknown) => typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v);

// Called with independent, finalized receipt evidence. A provider's success or
// refund label alone must never release cash or credit an acquired position.
// Persist the request/deposit before submission; timeouts only reconcile it.
export function reconcileCashSettlement(quote: CashRouteQuote, depositSignature: string, statusValue: unknown, receipt?: CashReceipt): CashSettlement {
  const result = (state: CashSettlementState, releaseReservation = false): CashSettlement => ({ state, retryDeposit: false, releaseReservation });
  if (!signature(depositSignature)) return result('needs-attention');
  const s = object(statusValue), chainId = CASH_NETWORKS[quote.network].chainId;
  if (s.originChainId !== RELAY_SOLANA || s.destinationChainId !== chainId) return result('needs-attention');
  const incoming = s.inTxHashes, outgoing = s.txHashes;
  if (!Array.isArray(incoming) || incoming.length > 4 || !incoming.every(signature) ||
    !Array.isArray(outgoing) || outgoing.length > 4 || !outgoing.every(v => signature(v) || evmHash(v))) return result('needs-attention');
  if (s.status === 'waiting') return result('awaiting-deposit');
  if (!incoming.includes(depositSignature)) return result('needs-attention');
  if (['depositing', 'pending', 'submitted'].includes(String(s.status))) return result('settling');
  if (s.status === 'delayed') return result('delayed');
  if (s.status === 'failure') return result('needs-attention');
  if (!['success', 'refund'].includes(String(s.status))) return result('needs-attention');
  const state = s.status === 'success' ? 'verify-delivery' : 'verify-refund';
  if (!receipt || receipt.requestId !== quote.requestId || !receipt.finalized || !receipt.successful ||
    !outgoing.includes(receipt.transaction) || !/^[1-9]\d{0,77}$/.test(receipt.receivedRaw)) return result(state);
  if (s.status === 'success') {
    return receipt.chainId === chainId && evmHash(receipt.transaction) && receipt.recipient.toLowerCase() === quote.recipient.toLowerCase() &&
      receipt.currency.toLowerCase() === quote.token.toLowerCase() && BigInt(receipt.receivedRaw) >= BigInt(quote.minimumRaw)
      ? result('complete', true) : result(state);
  }
  // Destination-token refunds need operator recovery; only verified origin
  // USDC can be shown as cash returned. Refund fees may reduce the amount.
  return receipt.chainId === RELAY_SOLANA && signature(receipt.transaction) && receipt.recipient === quote.refundWallet &&
    receipt.currency === CASH_MINT && BigInt(receipt.receivedRaw) <= BigInt(quote.amountRaw)
    ? result('refunded', true) : result(state);
}
