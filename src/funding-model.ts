import type { LookupProof } from "./lookup-tables.js";
import { isMint } from "./assets.js";
import { parseAmendment, record } from "./live-orders.js";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const WSOL = "So11111111111111111111111111111111111111112";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export type OrderPlan = {
  inputMint: string;
  outputMint: string;
  inputAmount: string;
  triggerMint: string;
  expiresAt: number;
} & (
  | {
      orderType: "single";
      triggerCondition: "above" | "below";
      triggerPriceUsd: number;
      slippageBps: number;
    }
  | {
      orderType: "single";
      triggerCondition: "below";
      trailingBps: number;
      slippageBps: number;
    }
  | {
      orderType: "oco";
      tpPriceUsd: number;
      slPriceUsd: number;
      tpSlippageBps: number;
      slSlippageBps: number;
    }
);
export function units(value: string, decimals: number): string {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 18 ||
    !/^(0|[1-9]\d{0,19})(\.\d{1,18})?$/.test(value)
  )
    throw new Error("Enter a token amount without commas or exponents.");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals)
    throw new Error(`This token supports ${decimals} decimal places.`);
  const raw =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0");
  if (raw <= 0n || raw > 18446744073709551615n)
    throw new Error("Token amount is outside the supported range.");
  return raw.toString();
}
export function displayUnits(raw: string, decimals: number): string {
  if (!decimals) return raw;
  const text = raw.padStart(decimals + 1, "0");
  return `${text.slice(0, -decimals)}.${text.slice(-decimals)}`.replace(
    /\.?0+$/,
    "",
  );
}
export function parsePlan(value: unknown, now = Date.now()): OrderPlan {
  const row = record(value);
  for (const name of ["inputMint", "outputMint", "triggerMint"])
    if (typeof row[name] !== "string" || !isMint(row[name] as string))
      throw new Error("Use exact token contracts.");
  if (
    row.inputMint === row.outputMint ||
    row.inputMint === WSOL ||
    row.outputMint === WSOL
  )
    throw new Error(
      "Choose different SPL tokens. Native and wrapped SOL funding are not supported yet.",
    );
  if (
    typeof row.inputAmount !== "string" ||
    !/^[1-9]\d{0,19}$/.test(row.inputAmount) ||
    BigInt(row.inputAmount) > 18446744073709551615n
  )
    throw new Error("Invalid base-unit token amount.");
  if (
    !Number.isSafeInteger(row.expiresAt) ||
    (row.expiresAt as number) < now + 60000 ||
    (row.expiresAt as number) > now + 31 * 86400000
  )
    throw new Error(
      "Choose an expiry between one minute and 31 days from now.",
    );
  const common = {
    inputMint: row.inputMint as string,
    outputMint: row.outputMint as string,
    inputAmount: row.inputAmount,
    triggerMint: row.triggerMint as string,
    expiresAt: row.expiresAt as number,
  };
  const fields = Object.fromEntries(
    Object.entries(row).filter(
      ([key]) => !Object.hasOwn(common, key) && key !== "triggerCondition",
    ),
  );
  const changes = parseAmendment(fields);
  if (changes.orderType === "oco") {
    if (row.triggerCondition !== undefined || row.triggerMint !== row.inputMint)
      throw new Error("Paired exits must track the token being sold.");
    return { ...common, ...changes };
  }
  if (row.triggerCondition !== "above" && row.triggerCondition !== "below")
    throw new Error("Choose a trigger direction.");
  if (row.triggerMint !== row.inputMint && row.triggerMint !== row.outputMint)
    throw new Error("The trigger must track a token in this order.");
  if ("trailingBps" in changes) {
    if (row.triggerCondition !== "below" || row.triggerMint !== row.inputMint)
      throw new Error("Trailing exits must track the token being sold.");
    return { ...common, ...changes, triggerCondition: "below" };
  }
  return { ...common, ...changes, triggerCondition: row.triggerCondition };
}
export type TransferReview = {
  lookupTables?: LookupProof[];
  wallet: string;
  vault: string;
  mint: string;
  decimals: number;
  amount: string;
  direction: "deposit" | "withdrawal";
  // Jupiter price deposits create a vault-owned account specific to this order.
  depositAccount?: string;
  outputMint?: string;
  tokenAccountRentLamports?: string;
  feeLamports: string;
  rentLamports: string;
};
export type OperationState =
  | "preparing"
  | "prepared"
  | "submitting"
  | "submitted"
  | "unknown"
  | "confirmed"
  | "failed"
  | "abandoned";
export type FundingReceipt = {
  signature: string;
  slot: number;
  blockTime: number | null;
  feeLamports: string;
  verifiedAt: number;
  source: string;
  destination: string;
  mint: string;
  amount: string;
  decimals: number;
};
export type FundingEvent = {
  id: string;
  operationId: string;
  state: OperationState;
  recordedAt: string;
  message?: string;
  signature?: string;
  receipt?: FundingReceipt;
};
export type FundingOperation = {
  id: string;
  wallet: string;
  kind: "create" | "cancel";
  state: OperationState;
  createdAt: number;
  updatedAt: number;
  plan?: OrderPlan;
  orderId?: string;
  requestId?: string;
  transaction?: string;
  review?: TransferReview;
  expiresAt?: number;
  signature?: string;
  receipt?: FundingReceipt;
  result?: { id: string; txSignature: string; depositConfirmed?: boolean };
  message?: string;
};
export const operationId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
export const unresolved = (operation: FundingOperation) =>
  ["preparing", "prepared", "submitting", "submitted", "unknown"].includes(
    operation.state,
  );
