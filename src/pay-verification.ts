import bs58 from "bs58";
import { isMint } from "./assets.js";
import { USDC } from "./funding-model.js";
import { payShares } from "./pay-model.js";
import type { PayRequest } from "./pay-model.js";

export type PayTerms = {
  id: string;
  kind: "split" | "treat";
  recipient: string;
  cents: number;
  people: number;
  index: number;
};
export type GiftPaymentTerms = { id: string; kind: "gift-card"; recipient: string; rawAmount: string };
export type TransferTerms = PayTerms | GiftPaymentTerms;
export function validTransferTerms(t: TransferTerms): boolean {
  if (t?.kind !== "gift-card") return validPayTerms(t as PayTerms);
  return Object.keys(t).sort().join(",") === "id,kind,rawAmount,recipient" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(t.id) &&
    isMint(t.recipient) && typeof t.rawAmount === "string" && /^[1-9][0-9]{0,9}$/.test(t.rawAmount) && BigInt(t.rawAmount) <= 1000000000n;
}
export type PaymentReceipt = {
  status: "verified";
  signature: string;
  reference: string;
  recipient: string;
  sender: string;
  mint: string;
  rawAmount: string;
  slot: number;
  blockTime: number | null;
};
export type PaymentCheck =
  | PaymentReceipt
  | {
      status: "pending" | "unverified" | "failed";
      message: string;
    };
export function validPayTerms(t: PayTerms): boolean {
  return (
    !!t &&
    Object.keys(t).sort().join(",") ===
      "cents,id,index,kind,people,recipient" &&
    typeof t.id === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      t.id,
    ) &&
    ["split", "treat"].includes(t.kind) &&
    typeof t.recipient === "string" &&
    isMint(t.recipient) &&
    Number.isSafeInteger(t.cents) &&
    t.cents >= t.people &&
    t.cents <= 100000000 &&
    Number.isInteger(t.people) &&
    t.people >= (t.kind === "split" ? 2 : 1) &&
    t.people <= (t.kind === "split" ? 8 : 1) &&
    Number.isInteger(t.index) &&
    t.index >= (t.kind === "split" ? 1 : 0) &&
    t.index < t.people
  );
}
export function paymentTerms(r: PayRequest, index: number): PayTerms {
  const t = {
    id: r.id,
    kind: r.kind,
    recipient: r.recipient,
    cents: r.cents,
    people: r.names.length,
    index,
  };
  if (r.version !== 2 || !validPayTerms(t))
    throw Error("This request does not support payment verification.");
  return t;
}
export function paymentRawAmount(t: TransferTerms): string {
  if (!validTransferTerms(t)) throw Error("Invalid payment terms.");
  if (t.kind === "gift-card") return t.rawAmount;
  return String(BigInt(payShares(t.cents, t.people)[t.index]) * 10000n);
}
export async function paymentReference(t: TransferTerms): Promise<string> {
  if (!validTransferTerms(t)) throw Error("Invalid payment terms.");
  // Bind one share to its exact payment terms. Names and private messages are
  // neither sent to the verifier nor written into transaction memos.
  const payload = JSON.stringify(t.kind === "gift-card" ? ["fub:bitrefill:usdc:v1", t.id, t.recipient, USDC, t.rawAmount] : [
    "fomo-pay:usdc:v2",
    t.id,
    t.kind,
    t.recipient,
    USDC,
    t.cents,
    t.people,
    t.index,
  ]);
  return bs58.encode(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)),
    ),
  );
}
export function validPaymentSignature(value: string): boolean {
  try {
    return (
      typeof value === "string" &&
      /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value) &&
      bs58.decode(value).length === 64
    );
  } catch {
    return false;
  }
}
