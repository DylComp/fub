import { CASH_MINT } from '../src/cash-route.js';
import type { CashRouteQuote } from '../src/cash-route.js';
import type { Rpc } from './funding.js';
import { readFundingBalance } from './funding-balance.js';

export type CashFunding = {
  wallet: string; account: string; mint: typeof CASH_MINT; availableRaw: string;
  requestedRaw: string; enoughUsdc: boolean; frozen: boolean;
  nativeLamports: string; quoteGasLamports: string; enoughEstimatedGas: boolean;
  executable: false; checkedAt: number;
};
// Read the actual spendable USDC account. Fomo's aggregate cash display,
// portfolio USD value and balances on other chains are not this account.
// This is a funding check, not ownership proof or the final gas/rent simulation.
export async function checkCashFunding(quote: CashRouteQuote, rpc: Rpc, now = Date.now()): Promise<CashFunding> {
  if (quote.expiresAt <= now || quote.checkedAt > now + 1000 || quote.expiresAt > quote.checkedAt + 30000 ||
    !/^[1-9]\d{0,10}$/.test(quote.amountRaw) || !/^(0|[1-9]\d{0,8})$/.test(quote.estimatedGasLamports))
    throw Error('Refresh the cash quote before checking funding.');
  const [balance, native] = await Promise.all([
    readFundingBalance(quote.sourceWallet, CASH_MINT, rpc),
    rpc('getBalance', [quote.sourceWallet, { commitment: 'confirmed' }]),
  ]);
  const value = native && typeof native === 'object' && 'value' in native ? native.value : undefined;
  if (balance.decimals !== 6 || typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw Error('The cash balance could not be verified.');
  const gas = BigInt(quote.estimatedGasLamports) > 5000n ? BigInt(quote.estimatedGasLamports) : 5000n;
  return { wallet: quote.sourceWallet, account: balance.source, mint: CASH_MINT,
    availableRaw: balance.rawAmount, requestedRaw: quote.amountRaw, frozen: balance.frozen,
    enoughUsdc: !balance.frozen && BigInt(balance.rawAmount) >= BigInt(quote.amountRaw),
    nativeLamports: String(value), quoteGasLamports: gas.toString(), enoughEstimatedGas: BigInt(value) >= gas,
    executable: false, checkedAt: now };
}
