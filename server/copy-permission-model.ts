import {FUB_CANONICAL_ORIGIN, isFubProductionOrigin, type FubWebOrigin} from '../src/fub-origin.js';
import {
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from "@solana/kit";
import { fromBase64 } from "../src/transaction-review.js";
import { resolveMessageAccounts } from "../src/lookup-tables.js";
import { COPY_SWAP_PROGRAM, decodeCopyRoute } from "../src/copy-swap.js";
import type { ReviewedCopySwap } from "./copy-swap.js";
import { createHash, createPublicKey, verify } from "node:crypto";
import bs58 from "bs58";
import { isMint } from "../src/assets.js";
import { operationId } from "../src/funding-model.js";
import type { AccountCopyPlan } from "../src/copy-account.js";
import type { CopyAttempt } from "./copy-ledger.js";

export const COPY_PERMISSION_ORIGIN = FUB_CANONICAL_ORIGIN;
export type CopyPermissionScope = (
  | { version: 1 }
  | {
      version: 2;
      routePolicy: "jupiter-reviewed-v2";
      accountPolicy: "standard-token-ata";
    }
) & {
  origin: FubWebOrigin;
  network: "solana:mainnet";
  id: string;
  wallet: string;
  planId: string;
  planVersion: number;
  leader: string;
  buyCents: number;
  dailyCents: number;
  slippageBps: number;
  copySells: boolean;
  maxNetworkFeeLamports: "1000000";
  maxRentLamports: "2500000";
  issuedAt: number;
  acceptBy: number;
  expiresAt: number;
};
const fields =
  "acceptBy,buyCents,copySells,dailyCents,expiresAt,id,issuedAt,leader,maxNetworkFeeLamports,maxRentLamports,network,origin,planId,planVersion,slippageBps,version,wallet";
export function parseCopyPermission(value: unknown): CopyPermissionScope {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid copy permission.");
  const s = value as CopyPermissionScope;
  if (
    Object.keys(s).sort().join(",") !==
      (s.version === 2
        ? (fields + ",routePolicy,accountPolicy").split(",").sort().join(",")
        : fields) ||
    ![1, 2].includes(s.version) ||
    (s.version === 2 &&
      (s.routePolicy !== "jupiter-reviewed-v2" ||
        s.accountPolicy !== "standard-token-ata")) ||
    !isFubProductionOrigin(s.origin) ||
    s.network !== "solana:mainnet" ||
    !operationId(s.id) ||
    !operationId(s.planId) ||
    !isMint(s.wallet) ||
    !isMint(s.leader) ||
    s.wallet === s.leader ||
    !Number.isSafeInteger(s.planVersion) ||
    s.planVersion < 1 ||
    s.planVersion > 2147483647 ||
    !Number.isSafeInteger(s.buyCents) ||
    s.buyCents < 100 ||
    s.buyCents > 100000000 ||
    !Number.isSafeInteger(s.dailyCents) ||
    s.dailyCents < s.buyCents ||
    s.dailyCents > 100000000 ||
    !Number.isSafeInteger(s.slippageBps) ||
    s.slippageBps < 10 ||
    s.slippageBps > 500 ||
    typeof s.copySells !== "boolean" ||
    s.maxNetworkFeeLamports !== "1000000" ||
    s.maxRentLamports !== "2500000" ||
    ![s.issuedAt, s.acceptBy, s.expiresAt].every(Number.isSafeInteger) ||
    s.issuedAt < 1 ||
    s.expiresAt > 8640000000000000 ||
    s.acceptBy !== s.issuedAt + 300000 ||
    s.expiresAt < s.issuedAt + 600000 ||
    s.expiresAt > s.issuedAt + 86400000
  )
    throw new Error("Invalid copy permission scope.");
  return s;
}
export function makeCopyPermission(
  plan: AccountCopyPlan,
  id: string,
  durationSeconds: number,
  now = Date.now(),
) {
  if (
    !Number.isSafeInteger(durationSeconds) ||
    durationSeconds < 600 ||
    durationSeconds > 86400
  )
    throw new Error(
      "Permission duration must be between ten minutes and one day.",
    );
  return parseCopyPermission({
    version: 2,
    routePolicy: "jupiter-reviewed-v2",
    accountPolicy: "standard-token-ata",
    origin: COPY_PERMISSION_ORIGIN,
    network: "solana:mainnet",
    id,
    wallet: plan.wallet,
    planId: plan.id,
    planVersion: plan.version,
    leader: plan.address,
    buyCents: plan.buyCents,
    dailyCents: plan.dailyCents,
    slippageBps: plan.slippageBps,
    copySells: plan.copySells,
    maxNetworkFeeLamports: "1000000",
    maxRentLamports: "2500000",
    issuedAt: now,
    acceptBy: now + 300000,
    expiresAt: now + durationSeconds * 1000,
  });
}
function dollars(cents: number) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
export function copyPermissionMessage(value: unknown) {
  const s = parseCopyPermission(value);
  return [
    `Fomo Orders copy permission v${s.version}`,
    `Website: ${s.origin}`,
    `Network: ${s.network}`,
    `Wallet: ${s.wallet}`,
    `Leader: ${s.leader}`,
    `Plan: ${s.planId}`,
    `Plan version: ${s.planVersion}`,
    `Buy size: ${dollars(s.buyCents)} USDC`,
    `Daily buy cap: ${dollars(s.dailyCents)} USDC per UTC day, excluding fees and account rent`,
    `Slippage limit: ${s.slippageBps} basis points`,
    `Proportional sells: ${s.copySells ? "allowed, only tokens attributed to this plan" : "not allowed"}`,
    `Network fee limit: ${s.maxNetworkFeeLamports} lamports per transaction`,
    `New token account rent limit: ${s.maxRentLamports} lamports per transaction`,
    ...(s.version === 1
      ? [
          "Routes: reviewed Jupiter shared-account swaps with standard SPL tokens and USDC endpoints",
        ]
      : [
          "Route policy: jupiter-reviewed-v2",
          "Routes: reviewed Jupiter shared-account swaps, direct Raydium CLMM and direct PumpSwap V3 buys and sells",
          "Tokens: standard SPL tokens with USDC endpoints; at most one retained empty wrapped SOL intermediary",
          "Account policy: standard-token-ata; only my receiving token account and empty wrapped SOL account may be created",
          "Reward accounts, cashback claims, Token-2022 and bonding curves are not authorized",
        ]),
    `Issued: ${new Date(s.issuedAt).toISOString()}`,
    `Sign before: ${new Date(s.acceptBy).toISOString()}`,
    `Permission expires: ${new Date(s.expiresAt).toISOString()}`,
    `Request: ${s.id}`,
    "I authorize these application rules. Editing, pausing or stopping invalidates this permission.",
    "Already submitted trades may finish after permission expires or is stopped.",
    "This message does not move funds or give a signer access to my wallet. A separate supported signing connection is required.",
  ].join("\n");
}
export function copyPermissionHash(scope: unknown) {
  return createHash("sha256")
    .update(copyPermissionMessage(scope), "utf8")
    .digest("hex");
}
export function verifyCopyPermission(scope: unknown, signature: string) {
  const s = parseCopyPermission(scope);
  if (
    typeof signature !== "string" ||
    !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)
  )
    throw new Error("Invalid copy permission signature.");
  const bytes = bs58.decode(signature);
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      bs58.decode(s.wallet),
    ]),
    format: "der",
    type: "spki",
  });
  if (
    bytes.length !== 64 ||
    bs58.encode(bytes) !== signature ||
    !verify(null, Buffer.from(copyPermissionMessage(s), "utf8"), key, bytes)
  )
    throw new Error("Invalid copy permission signature.");
  return copyPermissionHash(s);
}

