import { ADDRESSES, isMint } from '../src/assets.js';
import type { WalletMovement, WalletTransaction } from '../src/portfolio-data.js';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SWAPS = new Set(['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK']);
type Balance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } };
type ParsedTransaction = { transaction?: { signatures?: string[]; message?: { accountKeys?: Array<string | { pubkey: string; signer?: boolean }>; instructions?: Array<{ programId?: string }> } }; meta?: { err: unknown; fee: number; preBalances: number[]; postBalances: number[]; preTokenBalances?: Balance[]; postTokenBalances?: Balance[]; innerInstructions?: Array<{ instructions: Array<{ programId?: string }> }> } };
export function walletTransactionDetails(raw: unknown, owner: string, signature: string): Pick<WalletTransaction, 'kind' | 'movements' | 'feeLamports' | 'detailsAvailable'> {
  const tx = raw as ParsedTransaction | null;
  const meta = tx?.meta, message = tx?.transaction?.message;
  if (!meta || !message || tx?.transaction?.signatures?.[0] !== signature || !Number.isSafeInteger(meta.fee) || meta.fee < 0) throw Error('Transaction details unavailable');
  if (meta.err !== null) return { kind: 'failed', movements: [], feeLamports: String(meta.fee), detailsAvailable: true };
  const keys = (message.accountKeys || []).map(k => typeof k === 'string' ? k : k.pubkey);
  const ownerIndex = keys.indexOf(owner);
  if (ownerIndex < 0 || keys.length !== meta.preBalances.length || keys.length !== meta.postBalances.length) throw Error('Wallet missing from transaction');
  const ownedIndexes = new Set([ownerIndex]);
  const amounts = new Map<string, { amount: bigint; decimals: number }>();
  for (const [side, balances] of [[-1n, meta.preTokenBalances || []], [1n, meta.postTokenBalances || []]] as const) {
    for (const b of balances) {
      if (b.owner !== owner) continue;
      if (!isMint(b.mint) || !Number.isInteger(b.accountIndex) || b.accountIndex < 0 || b.accountIndex >= keys.length || !/^\d{1,20}$/.test(b.uiTokenAmount?.amount || '') || !Number.isInteger(b.uiTokenAmount.decimals) || b.uiTokenAmount.decimals < 0 || b.uiTokenAmount.decimals > 255) throw Error('Malformed token balance');
      ownedIndexes.add(b.accountIndex);
      if (b.mint === ADDRESSES.SOL) continue; // wSOL is counted once, in account lamports below.
      const old = amounts.get(b.mint);
      if (old && old.decimals !== b.uiTokenAmount.decimals) throw Error('Conflicting token decimals');
      amounts.set(b.mint, { amount: (old?.amount || 0n) + side * BigInt(b.uiTokenAmount.amount), decimals: b.uiTokenAmount.decimals });
    }
  }
  // Include owned token-account rent so opening/closing an ATA is not a purchase/sale.
  let sol = ownerIndex === 0 ? BigInt(meta.fee) : 0n;
  for (const i of ownedIndexes) {
    if (![meta.preBalances[i], meta.postBalances[i]].every(v => Number.isSafeInteger(v) && v >= 0)) throw Error('Unsafe native amount');
    sol += BigInt(meta.postBalances[i]) - BigInt(meta.preBalances[i]);
  }
  const movements: WalletMovement[] = [...amounts].filter(([, v]) => v.amount !== 0n).map(([mint, v]) => ({ mint, rawAmount: String(v.amount < 0n ? -v.amount : v.amount), decimals: v.decimals, direction: v.amount < 0n ? 'out' : 'in', chain: 'solana' }));
  if (sol) movements.push({ mint: ADDRESSES.SOL, rawAmount: String(sol < 0n ? -sol : sol), decimals: 9, direction: sol < 0n ? 'out' : 'in', symbol: 'SOL', name: 'Solana', image: '/tokens/sol.png', chain: 'solana' });
  const invoked = [...(message.instructions || []), ...(meta.innerInstructions || []).flatMap(group => group.instructions)];
  const swap = invoked.some(ix => SWAPS.has(ix.programId || ''));
  const incoming = movements.filter(m => m.direction === 'in'), outgoing = movements.filter(m => m.direction === 'out');
  const quote = (m: WalletMovement) => [ADDRESSES.SOL, USDC].includes(m.mint);
  const kind = swap && incoming.length === 1 && outgoing.length === 1
    ? quote(outgoing[0]) && !quote(incoming[0]) ? 'buy' : quote(incoming[0]) && !quote(outgoing[0]) ? 'sell' : 'swap'
    : incoming.length && !outgoing.length ? 'receive' : outgoing.length && !incoming.length ? 'send' : 'activity';
  return { kind, movements, feeLamports: String(meta.fee), detailsAvailable: true };
}
