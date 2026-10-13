import { PublicKey } from "@solana/web3.js";
export type PayoutPilot = { mint: string; payer: string; expiresAt: number };

export function payoutPilotPolicy(value: string | undefined, payer: string, now = Date.now()): PayoutPilot | undefined {
  if (!value) return undefined;
  let p: PayoutPilot;
  try {
    p = JSON.parse(value);
    if (!p || Object.keys(p).sort().join() !== "expiresAt,mint,payer" || p.payer !== payer ||
      p.mint === payer || new PublicKey(p.mint).toBase58() !== p.mint || !PublicKey.isOnCurve(new PublicKey(p.mint).toBytes()) ||
      !Number.isSafeInteger(p.expiresAt) || p.expiresAt <= 0 || p.expiresAt > now + 86400000) throw Error();
  } catch { throw Error("Invalid one-distribution pilot policy."); }
  // Keep expired policies readable so pending receipts can still reconcile.
  // Admission, reservation and submission all check the database clock.
  return p;
}
