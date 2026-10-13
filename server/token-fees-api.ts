import type { IncomingMessage, ServerResponse } from "node:http";
import { isMint } from "../src/assets.js";
import type { TokenFeeReport } from "../src/token-fees.js";
import { readTokenFees } from "./token-fees.js";
import { rpcRequest } from "./funding.js";
const cache = new Map<string, TokenFeeReport>();
const pending = new Map<string, Promise<TokenFeeReport>>();
let windowStart = 0,
  requests = 0;
export async function handleTokenFees(
  req: IncomingMessage,
  res: ServerResponse,
  endpoint: string,
) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  const send = (status: number, value: unknown) => {
    res.statusCode = status;
    res.end(JSON.stringify(value));
  };
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return send(405, { message: "GET required." });
  }
  const p = new URL(req.url || "/", "http://localhost").searchParams,
    mint = p.get("mint") || "";
  if (
    p.get("action") !== "fees" ||
    !isMint(mint) ||
    ["action", "mint"].some((k) => p.getAll(k).length !== 1) ||
    [...p.keys()].some((k) => !["action", "mint"].includes(k))
  )
    return send(400, { message: "Choose a Token-2022 contract." });
  const cached = cache.get(mint);
  if (cached && Date.now() - cached.fetchedAt < 10000) return send(200, cached);
  let job = pending.get(mint);
  if (!job) {
    if (Date.now() - windowStart >= 60000) {
      windowStart = Date.now();
      requests = 0;
    }
    if (requests >= 20 || pending.size >= 3) {
      res.setHeader("Retry-After", "60");
      return send(429, { message: "Fee checks are busy. Try again shortly." });
    }
    requests++;
    job = readTokenFees(mint, (method, params) =>
      rpcRequest(method, params, endpoint),
    )
      .then((report) => {
        if (cache.size >= 100) cache.delete(cache.keys().next().value!);
        cache.set(mint, report);
        return report;
      })
      .finally(() => pending.delete(mint));
    pending.set(mint, job);
  }
  try {
    return send(200, await job);
  } catch {
    return send(503, {
      message: "Token transfer fees are unavailable. Try again shortly.",
    });
  }
}
