import type { IncomingMessage, ServerResponse } from "node:http";
import { isMint } from "../src/assets.js";
import { USDC, WSOL } from "../src/funding-model.js";
import type { AccountReadiness } from "../src/account-readiness.js";
import { rpcRequest } from "./funding.js";
import { readAccountReadiness } from "./account-readiness.js";

const cache = new Map<string, AccountReadiness>();
const pending = new Map<string, Promise<AccountReadiness>>();
let windowStart = 0,
  requests = 0;
export async function handleAccountReadiness(
  req: IncomingMessage,
  res: ServerResponse,
  endpoint: string,
) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  const send = (status: number, body: unknown) => {
    res.statusCode = status;
    res.end(JSON.stringify(body));
  };
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return send(405, { message: "GET required." });
  }
  const p = new URL(req.url || "/", "http://localhost").searchParams,
    address = p.get("address") || "",
    mint = p.get("mint") || "";
  if (
    p.get("action") !== "accounts" ||
    ["action", "address", "mint"].some((k) => p.getAll(k).length !== 1) ||
    [...p.keys()].some((k) => !["action", "address", "mint"].includes(k)) ||
    !isMint(address) ||
    !isMint(mint) ||
    [USDC, WSOL].includes(mint)
  )
    return send(400, {
      message: "Choose a memecoin contract and a public Solana wallet.",
    });
  const key = `${address}:${mint}`,
    cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < 10000) return send(200, cached);
  let job = pending.get(key);
  if (!job) {
    if (Date.now() - windowStart >= 60000) {
      windowStart = Date.now();
      requests = 0;
    }
    if (requests >= 20 || pending.size >= 3) {
      res.setHeader("Retry-After", "60");
      return send(429, {
        message: "Account checks are busy. Try again shortly.",
      });
    }
    requests++;
    job = readAccountReadiness(address, mint, (method, params) =>
      rpcRequest(method, params, endpoint),
    )
      .then((report) => {
        if (cache.size >= 100) cache.delete(cache.keys().next().value!);
        cache.set(key, report);
        return report;
      })
      .finally(() => pending.delete(key));
    pending.set(key, job);
  }
  try {
    return send(200, await job);
  } catch {
    return send(503, {
      message: "Trading account checks are unavailable. Try again shortly.",
    });
  }
}
