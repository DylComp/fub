import type { IncomingMessage, ServerResponse } from "node:http";
import { PayEventInvalid, payIssuerConfig, verifyPayEvent, type PayEvent, type PayIssuerScope } from "./pay-issuer.js";
import { payIssuerStore, PayEventConflict } from "./pay-issuer-store.js";
export function payIssuerWebhook(options?: { scope: PayIssuerScope; secret: string; receive: (e: PayEvent) => Promise<unknown> }) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("Content-Type", "application/json");
    const send = (code: number, message: string) => { res.statusCode = code; res.end(JSON.stringify({ message })); };
    if (req.method !== "POST") { res.setHeader("Allow", "POST"); return send(405, "POST required."); }
    if (new URL(req.url || "/", "http://local").search || !/^application\/json(?:;|$)/i.test(String(req.headers["content-type"])) ||
        (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity")) return send(415, "Unmodified JSON required.");
    if (Number(req.headers["content-length"]) > 262144) return send(413, "Event too large.");
    let config;
    try {
      config = options || (() => {
        if (process.env.PAY_ISSUER_EVENTS_ENABLED !== "true" || !process.env.PAY_STRIPE_WEBHOOK_SECRET || !process.env.DATABASE_URL) throw Error();
        const scope = payIssuerConfig();
        return { scope, secret: process.env.PAY_STRIPE_WEBHOOK_SECRET, receive: payIssuerStore(process.env.DATABASE_URL!, scope).receive };
      })();
    } catch { return send(503, "Card event receiver is not configured."); }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A parsed request body cannot be reserialized for signature verification.
      if ((req as IncomingMessage & { body?: unknown }).body !== undefined) throw new PayEventInvalid();
      const raw = await Promise.race([ (async () => {
        let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of req) { const b = Buffer.from(chunk); size += b.length; if (size > 262144) throw new PayEventInvalid(); chunks.push(b); }
        return Buffer.concat(chunks);
      })(), new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new PayEventInvalid()); req.destroy(); }, 3000); }) ]);
      clearTimeout(timer);
      const header = req.headers["stripe-signature"];
      if (typeof header !== "string") throw new PayEventInvalid();
      const event = verifyPayEvent(raw, header, config.secret, config.scope);
      if (!event) return send(200, "Ignored.");
      await config.receive(event); // No acknowledgement until durable inbox + resource queue commit.
      return send(200, "Received.");
    } catch (e) {
      if (e instanceof PayEventInvalid) return send(400, "Invalid card event.");
      if (e instanceof PayEventConflict) return send(409, "Conflicting card event.");
      return send(503, "Card event storage unavailable. Retry delivery.");
    } finally { clearTimeout(timer); }
  };
}
export const handlePayIssuerWebhook = payIssuerWebhook();
