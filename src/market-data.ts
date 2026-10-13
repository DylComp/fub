export const PERIODS = {
  "1H": { resolution: "1", seconds: 3600, step: 60 },
  "1D": { resolution: "15", seconds: 86400, step: 900 },
  "1W": { resolution: "60", seconds: 604800, step: 3600 },
} as const;
export type Period = keyof typeof PERIODS;
export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};
export type MarketReply =
  | { status: "ready"; bars: Candle[]; fetchedAt: number; stale: boolean }
  | { status: "unconfigured" | "unavailable" | "empty"; message: string };
export type MarketState = {
  key: string;
  status: MarketReply["status"] | "loading";
  bars: Candle[];
  fetchedAt?: number;
  stale?: boolean;
  message?: string;
};

// Deliberately synthetic, repeatable candles. Never used as an upstream fallback after a live response.
export function sampleCandles(
  price: number,
  period: Period,
  now: number,
): Candle[] {
  const count = period === "1H" ? 60 : period === "1D" ? 96 : 168;
  const step = PERIODS[period].step;
  const end = Math.floor(now / 1000 / step) * step;
  const values = Array.from(
    { length: count + 1 },
    (_, i) =>
      price *
      (0.96 +
        (i / count) * 0.04 +
        Math.sin(i * 0.7) * 0.013 +
        Math.sin(i * 2.3) * 0.009),
  );
  values[count] = price;
  return Array.from({ length: count }, (_, i) => ({
    time: end - (count - 1 - i) * step,
    open: values[i],
    close: values[i + 1],
    high: Math.max(values[i], values[i + 1]) * 1.008,
    low: Math.min(values[i], values[i + 1]) * 0.992,
    volume: null,
  }));
}
