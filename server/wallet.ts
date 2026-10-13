import { handleRecipient } from "./fomo-recipient.js";
import { handleFomoLookup } from "./fomo-lookup.js";
import { handleTokenFees } from "./token-fees-api.js";
import { handleAccountReadiness } from "./account-readiness-api.js";
import { handleAccountSetup } from "./account-setup-api.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isMint } from "../src/assets.js";
export type BalanceReply = {
  address: string;
  lamports: string;
  slot: number;
  fetchedAt: number;
};
const cache = new Map<string, BalanceReply>();
const pending = new Map<string, Promise<BalanceReply>>();
let windowStart = 0;
let requests = 0;

export function parseBalance(raw: unknown, address: string): BalanceReply {
  const body = raw as {
    error?: unknown;
    result?: { value?: unknown; context?: { slot?: unknown } };
  } | null;
  const value = body?.result?.value;
  const slot = body?.result?.context?.slot;
  if (
    body?.error ||
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    typeof slot !== "number" ||
    !Number.isSafeInteger(slot) ||
    slot < 0
  )
    throw new Error("Invalid balance");
  return { address, lamports: String(value), slot, fetchedAt: Date.now() };
}
async function fetchBalance(
  address: string,
  rpc: string,
): Promise<BalanceReply> {
  const response = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getBalance",
      params: [address, { commitment: "confirmed" }],
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error("RPC unavailable");
  return parseBalance(await response.json(), address);
}
export async function handleBalance(
  req: IncomingMessage,
  res: ServerResponse,
  rpc = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  const send = (status: number, data: unknown) => {
    res.statusCode = status;
    res.end(JSON.stringify(data));
  };
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return send(405, { message: "GET required." });
  }
  const params = new URL(req.url || "/", "http://localhost").searchParams;
  if (["recipient", "recipient-stats"].includes(params.get("action") || "")) return handleRecipient(req, res);
  if (params.get("action") === "identity") return handleFomoLookup(req, res);
  if (params.get("action") === "fees") return handleTokenFees(req, res, rpc);
  if (params.get("action") === "accounts")
    return handleAccountReadiness(req, res, rpc);
  if (params.get("action") === "setup")
    return handleAccountSetup(req, res, rpc);
  const address = params.get("address") || "";
  if (
    params.getAll("address").length !== 1 ||
    [...params.keys()].some((key) => key !== "address") ||
    !isMint(address)
  )
    return send(400, { message: "A public Solana address is required." });
  const cached = cache.get(address);
  if (cached && Date.now() - cached.fetchedAt < 10000) return send(200, cached);
  let job = pending.get(address);
  if (!job) {
    if (Date.now() - windowStart >= 60000) {
      windowStart = Date.now();
      requests = 0;
    }
    if (requests >= 60 || pending.size >= 8) {
      res.setHeader("Retry-After", "60");
      return send(429, {
        message: "Balance requests are busy. Try again shortly.",
      });
    }
    requests++;
    job = fetchBalance(address, rpc)
      .then((data) => {
        if (cache.size >= 200) cache.delete(cache.keys().next().value!);
        cache.set(address, data);
        return data;
      })
      .finally(() => pending.delete(address));
    pending.set(address, job);
  }
  try {
    return send(200, await job);
  } catch {
    return send(503, {
      message: "SOL balance is unavailable. Try again shortly.",
    });
  }
}
