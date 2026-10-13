import { verifyCopyTokenSettlement } from "./copy-settlement.js";
import { USDC } from "../src/funding-model.js";
import { tokenUnits } from "../src/token-fees.js";
import { intermediateRent } from "./copy-intermediate.js";
import { createHash, createPublicKey, verify } from "node:crypto";
import bs58 from "bs58";
import {
  address,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from "@solana/kit";
import { fromBase64 } from "../src/transaction-review.js";
import { record } from "../src/live-orders.js";
import {
  resolveMessageAccounts,
  verifyLoadedAddresses,
} from "../src/lookup-tables.js";
import type { CopyAttempt } from "./copy-ledger.js";

// The caller obtains this reply with finalized commitment. Review expiry limits
// new sends, not recovery of an already submitted signature.
export type SwapSettlementRecord = Pick<CopyAttempt,
  'wallet'|'mint'|'side'|'reservedCents'|'inputRaw'|'inputDecimals'|'outputDecimals'|'minOutputRaw'|'signature'|'messageHash'|'prepared'|'execution'>;
export function verifyCopyLanded(attempt: SwapSettlementRecord, value: unknown) {
  const reply = record(value),
    meta = record(reply.meta),
    execution = attempt.execution,
    review = attempt.prepared?.review;
  if (
    !execution ||
    execution.version !== 1 ||
    !review ||
    !attempt.signature ||
    !attempt.messageHash ||
    !Number.isSafeInteger(reply.slot) ||
    (reply.slot as number) < execution.minContextSlot ||
    !Array.isArray(reply.transaction) ||
    reply.transaction[1] !== "base64" ||
    reply.transaction[0] !== execution.signed
  )
    throw new Error(
      "Landed copy transaction does not match its saved execution.",
    );
  const tx = getTransactionDecoder().decode(fromBase64(reply.transaction[0]));
  const message = getCompiledTransactionMessageDecoder().decode(
      tx.messageBytes,
    ),
    signature = tx.signatures[address(attempt.wallet)];
  if (
    message.version !== 0 ||
    message.header.numSignerAccounts !== 1 ||
    String(message.staticAccounts[0]) !== attempt.wallet ||
    !signature ||
    bs58.encode(signature) !== attempt.signature ||
    attempt.messageHash !== review.messageHash ||
    createHash("sha256")
      .update(new Uint8Array(tx.messageBytes))
      .digest("hex") !== attempt.messageHash
  )
    throw new Error("Landed copy message identity changed.");
  const publicKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      bs58.decode(attempt.wallet),
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
    throw new Error("Invalid landed copy signature.");
  verifyLoadedAddresses(
    message,
    review.lookupTables,
    meta.loadedAddresses,
    reply.slot as number,
  );
  const { keys } = resolveMessageAccounts(message, review.lookupTables);
  const pre = meta.preBalances,
    post = meta.postBalances;
  if (
    !Array.isArray(pre) ||
    !Array.isArray(post) ||
    pre.length !== keys.length ||
    post.length !== keys.length ||
    [...pre, ...post].some((n) => !Number.isSafeInteger(n) || n < 0) ||
    !Number.isSafeInteger(meta.fee) ||
    (meta.fee as number) <= 0 ||
    BigInt(meta.fee as number) > BigInt(review.intent.maxNetworkFeeLamports) ||
    BigInt(meta.fee as number) > BigInt(execution.feeLamports)
  )
    throw new Error("Landed copy fee evidence is invalid.");
  const fee = BigInt(meta.fee as number);
  if (
    meta.err === undefined ||
    (meta.err !== null &&
      typeof meta.err !== "string" &&
      (typeof meta.err !== "object" || Array.isArray(meta.err)))
  )
    throw new Error("Missing copy execution result.");
  if (meta.err !== null) {
    // Solana instruction failure rolls back account changes, but charges the fee.
    if (
      pre.some((n, i) => BigInt(n) - BigInt(post[i]) !== (i === 0 ? fee : 0n))
    )
      throw new Error("Failed copy transaction changed account balances.");
    const tokens = (rows: unknown) => {
      if (!Array.isArray(rows))
        throw new Error("Missing failed copy token evidence.");
      const indexes = new Set<number>();
      return rows
        .map((value) => {
          const row = record(value),
            amount = record(row.uiTokenAmount);
          if (
            !Number.isInteger(row.accountIndex) ||
            (row.accountIndex as number) < 0 ||
            (row.accountIndex as number) >= keys.length ||
            indexes.has(row.accountIndex as number) ||
            typeof row.owner !== "string" ||
            typeof row.mint !== "string" ||
            typeof row.programId !== "string" ||
            typeof amount.amount !== "string" ||
            !/^(0|[1-9]\d{0,19})$/.test(amount.amount) ||
            BigInt(amount.amount) > 18446744073709551615n ||
            !Number.isInteger(amount.decimals)
          )
            throw new Error("Invalid failed copy token evidence.");
          indexes.add(row.accountIndex as number);
          return [
            row.accountIndex,
            row.owner,
            row.mint,
            row.programId,
            amount.amount,
            amount.decimals,
          ];
        })
        .sort((a, b) => Number(a[0]) - Number(b[0]));
    };
    if (
      JSON.stringify(tokens(meta.preTokenBalances)) !==
      JSON.stringify(tokens(meta.postTokenBalances))
    )
      throw new Error("Failed copy transaction changed token balances.");
    return {
      kind: "failed" as const,
      signature: attempt.signature,
      messageHash: attempt.messageHash,
      slot: reply.slot as number,
      feeLamports: fee.toString(),
      verifiedAt: Date.now(),
    };
  }
  const destination = keys.indexOf(review.destination),
    source = keys.indexOf(review.source);
  if (source < 1 || destination < 1)
    throw new Error("Missing copy token accounts.");
  const destinationRent = BigInt(post[destination]) - BigInt(pre[destination]);
  const rent =
    destinationRent +
    intermediateRent(review.intermediate, attempt.wallet, keys, meta);
  if (
    destinationRent < 0n ||
    rent > BigInt(execution.rentLamports) ||
    pre[source] !== post[source] ||
    BigInt(pre[0]) - BigInt(post[0]) !== fee + rent
  )
    throw new Error("Copy transaction spent unexpected SOL.");
  const selling = attempt.side === "sell";
  if (
    (attempt.side !== undefined && !["buy", "sell"].includes(attempt.side)) ||
    !Number.isSafeInteger(attempt.reservedCents) ||
    attempt.reservedCents < 0 ||
    (selling && attempt.reservedCents !== 0) ||
    review.intent.wallet !== attempt.wallet ||
    review.intent.inputMint !== (selling ? attempt.mint : USDC) ||
    review.intent.outputMint !== (selling ? USDC : attempt.mint) ||
    review.intent.inputRaw !==
      (selling
        ? attempt.inputRaw
        : (BigInt(attempt.reservedCents) * 10000n).toString()) ||
    review.intent.minOutputRaw !== attempt.minOutputRaw ||
    tokenUnits(review.minimum) < tokenUnits(attempt.minOutputRaw) ||
    (selling && attempt.outputDecimals !== 6)
  )
    throw new Error("Copy reservation and reviewed trade disagree.");
  const settled = verifyCopyTokenSettlement(review, meta, keys, {
    inputDecimals: selling ? attempt.inputDecimals! : 6,
    outputDecimals: attempt.outputDecimals,
  });
  return {
    inputRaw: settled.spent.toString(),
    outputRaw: settled.received.toString(),
    kind: "succeeded" as const,
    signature: attempt.signature,
    messageHash: attempt.messageHash,
    slot: reply.slot as number,
    feeLamports: fee.toString(),
    rentLamports: rent.toString(),
  };
}
