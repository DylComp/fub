import { useCallback, useEffect, useRef, useState } from "react";
import type { Symbol } from "./model";
import type { Network } from "./networks";
import { useLiveCandles } from "./useLiveCandles";
import type { MarketReply, MarketState, Period } from "./market-data";
import { PERIODS } from "./market-data";
import { MAX_CHART_BARS, mergeCandles } from "./market-history";
import type { HistoryStatus } from "./market-history";

export const MARKET_REFRESH_MS = 5000;
const recent = new Map<string, MarketState>();
function remembered(key: string): MarketState {
  const cached = recent.get(key);
  return cached && cached.fetchedAt && Date.now() - cached.fetchedAt < 300000
    ? { ...cached, status: "loading", stale: true }
    : { key, status: "loading", bars: [] };
}
export function useMarket(symbol: Symbol, period: Period, enabled = true, network: Network = "solana") {
  const key = `${network}:${symbol}:${period}`;
  const [state, setState] = useState<MarketState>(() => remembered(key));
  const [retry, setRetry] = useState(0);
  const [history, setHistory] = useState<{
    key: string;
    status: HistoryStatus;
  }>({ key, status: "ready" });
  const loadRef = useRef<() => void>(() => {});
  const loadEarlier = useCallback(() => loadRef.current(), []);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let busy = false;
    let unconfigured = false;
    let failures = 0;
    let nextAllowed = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let historyController: AbortController | undefined;
    let historyBusy = false;
    let historyDone = false;
    let current = remembered(key);
    setHistory({ key, status: "ready" });
    function remember(next: MarketState) {
      current = next;
      if (recent.size >= 20 && !recent.has(key))
        recent.delete(recent.keys().next().value!);
      recent.delete(key);
      recent.set(key, next);
      setState(next);
    }
    loadRef.current = async () => {
      if (
        stopped ||
        historyBusy ||
        historyDone ||
        !current.bars.length ||
        document.hidden ||
        !navigator.onLine
      )
        return;
      if (current.bars.length >= MAX_CHART_BARS) {
        setHistory({ key, status: "limit" });
        return;
      }
      if (Date.now() < nextAllowed) {
        setHistory({ key, status: "error" });
        return;
      }
      historyBusy = true;
      setHistory({ key, status: "loading" });
      const before = current.bars[0].time;
      const request = (historyController = new AbortController());
      const timeout = setTimeout(() => request.abort(), 10000);
      try {
        const response = await fetch(
          `/api/market?symbol=${encodeURIComponent(symbol)}&period=${period}&network=${network}&before=${before}`,
          { signal: request.signal, cache: "no-store" },
        );
        if (!response.ok) {
          if (response.status === 429 || response.status === 503)
            nextAllowed =
              Date.now() +
              Math.max(
                5000,
                Math.min(
                  300000,
                  (Number(response.headers.get("Retry-After")) || 60) * 1000,
                ),
              );
          throw Error("History unavailable");
        }
        const body = (await response.json()) as MarketReply;
        if (stopped) return;
        if (body.status === "empty") {
          historyDone = true;
          setHistory({ key, status: "end" });
          return;
        }
        if (
          body.status !== "ready" ||
          !Array.isArray(body.bars) ||
          !body.bars.length ||
          !Number.isFinite(body.fetchedAt)
        )
          throw Error("Invalid history");
        const older = body.bars.filter((b) => b.time < before);
        if (!older.length) throw Error("History did not advance");
        const bars = mergeCandles(current.bars, older, true);
        remember({ ...current, bars });
        setHistory({
          key,
          status: bars.length >= MAX_CHART_BARS ? "limit" : "ready",
        });
      } catch {
        if (!stopped) setHistory({ key, status: "error" });
      } finally {
        clearTimeout(timeout);
        historyBusy = false;
      }
    };
    setState((prev) =>
      prev.key === key ? { ...prev, status: "loading" } : remembered(key),
    );
    const schedule = (delay: number) => {
      clearTimeout(timer);
      if (!stopped && !document.hidden && navigator.onLine && !unconfigured)
        timer = setTimeout(update, delay);
    };
    async function update() {
      if (
        stopped ||
        busy ||
        document.hidden ||
        !navigator.onLine ||
        unconfigured
      )
        return;
      if (Date.now() < nextAllowed) {
        schedule(nextAllowed - Date.now());
        return;
      }
      busy = true;
      const started = Date.now();
      controller = new AbortController();
      const request = controller;
      const timeout = setTimeout(() => request.abort(), 10000);
      let delay = MARKET_REFRESH_MS;
      try {
        const last = current.bars.at(-1)?.time;
        const since = last ? last - PERIODS[period].step * 2 : 0;
        const incremental =
          since > Math.floor(Date.now() / 1000) - PERIODS[period].seconds;
        const response = await fetch(
          `/api/market?symbol=${encodeURIComponent(symbol)}&period=${period}&network=${network}${incremental ? `&since=${since}` : ""}`,
          { signal: request.signal, cache: "no-store" },
        );
        if (!response.ok) {
          if (response.status === 429 || response.status === 503) {
            const value = response.headers.get("Retry-After");
            const seconds = Number(value);
            const wait =
              value && Number.isFinite(seconds)
                ? seconds * 1000
                : value
                  ? Date.parse(value) - Date.now()
                  : 60000;
            nextAllowed =
              Date.now() +
              Math.max(
                MARKET_REFRESH_MS,
                Math.min(300000, Number.isFinite(wait) ? wait : 60000),
              );
          }
          throw new Error("Unable to load market data.");
        }
        const body = (await response.json()) as MarketReply;
        if (
          !["ready", "unconfigured", "unavailable", "empty"].includes(
            body.status,
          )
        )
          throw new Error("Invalid market response.");
        if (
          body.status === "ready" &&
          (!Array.isArray(body.bars) ||
            !body.bars.length ||
            !Number.isFinite(body.fetchedAt))
        )
          throw new Error("Invalid candles.");
        if (stopped) return;
        unconfigured = body.status === "unconfigured";
        if (body.status === "ready") {
          failures = 0;
          remember({
            key,
            ...body,
            bars: mergeCandles(current.bars, body.bars),
          });
        } else {
          delay =
            body.status === "empty"
              ? 30000
              : Math.min(30000, MARKET_REFRESH_MS * 2 ** ++failures);
          current = {
            ...current,
            key,
            status: body.status,
            message: body.message,
            stale: true,
          };
          setState(current);
        }
      } catch {
        if (!stopped) {
          delay = Math.min(30000, MARKET_REFRESH_MS * 2 ** ++failures);
          current = {
            ...current,
            key,
            status: "unavailable",
            stale: true,
            message: "Market feed unavailable. Try again shortly.",
          };
          setState(current);
        }
      } finally {
        clearTimeout(timeout);
        busy = false;
        schedule(
          Math.max(0, delay - (Date.now() - started), nextAllowed - Date.now()),
        );
      }
    }
    const wake = () => {
      clearTimeout(timer);
      if (!document.hidden && navigator.onLine) void update();
      else { controller?.abort(); historyController?.abort(); }
    };
    void update();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    window.addEventListener("offline", wake);
    return () => {
      stopped = true;
      controller?.abort();
      historyController?.abort();
      loadRef.current = () => {};
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("offline", wake);
    };
  }, [key, symbol, period, retry, enabled, network]);
  const stream = useLiveCandles(symbol, network, enabled && period === "1S", retry);
  const visible = state.key === key ? state : remembered(key);
  const liveBars = stream.key === `${network}:${symbol}` ? stream.bars : [];
  return {
    stream: stream.status,
    streamMessage: stream.message,
    market: liveBars.length ? { ...visible, status: "ready" as const, bars: mergeCandles(visible.bars, liveBars), fetchedAt: stream.updatedAt, stale: stream.status !== "live" } : state.key === key ? state : remembered(key),
    retry: () => setRetry((n) => n + 1),
    history: history.key === key ? history.status : ("ready" as HistoryStatus),
    loadEarlier,
  };
}
