import { AccountLayout, MintLayout } from "@solana/spl-token";
import { BRIDGE_CARD_PROGRAM, cardAddresses, cardAllowanceTransaction, cardMessageBytes, inspectCardAllowance, validMerchantId, type CardWalletSnapshot, type CardAllowanceIntent, type CardAllowanceReview } from "../src/card-allowance.js";
import { associated } from "../src/transaction-review.js";
import { isMint } from "../src/assets.js";
import { USDC, TOKEN_PROGRAM } from "../src/funding-model.js";
import { MAINNET_GENESIS } from "./solana-network.js";
import type { Rpc } from "./funding.js";
const SYSTEM = "11111111111111111111111111111111";
function integer(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 0) throw Error("Invalid chain context."); return Number(value); }
function binary(a: any, owner: string, size?: number) {
  if (!a || a.owner !== owner || a.executable !== false || !Array.isArray(a.data) || a.data[1] !== "base64" || typeof a.data[0] !== "string" || a.data[0].length > 8192) throw Error("Unsupported card account.");
  const data = Buffer.from(a.data[0], "base64");
  if (data.toString("base64") !== a.data[0] || (size !== undefined && data.length !== size)) throw Error("Invalid account encoding.");
  return data;
}
function token(a: unknown, wallet: string) {
  const value = AccountLayout.decode(binary(a, TOKEN_PROGRAM, 165));
  if (value.mint.toBase58() !== USDC || value.owner.toBase58() !== wallet || ![1, 2].includes(value.state) ||
      value.isNativeOption !== 0 || ![0, 1].includes(value.delegateOption) || ![0, 1].includes(value.closeAuthorityOption) ||
      (value.closeAuthorityOption && value.closeAuthority.toBase58() !== wallet) || (!value.delegateOption && value.delegatedAmount !== 0n)) throw Error("Unsupported USDC account controls.");
  return value;
}
export async function cardWalletSnapshot(wallet: string, merchantId: string | null, rpc: Rpc, minContextSlot = 0): Promise<CardWalletSnapshot> {
  if (!isMint(wallet) || (merchantId !== null && !validMerchantId(merchantId))) throw Error("Invalid card wallet.");
  const source = await associated(wallet, USDC), delegate = merchantId === null ? null : (await cardAddresses(wallet, merchantId)).delegate;
  const [genesis, result] = await Promise.all([
    rpc("getGenesisHash", []), rpc("getMultipleAccounts", [[wallet, USDC, source, ...(delegate ? [BRIDGE_CARD_PROGRAM, delegate] : [])], { encoding: "base64", commitment: "finalized", minContextSlot }]),
  ]) as [unknown, any];
  if (genesis !== MAINNET_GENESIS) throw Error("Solana mainnet verification failed.");
  const slot = integer(result?.context?.slot), rows = result?.value;
  if (slot < minContextSlot || !Array.isArray(rows) || rows.length !== (delegate ? 5 : 3)) throw Error("Missing card wallet accounts.");
  if (rows[0]) binary(rows[0], SYSTEM, 0);
  const mint = MintLayout.decode(binary(rows[1], TOKEN_PROGRAM, 82));
  if (!mint.isInitialized || mint.decimals !== 6) throw Error("Unsupported USDC mint.");
  const account = rows[2] ? token(rows[2], wallet) : null;
  let cardRegistered = false;
  if (delegate) {
    if (!rows[3] || rows[3].executable !== true) throw Error("Card program is unavailable.");
    if (rows[4]) { const data = binary(rows[4], BRIDGE_CARD_PROGRAM); cardRegistered = data.length >= 8; }
  }
  return { wallet, source, slot, fetchedAt: Date.now(), solLamports: String(rows[0] ? integer(rows[0].lamports) : 0),
    usdcRaw: String(account?.amount ?? 0n), account: !account ? "missing" : account.state === 2 ? "frozen" : "ready",
    delegate: account?.delegateOption ? account.delegate.toBase58() : null, allowanceRaw: String(account?.delegatedAmount ?? 0n),
    cardDelegate: delegate, cardRegistered, merchantId };
}
// Binding comes from verified customer/card enrollment in server storage, never
// from a browser-supplied card ID. That enrollment is still a provider dependency.
export type BridgeCardBinding = { wallet: string; customerId: string; cardId: string; merchantId: string };
export async function prepareCardAllowance(binding: BridgeCardBinding, action: "approve" | "revoke", cents: number, rpc: Rpc,
  verifyCard: (binding: BridgeCardBinding) => Promise<void>): Promise<CardAllowanceReview> {
  const intent: CardAllowanceIntent = { wallet: binding.wallet, merchantId: binding.merchantId, action, cents };
  // Validate amount and merchant before any external work.
  await cardAllowanceTransaction(intent, binding.wallet);
  if (action === "approve") await verifyCard(binding);
  const before = await cardWalletSnapshot(binding.wallet, binding.merchantId, rpc);
  if (before.account !== "ready") throw Error("An active USDC token account is required.");
  if (action === "approve" && !before.cardRegistered) throw Error("The card must be provisioned before approving access.");
  if (before.delegate && before.delegate !== before.cardDelegate) throw Error("Another delegate already controls this USDC account. It will not be replaced.");
  if (action === "revoke" && before.delegate !== before.cardDelegate) throw Error("No matching card allowance to revoke.");
  const latest = await rpc("getLatestBlockhash", [{ commitment: "finalized", minContextSlot: before.slot }]) as any;
  const slot = integer(latest?.context?.slot), height = integer(latest?.value?.lastValidBlockHeight), blockhash = latest?.value?.blockhash;
  if (slot < before.slot || !isMint(blockhash)) throw Error("A fresh card transaction could not be prepared.");
  const unsigned = await cardAllowanceTransaction(intent, blockhash);
  const fee = await rpc("getFeeForMessage", [cardMessageBytes(unsigned), { commitment: "finalized", minContextSlot: slot }]) as any;
  if (integer(fee?.context?.slot) < slot || fee?.value === null) throw Error("Card network fee is unavailable.");
  const feeLamports = String(integer(fee.value));
  if (BigInt(before.solLamports) < BigInt(feeLamports)) throw Error("This wallet needs SOL for the approval fee.");
  const review: CardAllowanceReview = { ...intent, source: before.source, delegate: before.cardDelegate!, unsigned, blockhash,
    lastValidBlockHeight: height, slot, expiresAt: Date.now() + 60000, feeLamports };
  await inspectCardAllowance(review, intent);
  const simulated = await rpc("simulateTransaction", [unsigned, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: false,
    commitment: "finalized", minContextSlot: slot, accounts: { encoding: "base64", addresses: [before.source, binding.wallet] } }]) as any;
  if (integer(simulated?.context?.slot) < slot || simulated?.value?.err !== null || !Array.isArray(simulated?.value?.accounts) || simulated.value.accounts.length !== 2) throw Error("Card allowance simulation failed.");
  const after = token(simulated.value.accounts[0], binding.wallet), payer = simulated.value.accounts[1];
  binary(payer, SYSTEM, 0);
  if (after.amount.toString() !== before.usdcRaw || after.state !== 1 ||
      integer(payer.lamports) !== Number(BigInt(before.solLamports) - BigInt(feeLamports)) ||
      (action === "approve" ? after.delegateOption !== 1 || after.delegate.toBase58() !== before.cardDelegate || after.delegatedAmount !== BigInt(cents) * 10000n
        : after.delegateOption !== 0 || after.delegatedAmount !== 0n)) throw Error("Simulation does not match the reviewed allowance.");
  return review;
}
