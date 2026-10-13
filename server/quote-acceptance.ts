import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';

// Acceptance enables a real, narrowly scoped test without claiming that a
// funded receipt has already been verified. Expiry stops sends, not recovery.
export type QuoteAcceptance = { quoteMint: string; treasury: string; startsAt: number; expiresAt: number };
export function quoteAcceptance(raw: string | undefined, treasury: string | undefined): QuoteAcceptance | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as QuoteAcceptance;
    if (!p || Object.keys(p).sort().join() !== 'expiresAt,quoteMint,startsAt,treasury' ||
        ![p.startsAt, p.expiresAt].every(v => Number.isSafeInteger(v) && v > 0) ||
        p.expiresAt <= p.startsAt || p.expiresAt - p.startsAt > 72 * 3600000 ||
        p.treasury !== treasury || new PublicKey(p.treasury).toBase58() !== p.treasury ||
        !PublicKey.isOnCurve(new PublicKey(p.treasury).toBytes()) ||
        new PublicKey(p.quoteMint).toBase58() !== p.quoteMint ||
        [p.treasury, NATIVE_MINT.toBase58()].includes(p.quoteMint)) throw Error();
    return p;
  } catch { throw Error('Invalid quote acceptance policy.'); }
}
export function quoteAcceptanceAllows(p: QuoteAcceptance, quoteMint: string, treasury: string, now = Date.now()) {
  return p.quoteMint === quoteMint && p.treasury === treasury && now >= p.startsAt && now < p.expiresAt;
}
