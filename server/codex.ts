import type { IncomingMessage, ServerResponse } from "node:http";
import { PERIODS } from "../src/market-data.js";
import type { Candle, MarketReply, Period } from "../src/market-data.js";
import { mintFor } from "../src/assets.js";
const query = `query Chart($symbol: String!, $from: Int!, $to: Int!, $resolution: String!, $count: Int!) {
  getTokenBars(symbol: $symbol, from: $from, to: $to, resolution: $resolution, currencyCode: USD, countback: $count, removeLeadingNullValues: true) { s t o h l c volume }
}`;
const cache = new Map<string, { expires: number; value: MarketReply }>();
const pending = new Map<string, Promise<MarketReply>>();
let windowStart = 0;
let requests = 0;
let providerRetryAt = 0;
const CACHE_MS = 2000;
export function normalizeBars(raw: unknown): Candle[] {
  if (!raw || typeof raw !== "object")
    throw new Error("Invalid market response");
  const b = raw as Record<string, unknown>;
  if (b.s === "no_data") return [];
  const fields = ["t", "o", "h", "l", "c"] as const;
  if (b.s !== "ok" || fields.some((k) => !Array.isArray(b[k])))
    throw new Error("Invalid candles");
  const t = b.t as unknown[];
  if (
    t.length > 700 ||
    fields.some((k) => (b[k] as unknown[]).length !== t.length)
  )
    throw new Error("Invalid candle lengths");
  const candles = new Map<number, Candle>();
  for (let i = 0; i < t.length; i++) {
    const values = fields.map((k) => (b[k] as unknown[])[i]);
    if (
      values.some((v) => typeof v !== "number" || !Number.isFinite(v) || v <= 0)
    )
      continue;
    const [time, open, high, low, close] = values as number[];
    if (
      !Number.isInteger(time) ||
      time > Date.now() / 1000 + 60 ||
      high < Math.max(open, close) ||
      low > Math.min(open, close)
    )
      continue;
    const rawVolume = Array.isArray(b.volume) ? b.volume[i] : null;
    const volume =
      rawVolume === null || rawVolume === undefined || rawVolume === ""
        ? null
        : Number(rawVolume);
    candles.set(time, {
      time,
      open,
      high,
      low,
      close,
      volume:
        volume !== null && Number.isFinite(volume) && volume >= 0
          ? volume
          : null,
    });
  }
  if (t.length && !candles.size) throw new Error("No valid candles");
  return [...candles.values()].sort((a, b) => a.time - b.time);
}
async function fetchMarket(
  symbol: string,
  period: Period,
  apiKey: string,
  page: { before?: number; since?: number } = {},
): Promise<MarketReply> {
  const now = Math.floor(Date.now() / 1000);
  const config = PERIODS[period];
  const to = page.before ? page.before - 1 : now;
  const from = page.since ?? Math.max(1577836800, to - config.seconds);
  const response = await fetch("https://graph.codex.io/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({
      query,
      variables: {
        symbol: `${symbol}:1399811149`,
        from,
        to,
        resolution: config.resolution,
        count: page.since
          ? Math.min(700, Math.ceil((to - from) / config.step) + 1)
          : Math.ceil(config.seconds / config.step),
      },
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    if (response.status === 429) {
      const seconds = Number(response.headers.get("Retry-After") || 60);
      providerRetryAt =
        Date.now() +
        Math.min(
          300000,
          Math.max(5000, Number.isFinite(seconds) ? seconds * 1000 : 60000),
        );
    }
    throw new Error("Market provider unavailable");
  }
  const body = await response.json();
  if (body.errors?.length) throw new Error("Market provider rejected request");
  const bars = normalizeBars(body.data?.getTokenBars).filter((bar) =>
    page.before
      ? bar.time < page.before
      : page.since
        ? bar.time >= page.since
        : true,
  );
  if (!bars.length)
    return {
      status: "empty",
      message: "No candles available for this token and timeframe.",
    };
  return {
    status: "ready",
    bars,
    fetchedAt: Date.now(),
    stale: bars[bars.length - 1].time + config.step < now - 120,
  };
}
export async function handleMarket(
  req: IncomingMessage,
  res: ServerResponse,
  apiKey = process.env.CODEX_API_KEY,
) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  const send = (code: number, data: unknown) => {
    res.statusCode = code;
    res.end(JSON.stringify(data));
  };
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return send(405, { message: "GET required." });
  }
  const url = new URL(req.url || "/", "http://localhost");
  const symbol = url.searchParams.get("symbol") || "";
  const period = url.searchParams.get("period") || "";
  const beforeText = url.searchParams.get("before");
  const sinceText = url.searchParams.get("since");
  const timestamp = (value: string | null) =>
    value !== null &&
    /^\d{10}$/.test(value) &&
    Number(value) >= 1577836800 &&
    Number(value) <= Math.floor(Date.now() / 1000);
  if (
    !mintFor(symbol) ||
    !Object.hasOwn(PERIODS, period) ||
    [...url.searchParams.keys()].some(
      (k) => !["symbol", "period", "before", "since"].includes(k),
    ) ||
    url.searchParams.getAll("symbol").length !== 1 ||
    url.searchParams.getAll("period").length !== 1 ||
    url.searchParams.getAll("before").length > 1 ||
    url.searchParams.getAll("since").length > 1 ||
    (beforeText !== null && !timestamp(beforeText)) ||
    (sinceText !== null && !timestamp(sinceText)) ||
    (beforeText !== null && sinceText !== null)
  )
    return send(400, { message: "Choose a supported token and timeframe." });
  if (!apiKey)
    return send(200, {
      status: "unconfigured",
      message: "Market feed not connected. Showing sample candles.",
    });
  const mint = mintFor(symbol)!;
  const page = {
    before: beforeText === null ? undefined : Number(beforeText),
    since: sinceText === null ? undefined : Number(sinceText),
  };
  if (
    page.since &&
    page.since <
      Math.floor(Date.now() / 1000) - PERIODS[period as Period].seconds - 60
  )
    return send(400, {
      message: "Refresh window is too old. Reload the chart.",
    });
  const key = `${mint}:${period}:${page.before ?? ""}:${page.since ?? ""}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return send(200, cached.value);
  if (providerRetryAt > Date.now()) {
    res.setHeader(
      "Retry-After",
      String(Math.ceil((providerRetryAt - Date.now()) / 1000)),
    );
    return send(429, {
      status: "unavailable",
      message: "Market provider is busy. Retrying shortly.",
    });
  }
  let request = pending.get(key);
  if (!request) {
    if (Date.now() - windowStart > 60000) {
      windowStart = Date.now();
      requests = 0;
    }
    if (pending.size >= 8 || requests >= 60) {
      res.setHeader("Retry-After", "60");
      return send(429, {
        status: "unavailable",
        message: "Market feed is busy. Try again in a minute.",
      });
    }
    requests++;
    request = fetchMarket(mint, period as Period, apiKey, page).catch(
      (): MarketReply => ({
        status: "unavailable",
        message: "Market feed unavailable. Try again shortly.",
      }),
    );
    pending.set(key, request);
  }
  const value = await request;
  pending.delete(key);
  if (cache.size >= 200) cache.delete(cache.keys().next().value!);
  cache.set(key, {
    value,
    expires: Date.now() + (value.status === "ready" ? CACHE_MS : 10000),
  });
  // One short origin cache only: a CDN cache layered over it would compound the age.
  if (providerRetryAt > Date.now()) {
    res.setHeader(
      "Retry-After",
      String(Math.ceil((providerRetryAt - Date.now()) / 1000)),
    );
    return send(429, {
      status: "unavailable",
      message: "Market provider is busy. Retrying shortly.",
    });
  }
  return send(200, value);
}
