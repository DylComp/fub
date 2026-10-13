import { createHash, createPublicKey, verify } from "node:crypto";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";
import canonicalize from "canonicalize";
import { rawLamports } from "./launch-payout-model.js";
export type BuybackPolicy = {
  purpose?: "engineering";
  acceptanceRoute?: "pump-amm";
  treasury: string;
  mint: string;
  maxInput: string;
  maxOverhead: string;
  dailyCap: string;
  slippageBps: number;
};
export type BuybackPlan = {
  version: 1;
  route?: "pump-curve" | "pump-amm";
  ammVersion?: 2;
  policy: BuybackPolicy;
  unsigned: string;
  inputCap: string;
  tokens: string;
  decimals: number;
  tokenProgram: string;
  creator: string;
  feeRecipient: string;
  buybackFeeRecipient: string;
  lastValidBlockHeight: number;
  contextSlot: number;
  preparedAt: number;
  fee: string;
};
export type BuybackAttempt = {
  id: string;
  plan: BuybackPlan;
  signed: string;
  signature: string;
};
export type BuybackReceipt = {
  slot: number;
  debit: string;
  networkFee: string;
  burned: string;
  success: boolean;
};
export type BuybackClaim = {
  lease: string;
  policy: BuybackPolicy;
  enabled: boolean;
  available: string;
  attempt: BuybackAttempt | null;
};
export function validateBuybackPolicy(p: BuybackPolicy) {
  for (const a of [p.treasury, p.mint]) {
    const key = new PublicKey(a);
    if (key.toBase58() !== a || !PublicKey.isOnCurve(key.toBytes()))
      throw Error("Invalid buyback address");
  }
  if (
    (p.purpose !== undefined && p.purpose !== "engineering") ||
    (p.acceptanceRoute !== undefined && (p.purpose !== "engineering" || p.acceptanceRoute !== "pump-amm")) ||
    p.treasury === p.mint ||
    rawLamports(p.maxInput) < 1000000n ||
    rawLamports(p.maxInput) > 10000000000n ||
    rawLamports(p.maxOverhead) < 5000n ||
    rawLamports(p.maxOverhead) > 10000000n ||
    rawLamports(p.dailyCap) <
      rawLamports(p.maxInput) + rawLamports(p.maxOverhead) ||
    !Number.isInteger(p.slippageBps) ||
    p.slippageBps < 0 ||
    p.slippageBps > 500
  )
    throw Error("Invalid buyback limits");
}
export const buybackPolicyId = (p: BuybackPolicy) => {
  validateBuybackPolicy(p);
  return createHash("sha256").update(canonicalize(p)!).digest("hex");
};
export const buybackReservation = (p: BuybackPlan) =>
  (rawLamports(p.inputCap) + rawLamports(p.policy.maxOverhead)).toString();
export function validateBuybackPlan(p: BuybackPlan) {
  validateBuybackPolicy(p.policy);
  if (
    p.version !== 1 ||
    (p.route !== undefined && !["pump-curve", "pump-amm"].includes(p.route)) ||
    (p.policy.acceptanceRoute !== undefined && p.route !== p.policy.acceptanceRoute) ||
    rawLamports(p.tokens) > 18446744073709551615n ||
    rawLamports(p.inputCap) < 1n ||
    rawLamports(p.inputCap) > rawLamports(p.policy.maxInput) ||
    rawLamports(p.tokens) < 1n ||
    rawLamports(p.fee) < 5000n ||
    rawLamports(p.fee) > rawLamports(p.policy.maxOverhead) ||
    !Number.isInteger(p.decimals) ||
    p.decimals < 0 ||
    p.decimals > 9 ||
    ![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(
      p.tokenProgram,
    ) ||
    ![p.lastValidBlockHeight, p.contextSlot, p.preparedAt].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) ||
    p.unsigned.length > 1644
  )
    throw Error("Invalid buyback plan");
  for (const a of [p.creator, p.feeRecipient, p.buybackFeeRecipient])
    if (new PublicKey(a).toBase58() !== a)
      throw Error("Invalid buyback destination");
  if ([p.feeRecipient, p.buybackFeeRecipient].includes(p.policy.treasury))
    throw Error("Treasury cannot receive its own protocol fees");
}
export function buybackId(plan: BuybackPlan) {
  validateBuybackPlan(plan);
  return createHash("sha256").update(canonicalize(plan)!).digest("hex");
}
export function verifyBuybackSigned(plan: BuybackPlan, signed: string) {
  validateBuybackPlan(plan);
  if (signed.length > 1644) throw Error("Invalid signed buyback");
  const tx = VersionedTransaction.deserialize(Buffer.from(signed, "base64")),
    original = VersionedTransaction.deserialize(
      Buffer.from(plan.unsigned, "base64"),
    );
  if (
    Buffer.from(tx.serialize()).toString("base64") !== signed ||
    tx.message.header.numRequiredSignatures !== 1 ||
    tx.message.addressTableLookups.length ||
    tx.message.staticAccountKeys[0].toBase58() !== plan.policy.treasury ||
    !Buffer.from(tx.message.serialize()).equals(
      Buffer.from(original.message.serialize()),
    )
  )
    throw Error("Signed buyback changed reviewed bytes");
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      new PublicKey(plan.policy.treasury).toBuffer(),
    ]),
    format: "der",
    type: "spki",
  });
  if (!verify(null, tx.message.serialize(), key, tx.signatures[0]))
    throw Error("Invalid buyback signature");
  return bs58.encode(tx.signatures[0]);
}
