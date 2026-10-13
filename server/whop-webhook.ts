import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyWhopEvent, whopConfig, WhopInputError } from "./whop-events.js";
import type { WhopConfig, WhopEvent } from "./whop-events.js";
import { whopEventStore, WhopEventConflict } from "./whop-store.js";

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 262144) throw new WhopInputError();
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
export async function handleWhopWebhook(req: IncomingMessage, res: ServerResponse, deps?: {
  config: WhopConfig;
  receive: (event: WhopEvent) => Promise<"received" | "duplicate">;
}) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  const send = (status: number, message: string) => { res.statusCode = status; res.end(JSON.stringify({ message })); };
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return send(405, "POST required."); }
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || "")) ||
      (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity"))
    return send(415, "JSON required.");
  if (Number(req.headers["content-length"] || 0) > 262144) return send(413, "Event too large.");
  let config: WhopConfig;
  try { config = deps?.config || whopConfig(); } catch { return send(503, "Event receiver is not configured."); }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([readRaw(req), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new WhopInputError()); req.destroy(); }, 3000);
    })]);
    clearTimeout(timer);
    const event = verifyWhopEvent(raw, req.headers, config);
    if (!event) return send(200, "Ignored.");
    const receive = deps?.receive || whopEventStore().receive;
    await receive(event);
    return send(200, "Received.");
  } catch (error) {
    if (error instanceof WhopInputError) {
      // Fixed internal reason codes only. Never log payloads, signature headers,
      // secrets, account identifiers or arbitrary exception messages.
      const codes = ["object", "headers_or_age", "signature", "json", "identity", "account", "missing_account", "version", "event_shape", "resource"];
      console.warn("Whop event rejected:", codes.includes(error.message) ? error.message : "body");
      if (error.envelopeShape) console.warn("Whop signed envelope shape:", JSON.stringify(error.envelopeShape));
      return send(400, "Invalid event.");
    }
    if (error instanceof WhopEventConflict) return send(409, "Event conflict.");
    // A failed write must cause provider retry. Never acknowledge an event
    // before its durable insert and never return provider/database errors.
    return send(503, "Event storage unavailable. Retry delivery.");
  } finally { clearTimeout(timer); }
}
