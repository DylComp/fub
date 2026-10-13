import type { Candle } from "./market-data";
const same = (a: Candle, b: Candle) =>
  a.time === b.time &&
  a.open === b.open &&
  a.high === b.high &&
  a.low === b.low &&
  a.close === b.close &&
  a.volume === b.volume;

// null means historical data changed and requires replacing the series.
// Otherwise update only the current candle and append new ones.
export function candleUpdates(
  previous: Candle[],
  next: Candle[],
): Candle[] | null {
  if (!previous.length || next.length < previous.length) return null;
  for (let i = 0; i < previous.length - 1; i++)
    if (!same(previous[i], next[i])) return null;
  const last = previous.length - 1;
  if (previous[last].time !== next[last].time) return null;
  return next.slice(same(previous[last], next[last]) ? last + 1 : last);
}
