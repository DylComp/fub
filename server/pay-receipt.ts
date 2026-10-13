import bs58 from "bs58";
import { isMint } from "../src/assets.js";
import { USDC, TOKEN_PROGRAM } from "../src/funding-model.js";
import { associated } from "../src/transaction-review.js";
import { record } from "../src/live-orders.js";
import {
  paymentRawAmount,
  paymentReference,
  validPaymentSignature,
  validTransferTerms,
} from "../src/pay-verification.js";
import type { TransferTerms, PaymentCheck } from "../src/pay-verification.js";
import type { Rpc } from "./funding.js";
import { MAINNET_GENESIS } from "./solana-network.js";

const mismatch = (): PaymentCheck => ({
  status: "unverified",
  message:
    "This transaction does not match a supported payment for this share. Check the transaction and receiving wallet.",
});
// Read finalized mainnet evidence only. This function never signs, submits,
// settles sample balances, or accepts a browser's assertion that money arrived.
export async function verifyPayment(
  t: TransferTerms,
  signature: string,
  rpc: Rpc,
): Promise<PaymentCheck> {
  if (!validTransferTerms(t) || !validPaymentSignature(signature))
    throw Error("Invalid payment check.");
  const [genesis, result, reference, destination] = await Promise.all([
    rpc("getGenesisHash", []),
    rpc("getTransaction", [
      signature,
      {
        encoding: "json",
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      },
    ]),
    paymentReference(t),
    associated(t.recipient, USDC),
  ]);
  if (genesis !== MAINNET_GENESIS)
    throw Error("Mainnet verification unavailable.");
  if (result === null)
    return {
      status: "pending",
      message:
        "No finalized transaction found yet. It may still be pending or unavailable from this provider. Check again shortly.",
    };
  const tx = record(result),
    meta = record(tx.meta),
    transaction = record(tx.transaction),
    message = record(transaction.message);
  if (!("err" in meta)) throw Error("Missing transaction metadata.");
  if (meta.err !== null) {
    if (!Array.isArray(transaction.signatures) || transaction.signatures[0] !== signature || !Number.isSafeInteger(tx.slot) || Number(tx.slot) < 0) throw Error("Failed payment identity could not be verified.");
    return {
      status: "failed",
      message: "This transaction failed on Solana. It did not pay this share.",
    };
  }
  if (
    !Number.isSafeInteger(tx.slot) ||
    Number(tx.slot) < 0 ||
    !(
      tx.blockTime === null ||
      (Number.isSafeInteger(tx.blockTime) && Number(tx.blockTime) >= 0)
    )
  )
    throw Error("Missing transaction context.");
  if (
    !Array.isArray(transaction.signatures) ||
    transaction.signatures[0] !== signature ||
    ![undefined, 0, "legacy"].includes(tx.version as never)
  )
    return mismatch();
  const header = record(message.header),
    staticKeys = message.accountKeys;
  const loaded = record(meta.loadedAddresses);
  const writable = loaded.writable ?? [],
    readonly = loaded.readonly ?? [];
  if (
    !Array.isArray(staticKeys) ||
    !Array.isArray(writable) ||
    !Array.isArray(readonly)
  )
    return mismatch();
  const keys: unknown[] = [...staticKeys, ...writable, ...readonly];
  const required = header.numRequiredSignatures as number,
    roSigned = header.numReadonlySignedAccounts as number,
    roUnsigned = header.numReadonlyUnsignedAccounts as number;
  if (
    keys.length > 256 ||
    keys.some((k) => typeof k !== "string" || !isMint(k)) ||
    new Set(keys).size !== keys.length ||
    !Number.isInteger(required) ||
    required < 1 ||
    required > staticKeys.length ||
    !Number.isInteger(roSigned) ||
    roSigned < 0 ||
    roSigned >= required ||
    !Number.isInteger(roUnsigned) ||
    roUnsigned < 0 ||
    roUnsigned > staticKeys.length - required ||
    transaction.signatures.length !== required ||
    transaction.signatures.some((s) => !validPaymentSignature(s))
  )
    return mismatch();
  const isWritable = (i: number) =>
    i < required
      ? i < required - roSigned
      : i < staticKeys.length
        ? i < staticKeys.length - roUnsigned
        : i < staticKeys.length + writable.length;
  const instructions = message.instructions;
  if (
    !Array.isArray(instructions) ||
    instructions.length < 1 ||
    instructions.length > 64
  )
    return mismatch();
  const transfer = record(instructions.at(-1));
  if (
    !Number.isInteger(transfer.programIdIndex) ||
    keys[Number(transfer.programIdIndex)] !== TOKEN_PROGRAM ||
    !Array.isArray(transfer.accounts) ||
    typeof transfer.data !== "string" ||
    transfer.data.length > 32
  )
    return mismatch();
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(transfer.data);
  } catch {
    return mismatch();
  }
  const checked = bytes[0] === 12;
  if (
    !(checked
      ? bytes.length === 10 && bytes[9] === 6
      : bytes[0] === 3 && bytes.length === 9)
  )
    return mismatch();
  const indices = transfer.accounts;
  if (
    indices.length !== (checked ? 5 : 4) ||
    indices.some((i) => !Number.isInteger(i) || i < 0 || i >= keys.length) ||
    new Set(indices).size !== indices.length
  )
    return mismatch();
  const sourceIndex = indices[0],
    destIndex = indices[checked ? 2 : 1],
    authorityIndex = indices[checked ? 3 : 2],
    refIndex = indices.at(-1)!;
  const sender = keys[authorityIndex] as string;
  const rawAmount = paymentRawAmount(t);
  if (
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(
      1,
      true,
    ) !== BigInt(rawAmount) ||
    (checked && keys[indices[1]] !== USDC) ||
    keys[destIndex] !== destination ||
    keys[refIndex] !== reference ||
    refIndex < required ||
    isWritable(refIndex) ||
    authorityIndex >= required ||
    sender === t.recipient ||
    !isWritable(sourceIndex) ||
    !isWritable(destIndex) ||
    keys[sourceIndex] !== (await associated(sender, USDC))
  )
    return mismatch();
  // Reconcile the actual balance changes, not just the requested instruction.
  const pre = meta.preTokenBalances,
    post = meta.postTokenBalances;
  if (!Array.isArray(pre) || !Array.isArray(post)) return mismatch();
  function amount(
    list: unknown[],
    index: number,
    owner: string,
  ): bigint | null {
    const entries = list.map(record).filter((b) => b.accountIndex === index);
    if (entries.length !== 1) return null;
    const b = entries[0],
      token = record(b.uiTokenAmount);
    if (
      b.mint !== USDC ||
      b.owner !== owner ||
      b.programId !== TOKEN_PROGRAM ||
      token.decimals !== 6 ||
      typeof token.amount !== "string" ||
      !/^(0|[1-9]\d{0,19})$/.test(token.amount)
    )
      return null;
    const n = BigInt(token.amount);
    return n <= 18446744073709551615n ? n : null;
  }
  const sourcePre = amount(pre, sourceIndex, sender),
    sourcePost = amount(post, sourceIndex, sender),
    destPost = amount(post, destIndex, t.recipient);
  let destPre = amount(pre, destIndex, t.recipient);
  if (
    destPre === null &&
    !pre.some((b) => record(b).accountIndex === destIndex) &&
    Array.isArray(meta.preBalances) &&
    meta.preBalances.length === keys.length &&
    meta.preBalances[destIndex] === 0
  )
    destPre = 0n;
  if (
    sourcePre === null ||
    sourcePost === null ||
    destPre === null ||
    destPost === null ||
    sourcePre - sourcePost !== BigInt(rawAmount) ||
    destPost - destPre !== BigInt(rawAmount)
  )
    return mismatch();
  return {
    status: "verified",
    signature,
    reference,
    recipient: t.recipient,
    sender,
    mint: USDC,
    rawAmount,
    slot: tx.slot as number,
    blockTime: tx.blockTime as number | null,
  };
}

