import { createRequire } from 'node:module';
import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackMint, unpackAccount, getExtensionTypes, ExtensionType } from '@solana/spl-token';
import { isMint } from '../src/assets.js';
import { SOL_PAIR_MINT, validResolvedLaunchPair, type LaunchPair } from '../src/launch-pairs.js';
import { MAINNET_GENESIS } from './solana-network.js';
const require = createRequire(import.meta.url);
const sdk = require('@pump-fun/pump-sdk-next') as typeof import('@pump-fun/pump-sdk-next');

export class PairUnavailable extends Error {
  constructor(public readonly code: 'invalid_mint'|'unsupported_pair'|'mayhem_pair'|'nested_pair'|'migration_pending'|'unavailable', message: string) { super(message); }
}
export function pairFailure(error: unknown): PairUnavailable {
  if (error instanceof PairUnavailable) return error;
  if (error instanceof sdk.CurveDepthExceededError) return new PairUnavailable('nested_pair', 'This coin is already paired with another Pump coin. Pump does not accept it as a pair.');
  if (error instanceof sdk.QuoteCurveAwaitingMigrationError || error instanceof sdk.QuotePoolNotFoundError) return new PairUnavailable('migration_pending', 'This coin is graduating. Check again once its PumpSwap pool is ready.');
  if (error instanceof sdk.QuoteBondingCurveNotEligibleError) return new PairUnavailable('unsupported_pair', 'Pump does not currently accept this coin as a pair. Mayhem coins and unsupported underlying pairs are excluded.');
  if (error instanceof sdk.UnsupportedQuoteMintError || error instanceof sdk.QuoteReservesOutOfRangeError) return new PairUnavailable('unsupported_pair', 'Pump cannot use this mint as a pair. Check the token address.');
  return new PairUnavailable('unavailable', 'The pair could not be verified right now. Try again shortly.');
}

// Labels never admit a pair. Resolve from mainnet accounts, and independently
// check the quote mint and canonical pool before using any returned reserves.
export async function resolvePumpQuote(connection: Connection, mint: string) {
  if (!isMint(mint) || mint === SOL_PAIR_MINT) throw new PairUnavailable('invalid_mint', 'Paste the token’s Solana mint address.');
  if (await connection.getGenesisHash() !== MAINNET_GENESIS) throw Error('Mainnet required.');
  const key = new PublicKey(mint), online = new sdk.OnlinePumpSdk(connection);
  const headers = await connection.getMultipleAccountsInfo([sdk.GLOBAL_PDA, sdk.QUOTE_CONTROL_PDA, key]);
  if (!headers[0]?.owner.equals(sdk.PUMP_PROGRAM_ID) || headers[0].executable ||
    (headers[1] && (!headers[1].owner.equals(sdk.PUMP_PROGRAM_ID) || headers[1].executable))) throw Error('Invalid quote admission accounts.');
  const info = headers[2];
  if (!info || info.executable || ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some(p => info.owner.equals(p))) throw new PairUnavailable('unsupported_pair', 'That address is not a supported token mint.');
  const token = unpackMint(key, info, info.owner);
  if (!token.isInitialized) throw new PairUnavailable('unsupported_pair', 'That token is not initialized.');
  if (getExtensionTypes(token.tlvData).some(t => ![ExtensionType.MetadataPointer, ExtensionType.TokenMetadata].includes(t))) throw new PairUnavailable('unsupported_pair', 'This token has extensions that Fub cannot yet use for automatic fee payouts.');
  const quote = await online.resolveQuoteMint(key);
  if (!quote.mint.equals(key) || !quote.quoteTokenProgram.equals(info.owner) || quote.decimals !== token.decimals || quote.initialVirtualQuoteReserves.lten(0)) throw Error('Quote mint mismatch.');
  if (quote.source === 'pumpCoin') {
    if (!quote.pumpQuote || !quote.pumpQuote.curve.mint.equals(key)) throw Error('Missing Pump quote evidence.');
    const curve = quote.pumpQuote.curve.bondingCurve;
    if (curve.isMayhemMode) throw new PairUnavailable('mayhem_pair', 'Pump does not allow Mayhem coins as pair assets.');
    if (curve.depth > 0) throw new PairUnavailable('nested_pair', 'This coin is already paired with a Pump coin. Choose a coin paired with SOL, USDC or a listed asset.');
    const accounts = quote.pumpQuote.accounts.pool;
    if (accounts) {
      const underlying = sdk.normalizeQuoteMint(curve.quoteMint);
      if (!accounts.pool.equals(sdk.canonicalPumpPoolPdaWithQuote(key, underlying))) throw Error('Noncanonical quote pool.');
      const [poolInfo, baseInfo, quoteInfo] = await connection.getMultipleAccountsInfo([accounts.pool, accounts.baseVault, accounts.quoteVault]);
      if (!poolInfo || poolInfo.executable || !poolInfo.owner.equals(sdk.PUMP_AMM_PROGRAM_ID) || !baseInfo || !quoteInfo) throw Error('Quote pool unavailable.');
      const program = sdk.getPumpAmmProgram(connection);
      const pool = program.coder.accounts.decode('pool', Buffer.concat([poolInfo.data, Buffer.alloc(Math.max(0, program.account.pool.size - poolInfo.data.length))]));
      if (!pool.baseMint.equals(key) || !pool.quoteMint.equals(underlying) || !pool.poolBaseTokenAccount.equals(accounts.baseVault) || !pool.poolQuoteTokenAccount.equals(accounts.quoteVault)) throw Error('Quote pool asset mismatch.');
      for (const [address, account, expectedMint] of [[accounts.baseVault, baseInfo, key], [accounts.quoteVault, quoteInfo, underlying]] as const) {
        const vault = unpackAccount(address, account, account.owner);
        if (account.executable || ![TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID].some(p=>p.equals(account.owner)) || !vault.owner.equals(accounts.pool) || !vault.mint.equals(expectedMint) || !vault.isInitialized || vault.isFrozen) throw Error('Quote pool vault mismatch.');
      }
    }
  }
  return { ...quote, quoteControl: headers[1] ? sdk.PUMP_SDK.decodeQuoteControl(headers[1]) : null };
}

