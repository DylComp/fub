import {
  address,
  blockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getCompiledTransactionMessageDecoder,
  getTransactionEncoder,
  getTransactionDecoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import type { Address, AccountRole, Instruction } from "@solana/kit";
import { createHash, createPublicKey, verify } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import bs58 from "bs58";
import { record } from "../src/live-orders.js";
import { isMint } from "../src/assets.js";
import { fromBase64, toBase64 } from "../src/transaction-review.js";
import { resolveMessageAccounts } from "../src/lookup-tables.js";
import {
  instructionBytes,
  reviewCopyBuild,
  swapRaw,
  validateSwapIntent,
} from "../src/copy-swap.js";
import type { CopySwapIntent } from "../src/copy-swap.js";
import { USDC } from "../src/funding-model.js";
import type { CopyAttempt } from "./copy-ledger.js";
import type { Rpc } from "./funding.js";
import {
  resolveFundingLookups,
  revalidateFundingLookups,
} from "./funding-lookups.js";
import { readCopyInventory } from "./copy-inventory.js";
import { verifyCopyWhirlpools } from "./copy-whirlpools.js";
import { readCopyIntermediate } from "./copy-intermediate.js";
import { verifyCopyDirectPools } from "./copy-direct-pools.js";
import { verifyCopySimulation } from "./copy-simulation.js";

export const COPY_BUILD_URL = "https://api.jup.ag/swap/v2/build";
export const COPY_DEXES =
  "Raydium,Raydium CLMM,Raydium CP,Meteora DLMM,Meteora DAMM v2,Whirlpool,Pump.fun Amm";
const MAX_BODY_BYTES = 150_000;
export type SwapLifetime = {
  blockhash: string;
  lastValidBlockHeight: number;
  slot: number;
};

// Internal only. This module has no activation endpoint, signer, send or execute call.
export async function fetchCopyBuild(
  intent: CopySwapIntent,
  apiKey: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  validateSwapIntent(intent);
  if (!apiKey || /[\r\n]/.test(apiKey))
    throw new Error("A Jupiter API key is required for copy execution.");
  const query = new URLSearchParams({
    inputMint: intent.inputMint,
    outputMint: intent.outputMint,
    amount: intent.inputRaw,
    slippageBps: String(intent.slippageBps),
    taker: intent.wallet,
    dexes: COPY_DEXES,
    instructionVersion: "V2",
  });
  const response = await fetcher(`${COPY_BUILD_URL}?${query}`, {
    headers: { "x-api-key": apiKey, Accept: "application/json" },
    signal: AbortSignal.any([
      AbortSignal.timeout(Math.min(8000, intent.expiresAt - Date.now())),
      ...(signal ? [signal] : []),
    ]),
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(`Copy quote provider returned HTTP ${response.status}.`);
  if (
    Number(response.headers.get("content-length") || 0) > MAX_BODY_BYTES ||
    !response.body
  )
    throw new Error("Copy quote response is too large or empty.");
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BODY_BYTES)
        throw new Error("Copy quote response is too large.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  validateSwapIntent(intent);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("Copy quote provider returned invalid JSON.");
  }
}

export async function compileReviewedCopySwap(
  buildValue: unknown,
  intent: CopySwapIntent,
  lifetime: SwapLifetime,
  rpc: Rpc,
  now = Date.now(),
) {
  const build = record(buildValue),
    review = await reviewCopyBuild(build, intent, now);
  if (
    !isMint(lifetime.blockhash) ||
    !Number.isSafeInteger(lifetime.lastValidBlockHeight) ||
    lifetime.lastValidBlockHeight < 1 ||
    !Number.isSafeInteger(lifetime.slot) ||
    lifetime.slot < 1
  )
    throw new Error("Invalid copy blockhash evidence.");
  let routeContextSlot = await verifyCopyWhirlpools(
    review.whirlpools,
    review.instructions,
    rpc,
    lifetime.slot,
  );
  routeContextSlot = await verifyCopyDirectPools(
    review.instructions,
    rpc,
    routeContextSlot,
  );
  const supplied = record(build.addressesByLookupTableAddress),
    tables: Record<Address, Address[]> = {};
  if (Object.keys(supplied).length > 4)
    throw new Error("Too many swap lookup tables.");
  // JSONB storage does not preserve object insertion order. Canonical table
  // ordering keeps reconstruction byte-for-byte stable after a database read.
  for (const [key, values] of Object.entries(supplied).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (
      !isMint(key) ||
      !Array.isArray(values) ||
      !values.length ||
      values.length > 256 ||
      values.some((v) => typeof v !== "string" || !isMint(v))
    )
      throw new Error("Invalid swap lookup table.");
    tables[address(key)] = values.map((v) => address(v as string));
  }
  const instructions: Instruction[] = review.instructions.map((ix) => ({
    programAddress: address(ix.programId),
    accounts: ix.accounts.map((a) => ({
      address: address(a.pubkey),
      role: ((a.isSigner ? 2 : 0) + (a.isWritable ? 1 : 0)) as AccountRole,
    })),
    data: instructionBytes(ix.data),
  }));
  const message = appendTransactionMessageInstructions(
    instructions,
    setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: blockhash(lifetime.blockhash),
        lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight),
      },
      setTransactionMessageFeePayer(
        address(intent.wallet),
        createTransactionMessage({ version: 0 }),
      ),
    ),
  );
  const tx = compileTransaction(
    compressTransactionMessageUsingAddressLookupTables(message, tables),
  );
  const unsigned = toBase64(new Uint8Array(getTransactionEncoder().encode(tx)));
  fromBase64(unsigned); // Reject transactions above the network's packet limit.
  const compiled = getCompiledTransactionMessageDecoder().decode(
    tx.messageBytes,
  );
  if (compiled.version !== 0)
    throw new Error("Unsupported compiled swap version.");
  const lookups = await resolveFundingLookups(compiled, rpc, lifetime.slot),
    resolved = resolveMessageAccounts(compiled, lookups);
  if (
    compiled.header.numSignerAccounts !== 1 ||
    resolved.keys[0] !== intent.wallet ||
    Object.keys(tx.signatures).join() !== intent.wallet
  )
    throw new Error("Unexpected compiled swap signer.");
  if (compiled.instructions.length !== review.instructions.length)
    throw new Error("Compiled swap instructions changed.");
  for (const [i, actual] of compiled.instructions.entries()) {
    const expected = review.instructions[i];
    if (
      resolved.keys[actual.programAddressIndex] !== expected.programId ||
      (actual.accountIndices || []).length !== expected.accounts.length ||
      (actual.accountIndices || []).some(
        (index, n) => resolved.keys[index] !== expected.accounts[n].pubkey,
      ) ||
      toBase64(new Uint8Array(actual.data || [])) !== expected.data
    )
      throw new Error(
        "On-chain lookup addresses disagree with the reviewed swap.",
      );
  }
  return {
    ...review,
    // Retain only the quote evidence needed to independently rebuild the message
    // at the signing boundary. No provider headers or credentials are stored.
    buildEvidence: structuredClone(
      Object.fromEntries(
        [
          "inAmount",
          "outAmount",
          "otherAmountThreshold",
          "inputMint",
          "outputMint",
          "swapMode",
          "slippageBps",
          "swapInstruction",
          "routePlan",
          "cleanupInstruction",
          "tipInstruction",
          "otherInstructions",
          "setupInstructions",
          "computeBudgetInstructions",
          "addressesByLookupTableAddress",
        ]
          .filter((key) => build[key] !== undefined)
          .map((key) => [key, build[key]]),
      ),
    ),
    intent: { ...intent },
    unsigned,
    messageHash: createHash("sha256")
      .update(new Uint8Array(tx.messageBytes))
      .digest("hex"),
    lookupTables: lookups,
    lifetime: { ...lifetime },
    routeContextSlot,
    reviewedAt: now,
    expiresAt: intent.expiresAt,
  };
}
export type ReviewedCopySwap = Awaited<
  ReturnType<typeof compileReviewedCopySwap>
