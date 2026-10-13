import { createPublicKey, verify } from "node:crypto";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { launchShares } from "../src/launch-model.js";

export type PayoutRoute = { mint: string; recipient: string; buybackWallet: string; kind?: "launchpad" | "official" };
export type PayoutPlan = { unsigned: string; lastValidBlockHeight: number; feeLamports: string };
export type PayoutAttempt = PayoutPlan & { id: string; signed: string; signature: string; payer: string };
export type PayoutReceipt = { slot: number; recipientLamports: string; buybackLamports: string; networkFeeLamports: string };
export type PayoutClaim = PayoutRoute & { lease: string; enabled: boolean; attempt: PayoutAttempt | null };
export type PayoutOutcome = "below_threshold" | "submitted" | "pending" | "expired_unresolved" | "confirmed" | "failed" | "retry" | "paused" | "budget_exhausted";
export const PAYOUT_CHECK_SECONDS = 60;
// The first Pump shareholder always owns 80%; route fields retain their meaning:
// recipient is the Fomo recipient or development wallet, buybackWallet is treasury.
export function payoutDestinations(r: PayoutRoute) {
  if(r.kind !== undefined && !['launchpad','official'].includes(r.kind))throw Error('Invalid payout source.');
  return r.kind==='official'?{recipient:r.buybackWallet,buybackWallet:r.recipient}:{recipient:r.recipient,buybackWallet:r.buybackWallet};
}
export function validatePayoutAmounts(r:PayoutRoute,recipient:string,buyback:string){
  payoutDestinations(r);
  const a=rawLamports(recipient),b=rawLamports(buyback),major=r.kind==='official'?b:a,minor=r.kind==='official'?a:b;
  if(major<minor*4n||major>minor*4n+3n)throw Error('Unexpected actual 80/20 proceeds.');
}
export function validatePayoutRoute(r: PayoutRoute, payer?: string) {
  payoutDestinations(r);
  launchShares(r.recipient, r.buybackWallet);
  const keys = [r.mint, r.recipient, r.buybackWallet, ...(payer ? [payer] : [])];
  if (new Set(keys).size !== keys.length) throw Error("Payout mint, recipients and fee payer must be distinct.");
  for (const value of keys) {
    const key = new PublicKey(value);
    if (key.toBase58() !== value || !PublicKey.isOnCurve(key.toBytes())) throw Error("Invalid payout address.");
  }
}
export function rawLamports(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > 18446744073709551615n) throw Error("Invalid lamport amount.");
  return BigInt(value);
}
export function verifyPayoutSignature(plan: PayoutPlan, signed: string, payer: string) {
  if (!Number.isSafeInteger(plan.lastValidBlockHeight) || plan.lastValidBlockHeight <= 0 || rawLamports(plan.feeLamports) <= 0n) throw Error("Invalid payout lifetime or fee.");
  if (signed.length > 1644 || plan.unsigned.length > 1644) throw Error("Payout packet too large.");
  const original = VersionedTransaction.deserialize(Buffer.from(plan.unsigned, "base64"));
  const tx = VersionedTransaction.deserialize(Buffer.from(signed, "base64"));
  if (Buffer.from(tx.serialize()).toString("base64") !== signed || tx.serialize().length > 1232 ||
      tx.message.header.numRequiredSignatures !== 1 || tx.message.addressTableLookups.length ||
      tx.message.staticAccountKeys[0].toBase58() !== payer ||
      !Buffer.from(tx.message.serialize()).equals(Buffer.from(original.message.serialize()))) throw Error("Payout signature changed the reviewed transaction.");
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), new PublicKey(payer).toBuffer()]), format: "der", type: "spki" });
  if (!verify(null, tx.message.serialize(), key, tx.signatures[0])) throw Error("Invalid payout signature.");
  return bs58.encode(tx.signatures[0]);
}