export function pumpPairService(load: (mint: string) => Promise<LaunchPair>, now = Date.now) {
  const pending = new Map<string, Promise<{ checkedAt: number; pair: LaunchPair }>>();
  const cached = new Map<string, { checkedAt: number; pair: LaunchPair }>();
  return async (mint: string) => {
    if (!isMint(mint) || mint === SOL_PAIR_MINT) throw new PairUnavailable('invalid_mint', 'Paste the token’s Solana mint address.');
    const hit = cached.get(mint);
    if (hit && now() - hit.checkedAt < 15000) return structuredClone(hit);
    if (!pending.has(mint)) {
      if (pending.size >= 3) throw new PairUnavailable('unavailable', 'Pair checks are busy. Try again shortly.');
      const task = load(mint).then(pair => {
        const result = { checkedAt: now(), pair };
        if (!validResolvedLaunchPair(result, mint)) throw Error('Invalid pair result.');
        if (cached.size >= 128) cached.delete(cached.keys().next().value!);
        cached.set(mint, result); return result;
      }).finally(() => pending.delete(mint));
      pending.set(mint, task);
    }
    return structuredClone(await pending.get(mint)!);
  };
}

export const getPumpPair = pumpPairService(async mint => {
  if (!process.env.SOLANA_RPC_URL) throw new PairUnavailable('unavailable', 'Pair lookup is temporarily unavailable.');
  const c = new Connection(process.env.SOLANA_RPC_URL, { commitment: 'finalized', disableRetryOnRateLimit: true, fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(8000) }) });
  const q = await resolvePumpQuote(c, mint);
  // Pump metadata is optional display information. No external metadata URLs
  // are fetched, and a failed/mismatched response cannot replace the mint.
  let name = `${mint.slice(0,6)}…${mint.slice(-4)}`, ticker = 'TOKEN';
  try {
    const response = await fetch(`https://frontend-api-v3.pump.fun/coins-v2/${mint}`, { signal: AbortSignal.timeout(4000), redirect: 'error' });
    if (response.ok && response.body && Number(response.headers.get('content-length')) <= 65536) {
      const reader = response.body.getReader(); let size = 0; const parts: Uint8Array[] = [];
      try { for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > 65536) throw Error('Metadata too large'); parts.push(item.value); } } finally { await reader.cancel(); }
      const data = JSON.parse(Buffer.concat(parts).toString('utf8'));
      if (data.mint === mint && typeof data.name === 'string' && typeof data.symbol === 'string' && data.name.length > 0 && data.name.length <= 100 && data.symbol.length > 0 && data.symbol.length <= 40 && !/[\u0000-\u001f\u007f]/.test(data.name + data.symbol)) { name = data.name; ticker = data.symbol; }
    }
  } catch { /* An address remains usable when optional labels are unavailable. */ }
  return { mint, name, ticker, decimals: q.decimals, source: q.source, ...(q.pumpQuote ? { stage: q.pumpQuote.accounts.pool ? 'pool' as const : 'curve' as const } : {}) };
});