>;

// A message hash alone proves consistency, not spending authority. Re-run the
// instruction/route checks using the reservation's intent and fresh chain proofs,
// then require the exact same serialized message before handing it to a signer.
export async function revalidateCopyReview(
  review: ReviewedCopySwap,
  intent: CopySwapIntent,
  rpc: Rpc,
) {
  if (!review.buildEvidence || !isDeepStrictEqual(review.intent, intent))
    throw new Error("Copy signing evidence is missing or its limits changed.");
  const rebuilt = await compileReviewedCopySwap(
    review.buildEvidence,
    intent,
    review.lifetime,
    rpc,
  );
  for (const key of [
    "unsigned",
    "messageHash",
    "instructions",
    "source",
    "destination",
    "minimum",
    "output",
    "priorityFee",
    "createsDestination",
    "intermediate",
    "whirlpools",
    "expiresAt",
  ] as const) {
    if (!isDeepStrictEqual(review[key], rebuilt[key]))
      throw new Error(`Copy signing ${key} differs from its validated route.`);
  }
  return rebuilt;
}

// Call immediately before a future atomic ledger claim. Never reuse this check to
// retry a possibly sent transaction: receipt recovery owns that state transition.
export async function preflightCopySwap(
  review: ReviewedCopySwap,
  rpc: Rpc,
  minContextSlot = 0,
) {
  validateSwapIntent(review.intent);
  const tx = getTransactionDecoder().decode(fromBase64(review.unsigned));
  if (
    createHash("sha256")
      .update(new Uint8Array(tx.messageBytes))
      .digest("hex") !== review.messageHash
  )
    throw new Error("Reviewed swap message changed.");
  const message = getCompiledTransactionMessageDecoder().decode(
    tx.messageBytes,
  );
  await revalidateFundingLookups(message, review.lookupTables, rpc);
  let slot = Math.max(
    minContextSlot,
    review.lifetime.slot,
    review.routeContextSlot || 0,
    ...review.lookupTables.map((p) => p.contextSlot),
  );
  slot = await verifyCopyWhirlpools(
    review.whirlpools || [],
    review.instructions,
    rpc,
    slot,
  );
  slot = await verifyCopyDirectPools(review.instructions, rpc, slot);
  const [
    input,
    output,
    balanceValue,
    feeValue,
    rentValue,
    validValue,
    intermediate,
  ] = await Promise.all([
    readCopyInventory(review.intent.wallet, review.intent.inputMint, rpc, slot),
    readCopyInventory(
      review.intent.wallet,
      review.intent.outputMint,
      rpc,
      slot,
    ),
    rpc("getBalance", [
      review.intent.wallet,
      { commitment: "finalized", minContextSlot: slot },
    ]),
    rpc("getFeeForMessage", [
      toBase64(new Uint8Array(tx.messageBytes)),
      { commitment: "confirmed", minContextSlot: slot },
    ]),
    rpc("getMinimumBalanceForRentExemption", [
      165,
      { commitment: "finalized" },
    ]),
    rpc("isBlockhashValid", [
      review.lifetime.blockhash,
      { commitment: "confirmed", minContextSlot: slot },
    ]),
    review.intermediate
      ? readCopyIntermediate(
          review.intent.wallet,
          review.intermediate,
          rpc,
          slot,
        )
      : undefined,
  ]);
  const contextual = (value: unknown) => {
    const result = record(value),
      context = record(result.context).slot;
    if (!Number.isSafeInteger(context) || (context as number) < slot)
      throw new Error("Swap RPC evidence is stale.");
    return result.value;
  };
  const balance = contextual(balanceValue),
    fee = contextual(feeValue);
  if (contextual(validValue) !== true)
    throw new Error("Copy swap blockhash expired.");
  if (
    !Number.isSafeInteger(balance) ||
    (balance as number) < 0 ||
    !Number.isSafeInteger(fee) ||
    (fee as number) <= 0 ||
    BigInt(fee as number) > swapRaw(review.intent.maxNetworkFeeLamports) ||
    !Number.isSafeInteger(rentValue) ||
    (rentValue as number) <= 0 ||
    (rentValue as number) > 2_500_000
  )
    throw new Error("Copy swap fee or rent could not be bounded.");
  if (BigInt(input.rawAmount) < swapRaw(review.intent.inputRaw))
    throw new Error("Insufficient copy token balance.");
  const rent = review.intermediate
    ? (rentValue as number) *
      (Number(!output.exists && review.createsDestination) +
        Number(!intermediate!.exists))
    : review.createsDestination
      ? (rentValue as number)
      : 0;
  if (rent > 2_500_000)
    throw new Error(
      "Required account rent exceeds the current copy permission.",
    );
  if ((balance as number) < (fee as number) + rent)
    throw new Error("Insufficient SOL for swap fees and account rent.");
  slot = Math.max(
    slot,
    input.slot,
    output.slot,
    intermediate?.slot || 0,
    ...[balanceValue, feeValue, validValue].map(
      (v) => record(record(v).context).slot as number,
    ),
  );
  const simulation = record(
    await rpc("simulateTransaction", [
      review.unsigned,
      {
        encoding: "base64",
        sigVerify: false,
        replaceRecentBlockhash: false,
        commitment: "confirmed",
        minContextSlot: slot,
        accounts: {
          encoding: "base64",
          addresses: [
            review.source,
            review.destination,
            ...(review.intermediate ? [review.intermediate.address] : []),
          ],
        },
      },
    ]),
  );
  const simulated = record(contextual(simulation));
  if (
    simulated.err !== null ||
    !Number.isSafeInteger(simulated.unitsConsumed) ||
    (simulated.unitsConsumed as number) < 1 ||
    (simulated.unitsConsumed as number) > 1_400_000
  )
    throw new Error("Copy swap simulation failed.");
  const simulationEvidence = verifyCopySimulation(
    review,
    simulated,
    record(simulation.context).slot as number,
    {
      inputDecimals: input.decimals,
      outputDecimals: output.decimals,
      feeLamports: String(fee),
      rentLamports: String(rent),
    },
  );
  validateSwapIntent(review.intent);
  return {
    input,
    output,
    feeLamports: String(fee),
    rentLamports: String(rent),
    checkedAt: Date.now(),
    simulation: simulationEvidence,
    ...(intermediate ? { intermediate } : {}),
  };
}

