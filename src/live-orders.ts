import { isMint } from "./assets.js";

export const CHALLENGE_PREFIX =
  "Sign this message to authenticate with Jupiter that you are the owner of ";
export function challengeExpiry(
  value: unknown,
  wallet?: string,
  now = Date.now(),
): number | null {
  if (typeof value !== "string" || value.length > 1024) return null;
  const match =
    /^Sign this message to authenticate with Jupiter that you are the owner of ([1-9A-HJ-NP-Za-km-z]{32,44})\.\n\nThis challenge expires at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) with the nonce of ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.$/.exec(
      value,
    );
  if (!match || !isMint(match[1]) || (wallet && match[1] !== wallet))
    return null;
  const expires = Date.parse(match[2]);
  if (
    !Number.isFinite(expires) ||
    expires <= now ||
    expires > now + 301000 ||
    new Date(expires).toISOString() !== match[2]
  )
    return null;
  return expires;
}
export function validChallenge(
  value: unknown,
  wallet?: string,
): value is string {
  return challengeExpiry(value, wallet) !== null;
}
export type TriggerSession = {
  configured: boolean;
  funding?: boolean;
  recovery?: boolean;
  address: string | null;
  expiresAt?: number;
  csrf?: string;
};
export type LiveEvent = {
  type: string;
  state: string;
  timestamp: number;
  txSignature?: string;
};
export type LiveOrder = {
  id: string;
  orderType: "single" | "oco" | "otoco";
  orderState: string;
  rawState: string;
  userPubkey: string;
  inputMint: string;
  outputMint: string;
  initialInputAmount: string;
  remainingInputAmount: string;
  expiresAt: number;
  updatedAt: number;
  triggerPriceUsd?: number;
  triggerCondition?: "above" | "below";
  trailingBps?: number;
  highWatermark?: number;
  tpPriceUsd?: number;
  slPriceUsd?: number;
  slippageBps?: number;
  tpSlippageBps?: number;
  slSlippageBps?: number;
  events: LiveEvent[];
};
export type LiveHistory = {
  address: string;
  orders: LiveOrder[];
  total: number;
  offset: number;
  fetchedAt: number;
};
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid response");
  return value as Record<string, unknown>;
}
export const orderId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
function text(value: unknown, max = 64): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > max ||
    /[\x00-\x1f]/.test(value)
  )
    throw new Error("Invalid text");
  return value;
}
function mint(value: unknown): string {
  if (typeof value !== "string" || !isMint(value))
    throw new Error("Invalid mint");
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new Error("Invalid number");
  return value;
}
function rawAmount(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > 18446744073709551615n
  )
    throw new Error("Invalid token amount");
  return value;
}
const positive = (value: unknown): number => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > 1e12
  )
    throw new Error("Enter a positive price.");
  return value;
};
export function parseHistory(
  value: unknown,
  address: string,
  offset: number,
): LiveHistory {
  const body = record(value),
    pagination = record(body.pagination);
  if (
    !Array.isArray(body.orders) ||
    body.orders.length > 20 ||
    pagination.offset !== offset
  )
    throw new Error("Invalid order list");
  const orders = body.orders.map((value): LiveOrder => {
    const row = record(value);
    if (
      !orderId(row.id) ||
      row.userPubkey !== address ||
      !["single", "oco", "otoco"].includes(String(row.orderType))
    )
      throw new Error("Invalid order owner or type");
    const order: LiveOrder = {
      id: row.id,
      userPubkey: address,
      orderType: row.orderType as LiveOrder["orderType"],
      orderState: text(row.orderState),
      rawState: text(row.rawState),
      inputMint: mint(row.inputMint),
      outputMint: mint(row.outputMint),
      initialInputAmount: rawAmount(row.initialInputAmount),
      remainingInputAmount: rawAmount(row.remainingInputAmount),
      expiresAt: integer(row.expiresAt, 0, 8640000000000000),
      updatedAt: integer(row.updatedAt, 0, 8640000000000000),
      events: [],
    };
    for (const key of [
      "triggerPriceUsd",
      "highWatermark",
      "tpPriceUsd",
      "slPriceUsd",
    ] as const) {
      if (row[key] != null) order[key] = positive(row[key]);
    }
    for (const key of [
      "trailingBps",
      "slippageBps",
      "tpSlippageBps",
      "slSlippageBps",
    ] as const) {
      if (row[key] != null) order[key] = integer(row[key], 0, 10000);
    }
    if (row.triggerCondition != null) {
      if (row.triggerCondition !== "above" && row.triggerCondition !== "below")
        throw new Error("Invalid condition");
      order.triggerCondition = row.triggerCondition;
    }
    if (!Array.isArray(row.events) || row.events.length > 2000)
      throw new Error("Invalid history");
    order.events = row.events.slice(-30).map((value) => {
      const event = record(value);
      const parsed: LiveEvent = {
        type: text(event.type),
        state: text(event.state),
        timestamp: integer(event.timestamp, 0, 8640000000000000),
      };
      if (event.txSignature != null) {
        if (
          typeof event.txSignature !== "string" ||
          !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(event.txSignature)
        )
          throw new Error("Invalid transaction");
        parsed.txSignature = event.txSignature;
      }
      return parsed;
    });
    return order;
  });
  if (new Set(orders.map((order) => order.id)).size !== orders.length)
    throw new Error("Duplicate order");
  return {
    address,
    orders,
    total: integer(pagination.total, 0, Number.MAX_SAFE_INTEGER),
    offset,
    fetchedAt: Date.now(),
  };
}

export type Amendment =
  | { orderType: "single"; triggerPriceUsd: number; slippageBps: number }
  | { orderType: "single"; trailingBps: number; slippageBps: number }
  | {
      orderType: "oco";
      tpPriceUsd: number;
      slPriceUsd: number;
      tpSlippageBps: number;
      slSlippageBps: number;
    };
// Rebuild an allowlisted payload. Never forward arbitrary provider fields.
export function parseAmendment(value: unknown): Amendment {
  const body = record(value);
  let parsed: Amendment;
  if (body.orderType === "single") {
    const slippageBps = integer(body.slippageBps, 10, 500);
    parsed =
      body.trailingBps !== undefined
        ? {
            orderType: "single",
            trailingBps: integer(body.trailingBps, 50, 9000),
            slippageBps,
          }
        : {
            orderType: "single",
            triggerPriceUsd: positive(body.triggerPriceUsd),
            slippageBps,
          };
  } else if (body.orderType === "oco") {
    const tpPriceUsd = positive(body.tpPriceUsd),
      slPriceUsd = positive(body.slPriceUsd);
    if (tpPriceUsd <= slPriceUsd) throw new Error("Target must exceed stop.");
    parsed = {
      orderType: "oco",
      tpPriceUsd,
      slPriceUsd,
      tpSlippageBps: integer(body.tpSlippageBps, 10, 500),
      slSlippageBps: integer(body.slSlippageBps, 10, 500),
    };
  } else throw new Error("Unsupported order type.");
  if (
    Object.keys(body).length !== Object.keys(parsed).length ||
    Object.keys(body).some((key) => !(key in parsed))
  )
    throw new Error("Unexpected order fields.");
  return parsed;
}
export function decimalBps(value: string): number {
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(value))
    throw new Error("Use at most two decimal places.");
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}
export const canAmend = (order: LiveOrder) =>
  order.orderState === "open" &&
  order.rawState === "open" &&
  order.orderType !== "otoco" &&
  order.expiresAt > Date.now();
