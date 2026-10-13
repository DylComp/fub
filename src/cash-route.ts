import { isMint } from './assets.js';
import { isEvmAddress, NETWORKS } from './networks.js';
import type { EvmNetwork } from './networks.js';

export const CASH_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const RELAY_SOLANA = 792703809;
export const CASH_NETWORKS = {
  base: { ...NETWORKS.base, protocol: 'base' },
  bnb: { ...NETWORKS.bnb, protocol: 'bnb' },
  monad: { ...NETWORKS.monad, protocol: 'monad' },
  robinhood: { ...NETWORKS.robinhood, protocol: 'robinhood' },
  arc: { ...NETWORKS.arc, protocol: 'arc' },
  ethereum: { ...NETWORKS.ethereum, protocol: 'ethereum' },
} as const;
export type CashNetwork = EvmNetwork;
export function isCashNetwork(value: unknown): value is CashNetwork {
  return typeof value === 'string' && Object.hasOwn(CASH_NETWORKS, value);
}

// Cash amounts are always raw Circle USDC, never native gas or a portfolio's
// estimated dollar value. Reject rounding rather than silently changing spend.
export function cashAmountRaw(value: string): string {
  if (!/^(0|[1-9]\d{0,5})(\.\d{1,6})?$/.test(value)) throw Error('Enter a USDC amount with up to six decimal places.');
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  if (amount < 1000000n || amount > 10000000000n) throw Error('Enter between 1 and 10,000 USDC.');
  return amount.toString();
}
export type CashRouteIntent = {
  sourceWallet: string; recipient: string; network: CashNetwork;
  token: string; amountRaw: string; slippageBps: number; gasTopupUsdcRaw?: string;
};
export function validateCashIntent(intent: CashRouteIntent) {
  if (intent.gasTopupUsdcRaw !== undefined && (!/^[1-9]\d{0,5}$/.test(intent.gasTopupUsdcRaw) || BigInt(intent.gasTopupUsdcRaw)>500000n)) throw Error('Invalid destination gas budget.');
  if (!isCashNetwork(intent.network) || !isMint(intent.sourceWallet) ||
    !isEvmAddress(intent.recipient) || !isEvmAddress(intent.token) ||
    /^0x0{40}$/i.test(intent.recipient) || /^0x0{40}$/i.test(intent.token) ||
    !/^[1-9]\d{0,10}$/.test(intent.amountRaw) || BigInt(intent.amountRaw) < 1000000n || BigInt(intent.amountRaw) > 10000000000n ||
    !Number.isInteger(intent.slippageBps) || intent.slippageBps < 1 || intent.slippageBps > 100)
    throw Error('Invalid USDC trade request.');
}
export type CashRouteQuote = {
  provider: 'relay'; executable: false; source: 'solana-usdc';
  network: CashNetwork; token: string; amountRaw: string;
  outputRaw: string; minimumRaw: string; outputDecimals: number;
  feeUsdcRaw: string; estimatedGasLamports: string;
  priceImpactPercent: number; orderId: string; requestId: string;
  refundWallet: string; sourceWallet: string; recipient: string;
  checkedAt: number; expiresAt: number; depositVerified: true;
  gasTopup?: {budgetUsdcRaw:string; promisedWei:string; committed:false};
};
