import type { IncomingMessage, ServerResponse } from "node:http";
import { isMint } from "../src/assets.js";
import { fomoHandle } from "../src/fomo-identity.js";
import type { FomoLookup } from "../src/fomo-identity.js";

// This provider is independent of Fomo. Its index is attribution, never auth.
export function parseFomoLookup(raw: unknown, handle: string, now = Date.now()): FomoLookup | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid lookup");
  const body = raw as Record<string, unknown>;
  if (body.demo !== undefined || !body.data || typeof body.data !== "object" || Array.isArray(body.data)) throw new Error("Invalid lookup");
  const data = body.data as Record<string, unknown>;
  if (typeof data.handle !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,39}$/.test(data.handle) || fomoHandle(data.handle) !== handle) throw new Error("Mismatched username");
  if (data.solana === null || data.solana === "") return null;
  if (typeof data.solana !== "string" || !isMint(data.solana)) throw new Error("Invalid wallet");
  const observed = typeof data.last_seen_at === "string" ? Date.parse(data.last_seen_at) : NaN;
  return {
    handle, address: data.solana, source: "fomoapi.dev", fetchedAt: now,
    observedAt: Number.isFinite(observed) && observed > 0 && observed <= now ? observed : null,
  };
}

export function createFomoLookupHandler(getKey = () => process.env.FOMO_LOOKUP_API_KEY) {
  type Result = { status: number; body: FomoLookup | { message: string } };
  const cache = new Map<string, { expires: number; result: Result }>();
  const pending = new Map<string, Promise<Result>>();
  let windowStart = 0, requests = 0;
  const unavailable: Result = { status: 503, body: { message: "Username lookup is unavailable. Try again later or paste the trader's public Solana wallet." } };
  const missing: Result = { status: 404, body: { message: "No Solana wallet found in the index for this username. You can paste their public wallet instead." } };
  async function lookup(handle: string, key: string): Promise<Result> {
    try {
      const response = await fetch(`https://api.fomoapi.dev/v1/wallets/${encodeURIComponent(handle)}`, {
        headers: { "X-API-Key": key, Accept: "application/json" },
        redirect: "error", signal: AbortSignal.timeout(8000),
      });
      if (response.status === 404) { await response.body?.cancel(); return missing; }
      if (!response.ok) { await response.body?.cancel(); return unavailable; }
      // Bound even chunked bodies; do not log provider bodies or credentials.
      const reader = response.body?.getReader();
      if (!reader) return unavailable;
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 32768) { await reader.cancel(); return unavailable; }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      const data = parseFomoLookup(JSON.parse(Buffer.concat(chunks).toString("utf8")), handle);
      return data ? { status: 200, body: data } : missing;
    } catch { return unavailable; }
  }
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    const send = (result: Result) => { res.statusCode = result.status; res.end(JSON.stringify(result.body)); };
    if (req.method !== "GET") { res.setHeader("Allow", "GET"); return send({ status: 405, body: { message: "GET required." } }); }
    const params = new URL(req.url || "/", "http://localhost").searchParams;
    const raw = params.get("handle") || "";
    const handle = fomoHandle(raw);
    if (!handle || raw !== handle || params.getAll("handle").length !== 1 || params.getAll("action").length !== 1 || params.get("action") !== "identity" || [...params.keys()].some(key => !["action", "handle"].includes(key))) {
      return send({ status: 400, body: { message: "A Fomo username is required." } });
    }
    const key = getKey();
    if (!key) return send(unavailable);
    const now = Date.now(), cached = cache.get(handle);
    if (cached && cached.expires > now) return send(cached.result);
    let job = pending.get(handle);
    if (!job) {
      if (now - windowStart >= 60000) { requests = 0; windowStart = now; }
      // Per-instance quota protection; provider quotas remain the global limit.
      if (requests >= 20 || pending.size >= 4) {
        res.setHeader("Retry-After", "60");
        return send({ status: 429, body: { message: "Too many lookups. Try again in a minute." } });
      }
      requests++;
      job = lookup(handle, key).then(result => {
        if (cache.size >= 500) cache.delete(cache.keys().next().value!);
        cache.set(handle, { result, expires: Date.now() + (result.status === 200 ? 300000 : result.status === 404 ? 30000 : 5000) });
        return result;
      }).finally(() => pending.delete(handle));
      pending.set(handle, job);
    }
    return send(await job);
  };
}
export const handleFomoLookup = createFomoLookupHandler();