export async function checkPayment(
  t: TransferTerms,
  signature: string | undefined,
  rpc: Rpc,
): Promise<PaymentCheck> {
  if (signature) return verifyPayment(t, signature, rpc);
  if (!validTransferTerms(t)) throw Error("Invalid payment terms.");
  // Coalesce the network identity read across at most three candidates.
  let genesis: Promise<unknown> | undefined;
  const read: Rpc = (method, params) =>
    method === "getGenesisHash"
      ? (genesis ??= rpc(method, params))
      : rpc(method, params);
  const reference = await paymentReference(t);
  if ((await read("getGenesisHash", [])) !== MAINNET_GENESIS)
    throw Error("Mainnet verification unavailable.");
  const entries = await read("getSignaturesForAddress", [
    reference,
    { limit: 3, commitment: "finalized" },
  ]);
  if (!Array.isArray(entries) || entries.length > 3)
    throw Error("Invalid payment history.");
  const checks: PaymentCheck[] = [];
  for (const entry of entries) {
    const e = record(entry);
    if (
      !validPaymentSignature(e.signature as string) ||
      e.confirmationStatus !== "finalized"
    )
      throw Error("Invalid payment history.");
    const result = await verifyPayment(t, e.signature as string, read);
    if (result.status === "verified") return result;
    checks.push(result);
  }
  return {
    status: "pending",
    message: checks.length
      ? "No matching payment in the latest three transactions for this share. If you already paid, paste its transaction signature to check it directly."
      : "No finalized payment found for this share. If you already paid, wait a moment and check again.",
  };
}
