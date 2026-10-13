import { createRequire } from 'node:module';
import { Connection } from '@solana/web3.js';
import { SOL_PAIR, validLaunchPairs } from '../src/launch-pairs.js';
import type { LaunchPair, LaunchPairs } from '../src/launch-pairs.js';
import { MAINNET_GENESIS } from './solana-network.js';
const require = createRequire(import.meta.url);
const { OnlinePumpSdk } = require('@pump-fun/pump-sdk') as typeof import('@pump-fun/pump-sdk');
const CATALOG = 'https://blockchain-swap.pump.fun/supported/coin-create-mints';

export function intersectLaunchPairs(labels: unknown, admitted: ReadonlySet<string>): LaunchPair[] {
  if (!Array.isArray(labels) || !labels.length || labels.length > 256) throw Error('Invalid Pump pair catalog.');
  const pairs = [SOL_PAIR], seen = new Set([SOL_PAIR.mint]);
  for (const row of labels) {
    if (!row || typeof row !== 'object' || typeof row.mint !== 'string' || seen.has(row.mint) || !admitted.has(row.mint)) continue;
    const pair = { mint: row.mint, name: row.symbol, ticker: row.ticker, decimals: row.decimals };
    if (!validLaunchPairs({ checkedAt: 1, pairs: [SOL_PAIR, pair] })) throw Error('Invalid Pump pair metadata.');
    pairs.push(pair); seen.add(pair.mint);
  }
  return pairs;
}

// Single flight and bounded caching keep opening the selector inexpensive.
// A failed refresh never returns an expired allowlist as current.
export function launchPairsService(load: () => Promise<LaunchPair[]>, now = Date.now) {
  let cached: LaunchPairs | null = null, pending: Promise<LaunchPairs> | null = null;
  return async (): Promise<LaunchPairs> => {
    if (cached && now() - cached.checkedAt < 60000) return structuredClone(cached);
    if (!pending) pending = load().then(pairs => {
      const next = { checkedAt: now(), pairs };
      if (!validLaunchPairs(next)) throw Error('Pair catalog unavailable.');
      cached = next; return next;
    }).finally(() => { pending = null; });
    return structuredClone(await pending);
  };
}

export const getLaunchPairs = launchPairsService(async () => {
  if (!process.env.SOLANA_RPC_URL) throw Error('Pair RPC unavailable.');
  const connection = new Connection(process.env.SOLANA_RPC_URL, { commitment: 'confirmed', disableRetryOnRateLimit: true,
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(8000) }) });
  if (await connection.getGenesisHash() !== MAINNET_GENESIS) throw Error('Mainnet required.');
  const [response, admitted] = await Promise.all([
    fetch(CATALOG, { signal: AbortSignal.timeout(8000), redirect: 'error' }),
    new OnlinePumpSdk(connection).fetchSupportedQuoteMints(),
  ]);
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > 131072) throw Error('Pair catalog unavailable.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length;
      if (size > 131072) throw Error('Pair catalog too large.'); chunks.push(value); }
  } finally { await reader.cancel(); }
  return intersectLaunchPairs(JSON.parse(Buffer.concat(chunks).toString('utf8')), new Set(admitted.map(p => p.mint.toBase58())));
});