export async function prepareCopySwap(
  intent: CopySwapIntent,
  rpc: Rpc,
  apiKey: string,
  signal?: AbortSignal,
  fetcher:typeof fetch=fetch,
) {
  const build = await fetchCopyBuild(intent, apiKey, fetcher, signal);
  signal?.throwIfAborted();
  return prepareCopyBuild(build, intent, rpc);
}

export async function prepareCopyBuild(
  build: unknown,
  intent: CopySwapIntent,
  rpc: Rpc,
) {
  const latest = record(
      await rpc("getLatestBlockhash", [{ commitment: "finalized" }]),
    ),
    value = record(latest.value);
  const review = await compileReviewedCopySwap(
    build,
    intent,
    {
      blockhash: String(value.blockhash || ""),
      lastValidBlockHeight: value.lastValidBlockHeight as number,
      slot: record(latest.context).slot as number,
    },
    rpc,
  );
  const preflight = await preflightCopySwap(review, rpc);
  return { review, preflight };
}

export function verifyCopySwapSignature(
  review: ReviewedCopySwap,
  signed: string,
) {
  validateSwapIntent(review.intent);
  return verifyCopySwapMessageSignature(review, signed);
}

// Cryptographic evidence only, including a late provider response. This does not
// authorize submission and deliberately does not extend the transaction deadline.
export function verifyCopySwapMessageSignature(
  review: Pick<ReviewedCopySwap,'unsigned'|'messageHash'|'intent'>,
  signed: string,
) {
  const before = getTransactionDecoder().decode(fromBase64(review.unsigned)),
    after = getTransactionDecoder().decode(fromBase64(signed));
  if (
    toBase64(new Uint8Array(getTransactionEncoder().encode(after))) !==
      signed ||
    !Buffer.from(before.messageBytes).equals(Buffer.from(after.messageBytes)) ||
    createHash("sha256")
      .update(new Uint8Array(after.messageBytes))
      .digest("hex") !== review.messageHash ||
    Object.keys(after.signatures).join() !== review.intent.wallet
  )
    throw new Error("The signed copy swap differs from the reviewed message.");
  const signature = after.signatures[address(review.intent.wallet)];
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      bs58.decode(review.intent.wallet),
    ]),
    format: "der",
    type: "spki",
  });
  if (!signature || !verify(null, after.messageBytes, key, signature))
    throw new Error("Invalid copy swap signature.");
  return bs58.encode(signature);
}

