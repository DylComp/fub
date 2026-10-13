import type { IncomingMessage, ServerResponse } from "node:http";
import { NETWORKS, assetAddress, assetKey, isNetwork, parseNetworkTokenSearch } from "../src/networks.js";
import type { Network } from "../src/networks.js";
import { publicProviderJson } from './public-provider-json.js';
import type { DiscoveredToken, SearchReply } from "../src/assets.js";

const cache = new Map<string, { expires: number; data: SearchReply }>();
const pending = new Map<string, Promise<SearchReply>>();
let windowStart = 0;
let requests = 0;
const text = (v: unknown, max: number) =>
  typeof v === "string"
    ? v
        .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
        .trim()
        .slice(0, max)
    : "";
const positive = (v: unknown): number | null => {
  if (
    v === null ||
    v === undefined ||
    v === "" ||
    !["string", "number"].includes(typeof v)
  )
    return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
export function normalizeTokens(
  raw: unknown,
  exactMint?: string,
  limit = 12,
  chain: Network = 'solana',
): DiscoveredToken[] {
  if (!Array.isArray(raw)) throw new Error("Invalid search response");
  const found = new Map<string, DiscoveredToken>();
  for (const pair of raw.slice(0, 100)) {
    if (!pair || pair.chainId !== NETWORKS[chain].dexId) continue;
    const address = assetAddress(chain,
      typeof pair.baseToken?.address === "string" ? pair.baseToken.address : "");
    const price = positive(pair.priceUsd);
    if (!address || (exactMint && address !== assetAddress(chain, exactMint)) || !price)
      continue;
    const symbol = text(pair.baseToken?.symbol, 24);
    const name = text(pair.baseToken?.name, 80);
    if (!symbol || !name) continue;
    const token: DiscoveredToken = {
      address,
      chain,
      assetId: assetKey(chain, address),
      symbol,
      name,
      price,
      marketCap: positive(pair.marketCap),
      liquidity: positive(pair.liquidity?.usd),
      volume: positive(pair.volume?.h24),
    };
    try {
      const image = new URL(pair.info?.imageUrl);
      if (
        image.protocol === "https:" &&
        image.hostname === "cdn.dexscreener.com" &&
        !image.username &&
        !image.password
      )
        token.image = image.href;
    } catch {
      /* A logo is optional. */
    }
    const existing = found.get(address);
    if (!existing || (token.liquidity ?? -1) > (existing.liquidity ?? -1))
      found.set(address, token);
  }
  return [...found.values()]
    .sort(
      (a, b) =>
        (b.volume ?? -1) - (a.volume ?? -1) ||
        (b.liquidity ?? -1) - (a.liquidity ?? -1),
    )
    .slice(0, Math.min(30, limit));
}
async function search(query: string, chain: Network): Promise<SearchReply> {
  const exact = assetAddress(chain, query);
  const path = exact
    ? `/token-pairs/v1/${NETWORKS[chain].dexId}/${exact}`
    : `/latest/dex/search?q=${encodeURIComponent(query)}`;
  const response = await fetch(`https://api.dexscreener.com${path}`, {
    signal: AbortSignal.timeout(8000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error("Search unavailable");
  const body = await publicProviderJson(response) as { pairs?: unknown };
  return {
    tokens: normalizeTokens(
      exact ? body : body.pairs,
      exact ? query : undefined,
      30,
      chain,
    ).filter(token => exact || `${token.symbol} ${token.name}`.toLowerCase().includes(query.toLowerCase().replace(/^\$/, ''))).slice(0, 12),
    fetchedAt: Date.now(),
  };
}
export async function handleSearch(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  const send = (code: number, body: unknown) => {
    res.statusCode = code;
    res.end(JSON.stringify(body));
  };
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return send(405, { message: "GET required." });
  }
  const params = new URL(req.url || "/", "http://localhost").searchParams;
  const requestedChain = params.get('chain') ?? 'solana';
  if (!isNetwork(requestedChain)) return send(400, { message: 'Choose a supported network.' });
  const input = parseNetworkTokenSearch(params.get("q") || "", requestedChain);
  const query = input.query;
  if (
    params.getAll("q").length !== 1 ||
    params.getAll('chain').length > 1 ||
    [...params.keys()].some((key) => key !== "q" && key !== 'chain') ||
    input.chain !== requestedChain ||
    query.length < 2 ||
    !!input.error
  )
    return send(400, {
      message: input.error || "Choose the token's network and enter its name, ticker, contract, or Fomo token link.",
    });
  const key = `${requestedChain}:${query}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return send(200, cached.data);
  let task = pending.get(key);
  if (!task) {
    if (Date.now() - windowStart > 60000) {
      windowStart = Date.now();
      requests = 0;
    }
    if (pending.size >= 8 || requests >= 90) {
      res.setHeader("Retry-After", "60");
      return send(429, { message: "Search is busy. Try again in a minute." });
    }
    requests++;
    task = search(query, requestedChain);
    pending.set(key, task);
  }
  try {
    const data = await task;
    if (cache.size >= 200) cache.delete(cache.keys().next().value!);
    cache.set(key, { data, expires: Date.now() + 30000 });
    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=15");
    return send(200, data);
  } catch {
    return send(503, {
      message: "Token search is unavailable. Try again shortly.",
    });
  } finally {
    pending.delete(key);
  }
}
