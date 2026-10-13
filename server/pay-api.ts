import type { IncomingMessage, ServerResponse } from "node:http";
import { checkPayment } from "./pay-receipt.js";
import { copyReadRpc } from "./copy-rpc.js";
import {
  validPayTerms,
  validPaymentSignature,
} from "../src/pay-verification.js";
import type { PayTerms, PaymentCheck } from "../src/pay-verification.js";

const pending = new Map<string, Promise<PaymentCheck>>();
const cache = new Map<string, { at: number; check: PaymentCheck }>();
let windowStart = 0,
  requests = 0;
export async function handlePay(
  req: IncomingMessage,
  res: ServerResponse,
  endpoint?: string,
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
  if ((req.url || "").length > 1200)
    return send(400, { message: "Invalid payment check." });
  const p = new URL(req.url || "/", "http://localhost").searchParams;
  const fields = ["id", "kind", "recipient", "cents", "people", "index"];
  if (
    p.getAll("signature").length > 1 ||
    fields.some((k) => p.getAll(k).length !== 1) ||
    [...p.keys()].some((k) => ![...fields, "signature"].includes(k)) ||
    ["cents", "people", "index"].some(
      (k) => !/^(0|[1-9]\d{0,8})$/.test(p.get(k)!),
    )
  )
    return send(400, { message: "Invalid payment check." });
  const t: PayTerms = {
    id: p.get("id")!,
    kind: p.get("kind") as PayTerms["kind"],
    recipient: p.get("recipient")!,
    cents: Number(p.get("cents")),
    people: Number(p.get("people")),
    index: Number(p.get("index")),
  };
  const signature = p.get("signature") ?? undefined;
  if (
    !validPayTerms(t) ||
    (signature !== undefined && !validPaymentSignature(signature))
  )
    return send(400, {
      message: "Check the request and transaction signature.",
    });
  const key = JSON.stringify([endpoint || "default", t, signature]);
  const cached = cache.get(key);
  if (
    cached &&
    Date.now() - cached.at < (cached.check.status === "verified" ? 60000 : 5000)
  )
    return send(200, cached.check);
  let job = pending.get(key);
  if (!job) {
    if (Date.now() - windowStart >= 60000) {
      windowStart = Date.now();
      requests = 0;
    }
    if (requests >= 20 || pending.size >= 3) {
      res.setHeader("Retry-After", "60");
      return send(429, {
        message: "Payment checks are busy. Try again in a minute.",
      });
    }
    requests++;
    job = checkPayment(t, signature, copyReadRpc(endpoint || process.env.PAY_TRANSFER_RPC_URL || undefined))
      .then((check) => {
        if (cache.size >= 200) cache.delete(cache.keys().next().value!);
        cache.set(key, { at: Date.now(), check });
        return check;
      })
      .finally(() => pending.delete(key));
    pending.set(key, job);
  }
  try {
    return send(200, await job);
  } catch {
    return send(503, {
      message:
        "Solana verification is unavailable. Payment status is unknown. Try again shortly.",
    });
  }
}
