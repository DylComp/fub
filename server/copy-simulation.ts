import {
  intermediateRent,
  verifyEmptyWrappedAccount,
} from "./copy-intermediate.js";
import bs58 from "bs58";
import {
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import { fromBase64 } from "../src/transaction-review.js";
import {
  resolveMessageAccounts,
  verifyLoadedAddresses,
} from "../src/lookup-tables.js";
import { TOKEN_PROGRAM } from "../src/funding-model.js";
import { verifyCopyTokenSettlement } from "./copy-settlement.js";
import { record } from "../src/live-orders.js";
import type { ReviewedCopySwap } from "./copy-swap.js";

const invalid = (): never => {
  throw new Error(
    "Copy simulation balance evidence is invalid or exceeds the approved trade.",
  );
};
const raw = (value: unknown) => {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > 18446744073709551615n
  )
    return invalid();
  return BigInt(value);
};

// Use before/after balances from the SAME simulation bank, not deltas between
// independent inventory reads. This is a pre-signing check, never a landed fill.
export function verifyCopySimulation(
  review: ReviewedCopySwap,
  value: unknown,
  slot: number,
  bounds: {
    inputDecimals: number;
    outputDecimals: number;
    feeLamports: string;
    rentLamports: string;
  },
) {
  const sim = record(value);
  if (
    !Number.isSafeInteger(slot) ||
    slot < review.lifetime.slot ||
    [bounds.inputDecimals, bounds.outputDecimals].some(
      (n) => !Number.isInteger(n) || n < 0 || n > 18,
    )
  )
    return invalid();
  const tx = getTransactionDecoder().decode(fromBase64(review.unsigned));
  const message = getCompiledTransactionMessageDecoder().decode(
    tx.messageBytes,
  );
  verifyLoadedAddresses(
    message,
    review.lookupTables,
    sim.loadedAddresses,
    slot,
  );
  const { keys } = resolveMessageAccounts(message, review.lookupTables);
  const source = keys.indexOf(review.source),
    destination = keys.indexOf(review.destination);
  if (
    keys[0] !== review.intent.wallet ||
    source < 1 ||
    destination < 1 ||
    source === destination ||
    sim.err !== null ||
    sim.replacementBlockhash != null
  )
    return invalid();
  const pre = sim.preBalances,
    post = sim.postBalances;
  if (
    !Array.isArray(pre) ||
    !Array.isArray(post) ||
    pre.length !== keys.length ||
    post.length !== keys.length ||
    [...pre, ...post].some((n) => !Number.isSafeInteger(n) || n < 0) ||
    !Number.isSafeInteger(sim.fee) ||
    (sim.fee as number) <= 0
  )
    return invalid();
  const fee = BigInt(sim.fee as number),
    destinationRent = BigInt(post[destination]) - BigInt(pre[destination]),
    rent =
      destinationRent +
      intermediateRent(review.intermediate, review.intent.wallet, keys, sim);
  if (
    fee > raw(bounds.feeLamports) ||
    fee > raw(review.intent.maxNetworkFeeLamports) ||
    destinationRent < 0n ||
    rent > raw(bounds.rentLamports) ||
    pre[source] !== post[source] ||
    BigInt(pre[0]) - BigInt(post[0]) !== fee + rent
  )
    return invalid();
  const { inputAfter, outputAfter, spent, received } =
    verifyCopyTokenSettlement(review, sim, keys, bounds);

  // Also inspect the resulting account state: a successful transfer must not
  // leave the follower with a delegated, frozen, closed or reassigned account.
  if (
    !Array.isArray(sim.accounts) ||
    sim.accounts.length !== (review.intermediate ? 3 : 2)
  )
    return invalid();
  for (const [i, n, token] of [
    [0, source, inputAfter!],
    [1, destination, outputAfter!],
  ] as const) {
    const a = record(sim.accounts[i]),
      data = a.data;
    if (
      a.owner !== TOKEN_PROGRAM ||
      a.executable !== false ||
      a.lamports !== post[n] ||
      !Array.isArray(data) ||
      data.length !== 2 ||
      data[1] !== "base64" ||
      typeof data[0] !== "string" ||
      data[0].length !== 220
    )
      return invalid();
    // Standard SPL Account::unpack_from_slice layout (165 bytes):
    // https://github.com/solana-program/token/blob/main/interface/src/state.rs
    const bytes = Buffer.from(data[0], "base64");
    if (
      bytes.length !== 165 ||
      bytes.toString("base64") !== data[0] ||
      bs58.encode(bytes.subarray(0, 32)) !== token.mint ||
      bs58.encode(bytes.subarray(32, 64)) !== review.intent.wallet ||
      bytes.readBigUInt64LE(64) !== token.amount ||
      bytes.readUInt32LE(72) !== 0 ||
      bytes[108] !== 1 ||
      bytes.readUInt32LE(109) !== 0 ||
      bytes.readBigUInt64LE(121) !== 0n
    )
      return invalid();
    const close = bytes.readUInt32LE(129);
    if (
      close !== 0 &&
      (close !== 1 ||
        bs58.encode(bytes.subarray(133, 165)) !== review.intent.wallet)
    )
      return invalid();
  }
  if (review.intermediate)
    verifyEmptyWrappedAccount(
      sim.accounts[2],
      review.intent.wallet,
      post[keys.indexOf(review.intermediate.address)],
    );
  return {
    slot,
    inputRaw: spent.toString(),
    outputRaw: received.toString(),
    feeLamports: fee.toString(),
    rentLamports: rent.toString(),
  };
}
