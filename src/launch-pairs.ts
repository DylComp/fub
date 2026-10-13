import { isMint } from './assets.js';

export const SOL_PAIR_MINT = 'So11111111111111111111111111111111111111112';
export type LaunchPair = { mint: string; name: string; ticker: string; decimals: number; source?: 'sol' | 'global' | 'quoteControl' | 'pumpCoin'; stage?: 'curve' | 'pool' };
export type LaunchPairs = { checkedAt: number; pairs: LaunchPair[] };
export const SOL_PAIR: LaunchPair = { mint: SOL_PAIR_MINT, name: 'Solana', ticker: 'SOL', decimals: 9 };

// The HTTP catalog supplies labels only. The server intersects it with Pump's
// on-chain quote allowlist; a ticker never identifies a mint or grants admission.
export function validLaunchPairs(value: unknown): value is LaunchPairs {
  if (!value || typeof value !== 'object') return false;
  const v = value as LaunchPairs;
  return Number.isSafeInteger(v.checkedAt) && v.checkedAt > 0 && Array.isArray(v.pairs) && v.pairs.length > 0 && v.pairs.length <= 256 &&
    new Set(v.pairs.map(p => p?.mint)).size === v.pairs.length && v.pairs.every(p => p && isMint(p.mint) &&
      typeof p.name === 'string' && p.name.length > 0 && p.name.length <= 100 && !/[\u0000-\u001f\u007f]/.test(p.name) &&
      typeof p.ticker === 'string' && p.ticker.length > 0 && p.ticker.length <= 40 && !/[\u0000-\u001f\u007f]/.test(p.ticker) &&
      Number.isInteger(p.decimals) && p.decimals >= 0 && p.decimals <= 18 &&
      (p.source === undefined || ['sol','global','quoteControl','pumpCoin'].includes(p.source)) &&
      (p.stage === undefined || ['curve','pool'].includes(p.stage))) &&
    v.pairs.some(p => p.mint === SOL_PAIR_MINT && p.decimals === 9 && p.ticker === 'SOL');
}

export function validResolvedLaunchPair(value: unknown, mint: string): value is { checkedAt: number; pair: LaunchPair } {
  if (!value || typeof value !== 'object') return false;
  const v = value as { checkedAt: number; pair: LaunchPair };
  return v.pair?.mint === mint && mint !== SOL_PAIR_MINT && validLaunchPairs({ checkedAt: v.checkedAt, pairs: [SOL_PAIR, v.pair] });
}

export function pairAmount(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw Error('Invalid pair decimals.');
  if (value === '') return 0n;
  if (!/^(0|[1-9][0-9]{0,19})(\.[0-9]{1,18})?$/.test(value)) throw Error('Use a decimal amount without commas or exponents.');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw Error(`This pair supports up to ${decimals} decimal places.`);
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (raw > 18446744073709551615n) throw Error('Initial buy exceeds the token amount limit.');
  return raw;
}

export const CUSTOM_PAIR_BLOCKER = 'Custom-pair launches are not activated. Quote-asset spending, fee payouts and conversion into Fub must pass verification first.';
