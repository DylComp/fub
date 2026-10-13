import {
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import { record } from "../src/live-orders.js";
import { tokenUnits } from "../src/token-fees.js";
import { MAINNET_GENESIS } from "./solana-network.js";
import {
  bindRaydium22Signed,
  verifyRaydium22Landed,
  verifyRaydium22Review,
  verifyRaydium22Simulation,
} from "./native-copy-review.js";
import type { Token22Record } from "./token2022-journal.js";
import type { Rpc } from "./funding.js";

export type Token22Preflight = {
  slot: number;
  blockHeight: number;
  checkedAt: number;
  sourceRaw: string;
};

// Before requesting a signature, simulate the exact immutable unsigned message.
// This is not signature validation, delegation, or a finalized receipt.
export async function preflightUnsignedToken22(
  saved: Token22Record,
  rpc: Rpc,
): Promise<Token22Preflight> {
  const started = Date.now(),
    r = saved.review;
  if (saved.state !== "prepared" || saved.execution)
    throw Error("An unsigned preparation is required.");
  verifyRaydium22Review(r, saved.reviewHash);
  const fresh = (height: unknown) => {
    if (
      !Number.isSafeInteger(height) ||
      (height as number) < 1 ||
      (height as number) > r.lastValidBlockHeight ||
      Date.now() < r.reviewedAt ||
      Date.now() >= r.expiresAt
    )
      throw Error("Signing review expired.");
  };
  if ((await rpc("getGenesisHash", [])) !== MAINNET_GENESIS)
    throw Error("Mainnet RPC is required.");
  fresh(
    await rpc("getBlockHeight", [
      { commitment: "confirmed", minContextSlot: r.minContextSlot },
    ]),
  );
  const result = await rpc("simulateTransaction", [
    r.unsigned,
    {
      encoding: "base64",
      sigVerify: false,
      replaceRecentBlockhash: false,
      commitment: "confirmed",
      minContextSlot: r.minContextSlot,
    },
  ]);
  const checkedAt = Date.now(),
    checked = verifyRaydium22Simulation(r, saved.reviewHash, result);
  let sourceRaw = "0";
  if (r.accounts.direction === "sell") {
    const tx = getTransactionDecoder().decode(
      Buffer.from(r.unsigned, "base64"),
    );
    const keys = getCompiledTransactionMessageDecoder()
      .decode(tx.messageBytes)
      .staticAccounts.map(String);
    const meta = record(record(result).value);
    const source = (meta.preTokenBalances as unknown[])
      .map(record)
      .find((row) => row.accountIndex === keys.indexOf(r.accounts.source));
    sourceRaw = tokenUnits(record(source?.uiTokenAmount).amount).toString();
  }
  const blockHeight = await rpc("getBlockHeight", [
    { commitment: "confirmed", minContextSlot: checked.slot },
  ]);
  fresh(blockHeight);
  if (Date.now() - started > 10000)
    throw Error("Signing preflight took too long.");
  return {
    slot: checked.slot,
    blockHeight: blockHeight as number,
    checkedAt,
    sourceRaw,
  };
}
// Simulation evidence only. Never pass this adapted receipt to the outcome journal.
export async function preflightToken22(
  saved: Pick<Token22Record, 'state' | 'review' | 'reviewHash' | 'execution'>,
  rpc: Rpc,
): Promise<Token22Preflight> {
  const started = Date.now();
  const { review: r, reviewHash, execution: e } = saved;
  if (!e || saved.state !== "signed")
    throw Error("A saved signature is required.");
  if ((await rpc("getGenesisHash", [])) !== MAINNET_GENESIS)
    throw Error("Mainnet RPC is required.");
  const height = await rpc("getBlockHeight", [
    { commitment: "confirmed", minContextSlot: r.minContextSlot },
  ]);
  bindRaydium22Signed(r, reviewHash, e.signed, height as number);
  const result = record(
    await rpc("simulateTransaction", [
      e.signed,
      {
        encoding: "base64",
        sigVerify: true,
        replaceRecentBlockhash: false,
        commitment: "confirmed",
        minContextSlot: r.minContextSlot,
      },
    ]),
  );
  const simulatedAt = Date.now();
  if (record(result.value).replacementBlockhash != null)
    throw Error("Simulation replaced the signed blockhash.");
  const slot = record(result.context).slot,
    meta = record(result.value);
  // The reviewed transaction has no lookup tables. Reuse exact balance checks,
  // but do not turn a simulated success into a finalized or funded outcome.
  const checked = verifyRaydium22Landed(r, reviewHash, e, {
    slot,
    version: 0,
    transaction: [e.signed, "base64"],
    meta: {
      ...meta,
      loadedAddresses: meta.loadedAddresses ?? { readonly: [], writable: [] },
    },
  });
  if (checked.kind !== "succeeded")
    throw Error("The signed transaction no longer simulates successfully.");
  let sourceRaw = "0";
  if (r.accounts.direction === "sell") {
    const tx = getTransactionDecoder().decode(Buffer.from(e.signed, "base64"));
    const message = getCompiledTransactionMessageDecoder().decode(
      tx.messageBytes,
    );
    const index = message.staticAccounts.map(String).indexOf(r.accounts.source);
    const source = (meta.preTokenBalances as unknown[])
      .map(record)
      .find((row) => row.accountIndex === index);
    sourceRaw = tokenUnits(record(source?.uiTokenAmount).amount).toString();
  }
  // Do not claim after an RPC call consumed the remaining review lifetime.
  const freshHeight = await rpc("getBlockHeight", [
    { commitment: "confirmed", minContextSlot: checked.slot },
  ]);
  bindRaydium22Signed(r, reviewHash, e.signed, freshHeight as number);
  if (Date.now() - started > 10000)
    throw Error("Submission preflight took too long.");
  return {
    slot: checked.slot,
    blockHeight: freshHeight as number,
    checkedAt: simulatedAt,
    sourceRaw,
  };
}
