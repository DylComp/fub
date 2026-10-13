import bs58 from "bs58";
import { isMint } from "../src/assets.js";
import { record } from "../src/live-orders.js";

const invalid = () => {
  throw new Error("Leader transaction format evidence is inconsistent.");
};
const uint32 = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 0 &&
  (value as number) <= 0xffffffff;

// Parsed RPC evidence is used for observation only. This does not authorize
// v1 signing or change the separate v0 execution-message validator.
export function leaderFormatEvidence(body: Record<string, unknown>) {
  const version = body.version,
    tx = record(body.transaction),
    message = record(tx.message),
    meta = record(body.meta);
  if (
    version !== undefined &&
    version !== "legacy" &&
    version !== 0 &&
    version !== 1
  )
    return invalid();
  if (version !== 1) {
    if (message.transactionConfig !== undefined) return invalid();
    return undefined;
  }
  // Failed chain execution cannot become a copy signal. Its config may itself
  // be the reason it failed; do not require successful-execution limits here.
  if (meta.err !== null) return undefined;
  const config = record(message.transactionConfig),
    fields = [
      "computeUnitLimit",
      "loadedAccountsDataSizeLimit",
      "heapSize",
      "priorityFee",
    ];
  if (
    Object.keys(config).length !== fields.length ||
    fields.some((key) => !(key in config)) ||
    !uint32(config.computeUnitLimit) ||
    config.computeUnitLimit === 0 ||
    !uint32(config.loadedAccountsDataSizeLimit) ||
    config.loadedAccountsDataSizeLimit === 0 ||
    (config.heapSize !== null && !uint32(config.heapSize)) ||
    (config.priorityFee !== null &&
      (!Number.isSafeInteger(config.priorityFee) ||
        (config.priorityFee as number) < 0)) ||
    !Number.isSafeInteger(meta.fee) ||
    (meta.fee as number) < 0 ||
    ((config.priorityFee as number | null) ?? 0) > (meta.fee as number) ||
    !isMint(String(message.recentBlockhash)) ||
    !Array.isArray(message.accountKeys) ||
    message.accountKeys.length < 1 ||
    message.accountKeys.length > 64 ||
    !Array.isArray(message.instructions) ||
    message.instructions.length < 1 ||
    message.instructions.length > 64 ||
    !Array.isArray(tx.signatures)
  )
    return invalid();
  // v1 has inline addresses only. Loaded lookup addresses must never shift the
  // indexes used for token balances or route accounts.
  if (
    message.addressTableLookups !== undefined &&
    (!Array.isArray(message.addressTableLookups) ||
      message.addressTableLookups.length)
  )
    return invalid();
  if (meta.loadedAddresses !== undefined) {
    const loaded = record(meta.loadedAddresses);
    if (
      Object.keys(loaded).length !== 2 ||
      !Array.isArray(loaded.writable) ||
      loaded.writable.length ||
      !Array.isArray(loaded.readonly) ||
      loaded.readonly.length
    )
      return invalid();
  }
  const keys = message.accountKeys.map(record),
    addresses = new Set(keys.map((k) => k.pubkey)),
    signers = keys.filter((k) => k.signer === true).length;
  if (
    !signers ||
    signers !== tx.signatures.length ||
    addresses.size !== keys.length ||
    keys.some(
      (k, i) =>
        !isMint(String(k.pubkey)) ||
        k.source !== "transaction" ||
        typeof k.writable !== "boolean" ||
        k.signer !== i < signers,
    ) ||
    !keys[0].writable
  )
    return invalid();
  try {
    if (
      tx.signatures.some(
        (s) => typeof s !== "string" || bs58.decode(s).length !== 64,
      )
    )
      return invalid();
  } catch {
    return invalid();
  }
  for (const item of message.instructions) {
    const ix = record(item);
    if (!addresses.has(ix.programId)) return invalid();
    if (
      ix.accounts !== undefined &&
      (!Array.isArray(ix.accounts) ||
        ix.accounts.some((a) => !addresses.has(a)))
    )
      return invalid();
  }
  return {
    transactionVersion: 1 as const,
    networkFeeLamports: String(meta.fee),
    // v1 declares total lamports, not micro-lamports per compute unit.
    priorityFeeLamports: String(config.priorityFee ?? 0),
  };
}
