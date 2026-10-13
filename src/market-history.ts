import type { Candle } from "./market-data";

export const MAX_CHART_BARS = 2400;
export type HistoryStatus = "ready" | "loading" | "end" | "error" | "limit";

// Old-page responses cannot overwrite a newer live candle. Refreshes can revise
// existing bars; the newest request is still bound to its token/timeframe effect.
export function mergeCandles(
  current: Candle[],
  incoming: Candle[],
  older = false,
) {
  const rows = new Map<number, Candle>();
  for (const bar of older
    ? [...incoming, ...current]
    : [...current, ...incoming])
    rows.set(bar.time, bar);
  return [...rows.values()]
    .sort((a, b) => a.time - b.time)
    .slice(-MAX_CHART_BARS);
}

// Keep the same visible timestamps after prepend, trimming or historical repairs.
export function candleIndexShift(previous: Candle[], next: Candle[]) {
  const positions = new Map(next.map((b, i) => [b.time, i]));
  for (const [i, bar] of previous.entries()) {
    const index = positions.get(bar.time);
    if (index !== undefined) return index - i;
  }
  return 0;
}
