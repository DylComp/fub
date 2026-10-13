import { isMint } from "../src/assets.js";
import { fomoResolverStore } from "./fomo-resolver-store.js";
import { fomoHandle, validFomoLookup } from "../src/fomo-identity.js";
import type { FomoLookup } from "../src/fomo-identity.js";
import { parseFomoLookup } from "./fomo-lookup.js";

export class FomoProfileUnavailable extends Error {
  constructor() { super("Fomo profile lookup is unavailable. Your wallet remains connected. Try again later."); }
}
export function parseFomoProfiles(raw: unknown, wallet: string, now = Date.now()): FomoLookup[] {
  if (!isMint(wallet) || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new FomoProfileUnavailable();
  const body = raw as Record<string, unknown>;
  if (body.demo !== undefined || !Array.isArray(body.data) || body.data.length > 20 || body.count !== body.data.length) throw new FomoProfileUnavailable();
  const seen = new Set<string>();
  return body.data.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new FomoProfileUnavailable();
    const row = value as Record<string, unknown>;
    const handle = typeof row.handle === "string" ? fomoHandle(row.handle) : null;
    if (!handle || row.solana !== wallet || seen.has(handle)) throw new FomoProfileUnavailable();
    const result = parseFomoLookup({ data: row }, handle, now);
    if (!result) throw new FomoProfileUnavailable();
    seen.add(handle);
    return result;
  });
}
export function createFomoProfileLookup(getKey = () => process.env.FOMO_LOOKUP_API_KEY,
  direct: (wallet:string)=>Promise<FomoLookup[]> = async wallet => {
    if(process.env.FOMO_DIRECT_LOOKUP_ENABLED!=='true'||!process.env.DATABASE_URL)return [];
    const profiles=await fomoResolverStore(process.env.DATABASE_URL).profilesForWallet(wallet);
    return profiles.map(({handle,address,source,fetchedAt,observedAt})=>({handle,address:address!,source,fetchedAt,observedAt}));
  },
) {
  const pending = new Map<string, Promise<FomoLookup[]>>();
  const cache = new Map<string, { expires: number; profiles: FomoLookup[] }>();
  let minute = 0, calls = 0;
  return async (wallet: string): Promise<FomoLookup[]> => {
    const key = getKey(), now = Date.now();
    if (!isMint(wallet)) throw new FomoProfileUnavailable();
    // Re-read owned evidence on every verification: an old in-memory index
    // result cannot mask expiry, a changed wallet, or an owned conflict.
    try {
      const profiles=await direct(wallet);
      if(profiles.length>20||new Set(profiles.map(p=>p.handle)).size!==profiles.length||profiles.some(p=>p.source!=='fomo-direct'||fomoHandle(p.handle)!==p.handle||p.address!==wallet||!validFomoLookup(p,p.handle)))throw Error();
      if(profiles.length)return profiles;
    } catch { throw new FomoProfileUnavailable(); }
    if (!key) throw new FomoProfileUnavailable();
    const saved = cache.get(wallet);
    if (saved && saved.expires > now) return saved.profiles;
    const running = pending.get(wallet);
    if (running) return running;
    if (now - minute >= 60000) { minute = now; calls = 0; }
    if (calls >= 20 || pending.size >= 4) throw new FomoProfileUnavailable();
    calls++;
    const job = (async () => {
      try {
        const response = await fetch(`https://api.fomoapi.dev/v1/lookup/solana/${wallet}`, {
          headers: { "X-API-Key": key, Accept: "application/json" },
          redirect: "error", signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) { await response.body?.cancel(); throw new FomoProfileUnavailable(); }
        const reader = response.body?.getReader();
        if (!reader) throw new FomoProfileUnavailable();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 65536) { await reader.cancel(); throw new FomoProfileUnavailable(); }
            chunks.push(part.value);
          }
        } finally { reader.releaseLock(); }
        const profiles = parseFomoProfiles(JSON.parse(Buffer.concat(chunks).toString("utf8")), wallet);
        if (cache.size >= 200) cache.delete(cache.keys().next().value!);
        cache.set(wallet, { profiles, expires: Date.now() + (profiles.length ? 300000 : 30000) });
        return profiles;
      } catch { throw new FomoProfileUnavailable(); }
      finally { pending.delete(wallet); }
    })();
    pending.set(wallet, job);
    return job;
  };
}
export const lookupFomoProfiles = createFomoProfileLookup();
