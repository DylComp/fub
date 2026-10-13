import { address, getAddressEncoder, getProgramDerivedAddress, getCompiledTransactionMessageEncoder, getTransactionEncoder, getTransactionDecoder, getCompiledTransactionMessageDecoder, type Transaction } from "@solana/kit";
import bs58 from "bs58";
import { associated, fromBase64, toBase64 } from "./transaction-review.js";
import { isMint } from "./assets.js";
import { USDC, TOKEN_PROGRAM } from "./funding-model.js";

export const BRIDGE_CARD_PROGRAM = "cardWArqhdV5jeRXXjUti7cHAa4mj41Nj3Apc6RPZH2";
const COMPUTE = "ComputeBudget111111111111111111111111111111";
export const CARD_ALLOWANCE_MAX_CENTS = 100000; // Initial product cap: 1,000 USDC, never unlimited.
export type CardAllowanceIntent = { wallet: string; merchantId: string; action: "approve" | "revoke"; cents: number };
export type CardAllowanceReview = CardAllowanceIntent & { source: string; delegate: string; blockhash: string; lastValidBlockHeight: number; slot: number; expiresAt: number; feeLamports: string; unsigned: string };
export type CardWalletSnapshot = {
  wallet: string; source: string; slot: number; fetchedAt: number; solLamports: string; usdcRaw: string;
  account: "missing" | "ready" | "frozen"; delegate: string | null; allowanceRaw: string;
  cardDelegate: string | null; cardRegistered: boolean; merchantId: string | null;
};
export function validMerchantId(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n;
}
export async function cardAddresses(wallet: string, merchantId: string) {
  if (!isMint(wallet) || !validMerchantId(merchantId)) throw Error("Card wallet or merchant configuration is invalid.");
  const source = await associated(wallet, USDC), encoder = getAddressEncoder();
  const merchant = new Uint8Array(8); new DataView(merchant.buffer).setBigUint64(0, BigInt(merchantId), true);
  const [delegate] = await getProgramDerivedAddress({ programAddress: address(BRIDGE_CARD_PROGRAM),
    seeds: [new TextEncoder().encode("user_delegate"), merchant, encoder.encode(address(USDC)), encoder.encode(address(source))] });
  return { source, delegate: String(delegate) };
}
export async function cardAllowanceTransaction(intent: CardAllowanceIntent, blockhash: string): Promise<string> {
  if (!isMint(blockhash) || !["approve", "revoke"].includes(intent.action) || !Number.isSafeInteger(intent.cents) ||
      (intent.action === "approve" ? intent.cents < 1 || intent.cents > CARD_ALLOWANCE_MAX_CENTS : intent.cents !== 0)) throw Error("Choose a bounded card allowance.");
  const { source, delegate } = await cardAddresses(intent.wallet, intent.merchantId), approve = intent.action === "approve";
  const accounts = approve ? [intent.wallet, source, USDC, delegate, TOKEN_PROGRAM, COMPUTE] : [intent.wallet, source, TOKEN_PROGRAM, COMPUTE];
  if (new Set(accounts).size !== accounts.length) throw Error("Card accounts overlap.");
  const limit = new Uint8Array(5); limit[0] = 2; new DataView(limit.buffer).setUint32(1, 25000, true);
  const price = new Uint8Array(9); price[0] = 3; new DataView(price.buffer).setBigUint64(1, 5000n, true);
  const data = new Uint8Array(approve ? 10 : 1); data[0] = approve ? 13 : 5; // ApproveChecked / Revoke.
  if (approve) { new DataView(data.buffer).setBigUint64(1, BigInt(intent.cents) * 10000n, true); data[9] = 6; }
  const messageBytes = getCompiledTransactionMessageEncoder().encode({ version: 0,
    header: { numSignerAccounts: 1, numReadonlySignerAccounts: 0, numReadonlyNonSignerAccounts: accounts.length - 2 },
    staticAccounts: accounts.map(address), lifetimeToken: blockhash,
    instructions: [
      { programAddressIndex: accounts.length - 1, accountIndices: [], data: limit },
      { programAddressIndex: accounts.length - 1, accountIndices: [], data: price },
      { programAddressIndex: accounts.length - 2, accountIndices: approve ? [1, 2, 3, 0] : [1, 0], data },
    ], addressTableLookups: [],
  });
  return toBase64(new Uint8Array(getTransactionEncoder().encode({ messageBytes, signatures: { [intent.wallet]: null } } as Transaction)));
}
export async function inspectCardAllowance(review: CardAllowanceReview, expected: CardAllowanceIntent, signed?: string) {
  if (["wallet", "merchantId", "action", "cents"].some(k => review[k as keyof CardAllowanceIntent] !== expected[k as keyof CardAllowanceIntent]) ||
      ![review.slot, review.lastValidBlockHeight, review.expiresAt].every(x => Number.isSafeInteger(x) && x > 0) ||
      !/^\d{1,5}$/.test(review.feeLamports) || BigInt(review.feeLamports) < 5125n || BigInt(review.feeLamports) > 10000n) throw Error("Card allowance review does not match.");
  if (review.expiresAt <= Date.now() || review.expiresAt > Date.now() + 60000) throw Error("Card allowance review expired. Prepare it again.");
  const derived = await cardAddresses(expected.wallet, expected.merchantId);
  if (derived.source !== review.source || derived.delegate !== review.delegate) throw Error("Card delegate does not match this wallet and program.");
  const rebuilt = await cardAllowanceTransaction(expected, review.blockhash);
  if (rebuilt !== review.unsigned) throw Error("Unexpected card approval instructions.");
  const tx = getTransactionDecoder().decode(fromBase64(signed ?? review.unsigned));
  if (toBase64(new Uint8Array(getTransactionEncoder().encode(tx))) !== (signed ?? review.unsigned)) throw Error("Invalid card transaction encoding.");
  const before = getTransactionDecoder().decode(fromBase64(rebuilt));
  if (toBase64(new Uint8Array(tx.messageBytes)) !== toBase64(new Uint8Array(before.messageBytes))) throw Error("Wallet changed the card allowance.");
  if (!signed) return null;
  const signature = tx.signatures[address(expected.wallet)];
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(bs58.decode(expected.wallet)), "Ed25519", false, ["verify"]);
  if (!signature || !(await crypto.subtle.verify("Ed25519", key, Uint8Array.from(signature), Uint8Array.from(tx.messageBytes)))) throw Error("Invalid card allowance signature.");
  return bs58.encode(signature);
}
export function cardMessageBytes(unsigned: string) {
  const tx = getTransactionDecoder().decode(fromBase64(unsigned));
  const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (message.version !== 0) throw Error("Unsupported card transaction.");
  return toBase64(new Uint8Array(tx.messageBytes));
}
