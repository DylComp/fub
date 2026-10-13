import {isFubWebOrigin} from './fub-web-origin.js';
import type { IncomingMessage, ServerResponse } from "node:http";
import { createPublicKey, verify } from "node:crypto";
import bs58 from "bs58";
import { payHistoryMessage, type PayHistoryAuthorization } from "../src/pay-history-auth.js";
import { validPayRecord, type PayStatement } from "../src/pay-ledger-model.js";
import { payIssuerConfig } from "./pay-issuer.js";
import { payIssuerStore } from "./pay-issuer-store.js";
export function payHistoryHandler(read?: (wallet: string) => Promise<PayStatement>) {
  let pending = 0, count = 0, since = 0;
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("Content-Type", "application/json");
    const send = (code: number, data: unknown) => { res.statusCode = code; res.end(JSON.stringify(data)); };
    if (req.method === "GET" && !new URL(req.url || "/", "http://local").search) {
      let available = !!read;
      if (!read) { try { payIssuerConfig(); available = process.env.PAY_ISSUER_HISTORY_ENABLED === "true" && !!process.env.DATABASE_URL; } catch { available = false; } }
      return send(200, { available });
    }
    if (req.method !== "POST") { res.setHeader("Allow", "POST"); return send(405, { message: "A signed card history request is required." }); }
    if (!isFubWebOrigin(req.headers.origin) ||
        req.headers["x-fomo-request"] !== "1" || req.headers["content-type"]?.split(";")[0] !== "application/json" ||
        (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") || new URL(req.url || "/", "http://local").search) return send(403, { message: "Open card history on Fub." });
    if (Date.now() - since >= 60000) { since = Date.now(); count = 0; }
    if (pending >= 2 || count >= 20) { res.setHeader("Retry-After", "60"); return send(429, { message: "Card history is busy. Try again shortly." }); }
    pending++; count++;
    try {
      let auth: PayHistoryAuthorization;
      try {
        let raw = (req as IncomingMessage & { body?: unknown }).body;
        if (raw === undefined) {
          let size = 0; const chunks: Buffer[] = [], timer = setTimeout(() => req.destroy(), 3000);
          try { for await (const chunk of req) { const b = Buffer.from(chunk); size += b.length; if (size > 4096) throw Error(); chunks.push(b); } raw = Buffer.concat(chunks).toString("utf8"); } finally { clearTimeout(timer); }
        }
        const text = typeof raw === "string" ? raw : JSON.stringify(raw); if (Buffer.byteLength(text) > 4096) throw Error();
        const body = JSON.parse(text); if (Object.keys(body).sort().join() !== "authorization,signature" || typeof body.signature !== "string" || body.signature.length > 88) throw Error();
        auth = body.authorization; const message = payHistoryMessage(auth), signature = bs58.decode(body.signature);
        const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(bs58.decode(auth.wallet))]), format: "der", type: "spki" });
        if (signature.length !== 64 || bs58.encode(signature) !== body.signature || !verify(null, Buffer.from(message), key, signature)) throw Error();
      } catch { return send(400, { message: "Sign a fresh card history request with its owning wallet." }); }
      const load = read || ((wallet: string) => {
        if (process.env.PAY_ISSUER_HISTORY_ENABLED !== "true" || !process.env.DATABASE_URL) throw Error();
        return payIssuerStore(process.env.DATABASE_URL, payIssuerConfig()).statement(wallet);
      });
      const result = await load(auth.wallet);
      if (result.wallet !== auth.wallet || !Array.isArray(result.records) || result.records.length > 100 || !result.records.every(validPayRecord)) throw Error();
      return send(200, result);
    } catch { return send(503, { message: "Live card history is not connected yet. Sample purchases are separate." }); }
    finally { pending--; }
  };
}
export const handlePayHistory = payHistoryHandler();
