import {ExecutorRpcError} from './copy-executor-rpc.js';
import {ChainRpcError} from './funding.js';

export const CASH_SIGNING_FAILURE_REASONS=['rpc-context','rpc-rate-limit','rpc-http','rpc-transport','rpc-malformed','rpc-error','simulation-context','simulation-failed','simulation-transfer','simulation-invariant','simulation-delta','simulation-balance-race','review-expired','insufficient-cash','fee-limit','sale-route','sale-nonce','sale-transaction','sale-gas-units','sale-fee-bid','sale-gas-budget','sale-gas-balance','sale-block','other'] as const;
export type CashSigningFailureReason=typeof CASH_SIGNING_FAILURE_REASONS[number];
// Persist only a fixed classification. Provider messages, request URLs, signed
// bytes and arbitrary exception properties must never enter the job journal.
export function cashSigningFailureReason(error:unknown):CashSigningFailureReason {
 if(error instanceof ExecutorRpcError){
  const d=error.diagnostic;
  if(d.kind==='rpc'&&d.code===-32016)return 'rpc-context';
  if(d.kind==='http'&&d.code===429)return 'rpc-rate-limit';
  return d.kind==='http'?'rpc-http':d.kind==='transport'?'rpc-transport':d.kind==='malformed'?'rpc-malformed':'rpc-error';
 }
 if(error instanceof ChainRpcError)return error.code===-32016?'rpc-context':'rpc-error';
 if(!(error instanceof Error))return 'other';
 const messages:Record<string,CashSigningFailureReason>={
  'Cash simulation context mismatch.':'simulation-context',
  'Cash deposit simulation failed.':'simulation-failed',
  'Cash simulation transfer differs from the approved purchase.':'simulation-transfer',
  'Cash simulation account invariant changed.':'simulation-invariant',
  'Cash deposit simulation differs from the approved purchase.':'simulation-delta',
  'Cash simulation balance snapshots did not converge.':'simulation-balance-race',
  'Refresh the cash transaction before signing.':'review-expired',
  'Not enough Solana USDC for this purchase.':'insufficient-cash',
  'Cash purchase exceeds its SOL fee limit.':'fee-limit',
  'Refresh the sale gas review.':'review-expired',
  'Cash sale source pool is unsupported.':'sale-route',
  'Cash sale source pool changed.':'sale-route',
  'Cash sale source pool is not canonical.':'sale-route',
  'Cash sale simulation failed.':'simulation-failed',
  'Copied sale nonce changed.':'sale-nonce',
  'Wait for the existing EVM transaction to settle.':'sale-nonce',
  'Copied sale transaction count changed.':'sale-transaction',
  'Copied sale transaction changed.':'sale-transaction',
  'Copied sale exceeds its saved gas units.':'sale-gas-units',
  'Cash sale simulation exceeds the saved gas limit.':'sale-gas-units',
  'Sale gas usage is unsupported.':'sale-gas-units',
  'Copied sale fee bid is stale.':'sale-fee-bid',
  'Sale gas price exceeds the limit.':'sale-fee-bid',
  'Copied sale exceeds its total gas budget.':'sale-gas-budget',
  'Sale exceeds its total gas budget.':'sale-gas-budget',
  'Copied sale exceeds the additional gas ceiling.':'sale-gas-budget',
  'Copied sale gas balance is insufficient.':'sale-gas-balance',
  'Destination gas has not arrived or is insufficient. No sale was submitted.':'sale-gas-balance',
  'Sale simulation block changed.':'sale-block',

 };
 return Object.hasOwn(messages,error.message)?messages[error.message]:'other';
}