export function assertCopyPermissionAttempt(
  value: unknown,
  attempt: CopyAttempt,
) {
  const s = parseCopyPermission(value),
    selling = attempt.side === "sell";
  if (
    attempt.wallet !== s.wallet ||
    attempt.planId !== s.planId ||
    attempt.permissionId !== s.id ||
    ![undefined, "buy", "sell"].includes(attempt.side) ||
    attempt.reservedCents !== (selling ? 0 : s.buyCents) ||
    (selling && !s.copySells) ||
    !Number.isSafeInteger(attempt.slippageBps) ||
    attempt.slippageBps! < 10 ||
    attempt.slippageBps! > s.slippageBps ||
    !Number.isSafeInteger(attempt.expiresAt) ||
    attempt.expiresAt <= s.issuedAt ||
    attempt.expiresAt > s.expiresAt
  )
    throw new Error("Copy attempt exceeds its signed permission.");
  if (attempt.prepared) assertCopyPermissionRoute(s, attempt.prepared.review);
}

// Read the actual compiled message, not mutable review instruction metadata.
// These versioned allowlists must not grow without new owner consent.
export function assertCopyPermissionRoute(
  value: unknown,
  review: ReviewedCopySwap,
) {
  const scope = parseCopyPermission(value);
  const tx = getTransactionDecoder().decode(fromBase64(review.unsigned));
  const message = getCompiledTransactionMessageDecoder().decode(
    tx.messageBytes,
  );
  if (message.version !== 0)
    throw new Error("Unsupported copy permission message version.");
  const resolved = resolveMessageAccounts(message, review.lookupTables);
  const swap = message.instructions.at(-1);
  if (
    message.header.numSignerAccounts !== 1 ||
    resolved.keys[0] !== scope.wallet ||
    !swap ||
    resolved.keys[swap.programAddressIndex] !== COPY_SWAP_PROGRAM
  )
    throw new Error("Copy route does not match its signed permission.");
  const route = decodeCopyRoute(new Uint8Array(swap.data || []));
  const allowed =
    route.kind === "shared"
      ? [7, 17, 19, 26, 38, 40, 46, 47, 75, 77, 105, 108]
      : scope.version === 2
        ? [26, 99, 100]
        : [];
  if (route.steps.some((step) => !allowed.includes(step.variant)))
    throw new Error(
      "Copy route needs a new owner permission for this exchange or account layout.",
    );
}