// Derive intent from a server-loaded reservation, never browser-provided amounts.
// The eventual submission adapter must still claim atomically after these checks.
export function copyIntentForAttempt(attempt: CopyAttempt): CopySwapIntent {
  const selling = attempt.side === "sell";
  if (
    attempt.state !== "reserved" ||
    (attempt.side !== undefined && !["buy", "sell"].includes(attempt.side)) ||
    !Number.isInteger(attempt.outputDecimals) ||
    attempt.outputDecimals < 0 ||
    attempt.outputDecimals > 18 ||
    (selling
      ? attempt.reservedCents !== 0 ||
        !Number.isInteger(attempt.inputDecimals) ||
        attempt.inputDecimals! < 0 ||
        attempt.inputDecimals! > 18 ||
        attempt.outputDecimals !== 6
      : !Number.isSafeInteger(attempt.reservedCents) ||
        attempt.reservedCents < 100 ||
        attempt.reservedCents > 100000000)
  )
    throw new Error("The copy reservation cannot be prepared.");
  const intent = {
    wallet: attempt.wallet,
    inputMint: selling ? attempt.mint : USDC,
    outputMint: selling ? USDC : attempt.mint,
    inputRaw: selling
      ? attempt.inputRaw || ""
      : (BigInt(attempt.reservedCents) * 10000n).toString(),
    minOutputRaw: attempt.minOutputRaw,
    slippageBps: attempt.slippageBps!,
    maxNetworkFeeLamports: "1000000",
    expiresAt: attempt.expiresAt,
  };
  validateSwapIntent(intent);
  return intent;
}
export async function prepareReservedCopySwap(
  attempt: CopyAttempt,
  rpc: Rpc,
  apiKey: string,
  signal?: AbortSignal,
) {
  const intent = copyIntentForAttempt(attempt),
    prepared = await prepareCopySwap(intent, rpc, apiKey, signal);
  if (
    prepared.preflight.input.decimals !==
      (attempt.side === "sell" ? attempt.inputDecimals : 6) ||
    prepared.preflight.output.decimals !== attempt.outputDecimals
  )
    throw new Error("The copy token precision differs from the reservation.");
  return { ...prepared, attemptId: attempt.id };
}
