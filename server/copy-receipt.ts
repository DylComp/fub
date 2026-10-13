import { verifyCopyLanded } from "./copy-outcome.js";
import { createHash, createPublicKey, verify } from "node:crypto";
import bs58 from "bs58";
import {
  address,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import { TOKEN_PROGRAM, USDC } from "../src/funding-model.js";
import { fromBase64 } from "../src/transaction-review.js";
import { record } from "../src/live-orders.js";
import type { CopyAttempt } from "./copy-ledger.js";
import type { Rpc } from "./funding.js";
type Balance = { mint: string; owner: string; raw: bigint; decimals: number };
export async function readCopyReceipt(attempt: CopyAttempt, rpc: Rpc) {
  if (attempt.prepared && !attempt.execution)
    throw new Error("Saved copy execution evidence is incomplete.");
  if (!attempt.signature || !attempt.messageHash)
    throw new Error("The signed copy trade identity is missing.");
  const result = await rpc("getTransaction", [
    attempt.signature,
    {
      encoding: "base64",
      commitment: attempt.execution ? "finalized" : "confirmed",
      maxSupportedTransactionVersion: 0,
    },
  ]);
  if (result === null) return null;
  const reply = record(result),
    meta = record(reply.meta);
  if (
    meta.err !== null ||
    !Number.isSafeInteger(reply.slot) ||
    (reply.slot as number) <= 0 ||
    !Array.isArray(reply.transaction) ||
    reply.transaction[1] !== "base64"
  )
    throw new Error("The copied transaction has not been verified.");
  if (attempt.execution) {
    const outcome = verifyCopyLanded(attempt, reply);
    if (outcome.kind !== "succeeded")
      throw new Error("The copied transaction failed.");
    return {
      signature: attempt.signature,
      messageHash: attempt.messageHash,
      slot: outcome.slot,
      inputRaw: outcome.inputRaw,
      outputRaw: outcome.outputRaw,
      side: attempt.side === "sell" ? ("sell" as const) : ("buy" as const),
      verifiedAt: Date.now(),
    };
  }
  // Legacy journal entries predate saved execution reviews. Preserve their
  // existing recovery path; every current execution takes the strict path above.
  const tx = getTransactionDecoder().decode(fromBase64(reply.transaction[0]));
  const message = getCompiledTransactionMessageDecoder().decode(
    tx.messageBytes,
  );
  const signature = tx.signatures[address(attempt.wallet)];
  if (message.version === 1)
    throw new Error("Unsupported copied transaction version.");
  if (
    String(message.staticAccounts[0]) !== attempt.wallet ||
    !signature ||
    bs58.encode(signature) !== attempt.signature ||
    createHash("sha256")
      .update(Uint8Array.from(tx.messageBytes))
      .digest("hex") !== attempt.messageHash
  )
    throw new Error("The landed trade does not match the claimed transaction.");
  const publicKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(bs58.decode(attempt.wallet)),
    ]),
    format: "der",
    type: "spki",
  });
  if (
    !verify(
      null,
      Buffer.from(tx.messageBytes),
      publicKey,
      Buffer.from(signature),
    )
  )
    throw new Error("The copied transaction signature is invalid.");
  const selling = attempt.side === "sell";
  if (
    selling &&
    (!attempt.inputRaw ||
      !/^[1-9]\d{0,19}$/.test(attempt.inputRaw) ||
      BigInt(attempt.inputRaw) > 18446744073709551615n ||
      !Number.isInteger(attempt.inputDecimals) ||
      attempt.inputDecimals! < 0 ||
      attempt.inputDecimals! > 18 ||
      attempt.outputDecimals !== 6 ||
      attempt.reservedCents !== 0)
  )
    throw new Error("The sell amount or precision is invalid.");
  const loadedCount =
    message.version === 0
      ? (message.addressTableLookups || []).reduce(
          (count, lookup) =>
            count +
            lookup.readonlyIndexes.length +
            lookup.writableIndexes.length,
          0,
        )
      : 0;
  const accountCount = message.staticAccounts.length + loadedCount;
  function balances(value: unknown) {
    if (!Array.isArray(value))
      throw new Error("Token balance evidence is missing.");
    const rows = new Map<number, Balance>();
    for (const entry of value) {
      const row = record(entry),
        amount = record(row.uiTokenAmount);
      if (
        !Number.isSafeInteger(row.accountIndex) ||
        (row.accountIndex as number) < 0 ||
        (row.accountIndex as number) >= accountCount ||
        rows.has(row.accountIndex as number)
      )
        throw new Error("Invalid token account evidence.");
      if (
        typeof row.owner !== "string" ||
        typeof row.mint !== "string" ||
        typeof amount.amount !== "string" ||
        !/^(0|[1-9]\d{0,19})$/.test(amount.amount) ||
        BigInt(amount.amount) > 18446744073709551615n ||
        !Number.isInteger(amount.decimals)
      )
        throw new Error("Incomplete token ownership evidence.");
      if (
        row.owner === attempt.wallet &&
        (row.programId !== TOKEN_PROGRAM ||
          (amount.decimals as number) < 0 ||
          (amount.decimals as number) > 18)
      )
        throw new Error("Unsupported token account.");
      rows.set(row.accountIndex as number, {
        owner: row.owner,
        mint: row.mint,
        raw: BigInt(amount.amount),
        decimals: amount.decimals as number,
      });
    }
    return rows;
  }
  const pre = balances(meta.preTokenBalances),
    post = balances(meta.postTokenBalances),
    deltas = new Map<string, bigint>();
  for (const index of new Set([...pre.keys(), ...post.keys()])) {
    const before = pre.get(index),
      after = post.get(index);
    if (before?.owner !== attempt.wallet && after?.owner !== attempt.wallet)
      continue;
    if (
      before &&
      after &&
      (before.owner !== after.owner ||
        before.mint !== after.mint ||
        before.decimals !== after.decimals)
    )
      throw new Error("Token authority or mint changed during the trade.");
    const token = after || before!;
    if (
      (token.mint === USDC && token.decimals !== 6) ||
      (token.mint === attempt.mint &&
        token.decimals !==
          (selling ? attempt.inputDecimals : attempt.outputDecimals))
    )
      throw new Error("Token precision changed.");
    deltas.set(
      token.mint,
      (deltas.get(token.mint) || 0n) + (after?.raw || 0n) - (before?.raw || 0n),
    );
  }
  const inputMint = selling ? attempt.mint : USDC;
  const outputMint = selling ? USDC : attempt.mint;
  const inputRaw = selling
    ? BigInt(attempt.inputRaw!)
    : BigInt(attempt.reservedCents) * 10000n;
  if (deltas.get(inputMint) !== -inputRaw)
    throw new Error(
      selling
        ? "Token spend did not match the reserved sell amount."
        : "USDC spend did not match the reserved amount.",
    );
  const output = deltas.get(outputMint) || 0n;
  if (
    output < BigInt(attempt.minOutputRaw) ||
    output > 18446744073709551615n ||
    [...deltas].some(([mint, delta]) => mint !== inputMint && delta < 0n)
  )
    throw new Error(
      "Received tokens do not match the quote, or another holding was spent.",
    );
  return {
    signature: attempt.signature,
    messageHash: attempt.messageHash,
    slot: reply.slot as number,
    outputRaw: output.toString(),
    inputRaw: inputRaw.toString(),
    side: selling ? ("sell" as const) : ("buy" as const),
    verifiedAt: Date.now(),
  };
}
