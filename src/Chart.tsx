import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  LineStyle,
} from "lightweight-charts";
import type {
  AutoscaleInfo,
  IChartApi,
  ISeriesApi,
  UTCTimestamp,
} from "lightweight-charts";
import type { Draft, Symbol } from "./model";
import { priceLabel, TOKENS } from "./model";
import { priceDecimals } from "./assets";
import { sampleCandles } from "./market-data";
import type { Candle, MarketState, Period } from "./market-data";
import { candleUpdates } from "./chart-updates";
import { candleIndexShift } from "./market-history";
import type { HistoryStatus } from "./market-history";

type RuleField = "target" | "stop";
export function Chart({
  symbol,
  label,
  price,
  draft,
  change,
  period,
  setPeriod,
  market,
  retry,
  history,
  loadEarlier,
}: {
  symbol: Symbol;
  label: string;
  price: number;
  draft: Draft;
  change: (value: Partial<Draft>) => void;
  period: Period;
  setPeriod: (p: Period) => void;
  market: MarketState;
  retry: () => void;
  history: HistoryStatus;
  loadEarlier: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const api = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volume = useRef<ISeriesApi<"Histogram"> | null>(null);
  const buttons = useRef<Partial<Record<RuleField, HTMLButtonElement | null>>>(
    {},
  );
  const draftRef = useRef(draft);
  const priceRef = useRef(price);
  draftRef.current = draft;
  priceRef.current = price;
  const [now] = useState(Date.now);
  const [hover, setHover] = useState("");
  const [ready, setReady] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [showSample, setShowSample] = useState(false);
  const historyRef = useRef({ history, loadEarlier });
  historyRef.current = { history, loadEarlier };
  const scrollIntent = useRef(false);
  const live = market.bars.length > 0 && !showSample;
  const sample = !live && (showSample || market.status === "unconfigured");
  const example = useMemo(
    () => sampleCandles(price, period, now),
    [price, period, now],
  );
  const data = live ? market.bars : sample ? example : [];
  const rangeKey = `${symbol}:${period}:${live ? "market" : "sample"}`;
  const previousKey = useRef("");
  const previousBars = useRef<Candle[]>([]);
  const precision =
    TOKENS.find((t) => t.id === symbol)?.decimals ?? priceDecimals(price);
  const rules =
    draft.kind === "Trailing"
      ? [
          {
            field: "stop" as const,
            value: price * (1 - draft.trail / 100),
            label: `Trail ${draft.trail}%`,
            editable: false,
          },
        ]
      : [
          {
            field: "target" as const,
            value: draft.target,
            label: draft.kind === "Limit" ? `${draft.side} limit` : "TP",
            editable: true,
          },
          ...(draft.kind === "Bracket"
            ? [
                {
                  field: "stop" as const,
                  value: draft.stop,
                  label: "SL",
                  editable: true,
                },
              ]
            : []),
        ];

  useEffect(() => {
    if (!container.current) return;
    const chart = createChart(container.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#101019" },
        textColor: "#9292a8",
        fontFamily: "Aeonik, sans-serif",
        fontSize: 11,
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: "#1c1c29", style: LineStyle.Dotted },
        horzLines: { color: "#23232f", style: LineStyle.Dotted },
      },
      rightPriceScale: {
        borderVisible: false,
        minimumWidth: 85,
        scaleMargins: { top: 0.16, bottom: 0.22 },
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 5,
      },
      crosshair: {
        vertLine: { color: "#686b8f", labelBackgroundColor: "#282940" },
        horzLine: { color: "#686b8f", labelBackgroundColor: "#282940" },
      },
      handleScroll: { vertTouchDrag: false },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#80cdb6",
      downColor: "#c8849e",
      borderVisible: false,
      wickUpColor: "#80cdb6",
      wickDownColor: "#c8849e",
      priceFormat: { type: "price", precision, minMove: 10 ** -precision },
      lastValueVisible: true,
      priceLineVisible: false,
    });
    const histogram = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    histogram
      .priceScale()
      .applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } });
    api.current = chart;
    candles.current = series;
    volume.current = histogram;
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (
        range &&
        range.from < -3 &&
        scrollIntent.current &&
        historyRef.current.history === "ready"
      ) {
        scrollIntent.current = false;
        historyRef.current.loadEarlier();
      }
    });
    chart.subscribeCrosshairMove((param) => {
      const bar = param.seriesData.get(series);
      if (bar && "close" in bar)
        setHover(
          `O ${priceLabel(symbol, bar.open)}  H ${priceLabel(symbol, bar.high)}  L ${priceLabel(symbol, bar.low)}  C ${priceLabel(symbol, bar.close)}`,
        );
      else setHover("");
    });
    let frame: number;
    const position = () => {
      const d = draftRef.current;
      for (const field of ["target", "stop"] as const) {
        const button = buttons.current[field];
        if (!button) continue;
        const value =
          d.kind === "Trailing"
            ? priceRef.current * (1 - d.trail / 100)
            : d[field];
        const y = Number.isFinite(value)
          ? series.priceToCoordinate(value)
          : null;
        button.style.top = `${y ?? -100}px`;
        button.style.visibility =
          y === null || y < 0 || y > (container.current?.clientHeight ?? 0) - 28
            ? "hidden"
            : "visible";
      }
      frame = requestAnimationFrame(position);
    };
    frame = requestAnimationFrame(position);
    previousKey.current = "";
    previousBars.current = [];
    setReady(true);
    return () => {
      cancelAnimationFrame(frame);
      chart.remove();
      api.current = null;
      candles.current = null;
      volume.current = null;
    };
  }, [symbol]);

  useEffect(() => {
    candles.current?.applyOptions({
      priceFormat: { type: "price", precision, minMove: 10 ** -precision },
    });
  }, [precision, ready]);

  useEffect(() => {
    const series = candles.current;
    if (!series) return;
    series.applyOptions({
      autoscaleInfoProvider: (base: () => AutoscaleInfo | null) => {
        const info = base();
        if (!info?.priceRange) return info;
        const d = draftRef.current;
        const values =
          d.kind === "Trailing"
            ? [priceRef.current * (1 - d.trail / 100)]
            : d.kind === "Bracket"
              ? [d.target, d.stop]
              : [d.target];
        for (const value of values) {
          if (Number.isFinite(value) && value > 0) {
            info.priceRange.minValue = Math.min(
              info.priceRange.minValue,
              value,
            );
            info.priceRange.maxValue = Math.max(
              info.priceRange.maxValue,
              value,
            );
          }
        }
        return info;
      },
    });
  }, [draft.target, draft.stop, draft.kind, draft.trail, price, symbol, ready]);

  useEffect(() => {
    if (!candles.current || !volume.current) return;
    const updates =
      previousKey.current === rangeKey
        ? candleUpdates(previousBars.current, data)
        : null;
    const volumeBar = (b: Candle) =>
      b.volume === null
        ? { time: b.time as UTCTimestamp }
        : {
            time: b.time as UTCTimestamp,
            value: b.volume!,
            color: b.close >= b.open ? "#29453f" : "#49313e",
          };
    if (updates === null) {
      const visible =
        previousKey.current === rangeKey
          ? api.current?.timeScale().getVisibleLogicalRange()
          : null;
      const shift = candleIndexShift(previousBars.current, data);
      candles.current.setData(
        data.map((b) => ({ ...b, time: b.time as UTCTimestamp })),
      );
      volume.current.setData(data.map(volumeBar));
      if (visible)
        api.current
          ?.timeScale()
          .setVisibleLogicalRange({
            from: visible.from + shift,
            to: visible.to + shift,
          });
    } else {
      for (const bar of updates) {
        candles.current.update({ ...bar, time: bar.time as UTCTimestamp });
        volume.current.update(volumeBar(bar));
      }
    }
    previousBars.current = data;
    if (data.length && previousKey.current !== rangeKey) {
      api.current?.timeScale().fitContent();
      previousKey.current = rangeKey;
    }
  }, [data, rangeKey, ready]);

  function drag(e: React.PointerEvent<HTMLButtonElement>, field: RuleField) {
    const rect = container.current?.getBoundingClientRect();
    if (!rect) return;
    const value = candles.current?.coordinateToPrice(e.clientY - rect.top);
    if (
      value !== null &&
      value !== undefined &&
      Number.isFinite(value) &&
      value > 0
    )
      change({ [field]: Number(value.toFixed(precision)) });
  }
  const stale = live && (market.stale || market.status !== "ready");
  return (
    <div className={`chart-wrap ${expanded ? "chart-expanded" : ""}`}>
      <div className="chart-toolbar">
        {(!live || stale) && (
          <div className="chart-source">
            <span className="source-dot" />
            {stale
              ? "Market data delayed"
              : sample
                ? "Sample candles"
                : market.status === "loading"
                  ? "Connecting market feed"
                  : "Market data unavailable"}
          </div>
        )}
        <div className="periods" aria-label="Chart timeframe">
          {(["1H", "1D", "1W"] as Period[]).map((p) => (
            <button
              key={p}
              className={period === p ? "selected" : ""}
              aria-pressed={period === p}
              onClick={() => setPeriod(p)}
            >
              {p}
            </button>
          ))}
        </div>
      </div>
      <div className="chart-readout" aria-live="off">
        {hover ||
          (data.length
            ? "Drag a level to adjust your preview order."
            : "\u00a0")}
      </div>
      <div
        className="price-chart"
        aria-label={`${label} ${live ? "market" : "sample"} candlestick chart`}
      >
        <div
          className="candle-canvas"
          ref={container}
          onPointerDown={() => {
            scrollIntent.current = live;
          }}
          onWheel={() => {
            scrollIntent.current = live;
          }}
        />
        {data.length > 0 &&
          rules
            .filter((r) => Number.isFinite(r.value) && r.value > 0)
            .map((rule) => (
              <button
                key={rule.field}
                ref={(el) => {
                  buttons.current[rule.field] = el;
                }}
                className={`chart-rule rule-${rule.field} ${draft.kind === "Limit" && draft.side === "Sell" ? "rule-sell" : ""}`}
                role="slider"
                aria-label={`${rule.label} chart level`}
                aria-valuemin={10 ** -precision}
                aria-valuenow={rule.value}
                aria-valuetext={priceLabel(symbol, rule.value)}
                aria-readonly={!rule.editable}
                style={{ touchAction: rule.editable ? "none" : "auto" }}
                onPointerDown={(e) => {
                  if (!rule.editable) return;
                  api.current
                    ?.priceScale("right")
                    .applyOptions({ autoScale: false });
                  e.currentTarget.setPointerCapture(e.pointerId);
                  drag(e, rule.field);
                }}
                onPointerMove={(e) => {
                  if (
                    rule.editable &&
                    e.currentTarget.hasPointerCapture(e.pointerId)
                  )
                    drag(e, rule.field);
                }}
                onLostPointerCapture={() =>
                  api.current
                    ?.priceScale("right")
                    .applyOptions({ autoScale: true })
                }
                onPointerUp={(e) => {
                  if (e.currentTarget.hasPointerCapture(e.pointerId))
                    e.currentTarget.releasePointerCapture(e.pointerId);
                }}
                onKeyDown={(e) => {
                  if (
                    !rule.editable ||
                    !["ArrowUp", "ArrowDown"].includes(e.key)
                  )
                    return;
                  e.preventDefault();
                  change({
                    [rule.field]: Number(
                      Math.max(
                        10 ** -precision,
                        rule.value +
                          price *
                            (e.shiftKey ? 0.01 : 0.001) *
                            (e.key === "ArrowUp" ? 1 : -1),
                      ).toFixed(precision),
                    ),
                  });
                }}
              >
                <span>
                  {rule.label} {priceLabel(symbol, rule.value)}
                </span>
              </button>
            ))}
        {!data.length && (
          <div className="chart-empty">
            <strong>
              {market.status === "loading"
                ? "Loading candles…"
                : "Market feed unavailable"}
            </strong>
            <p>{market.message || "Fetching token history from Codex."}</p>
            {market.status !== "loading" && (
              <button className="word-link" onClick={() => setShowSample(true)}>
                View sample chart
              </button>
            )}
          </div>
        )}
      </div>
      <div className="chart-footnote">
        <span>
          {sample
            ? "Illustrative data · not market prices"
            : market.fetchedAt
              ? `Fetched ${new Date(market.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })} · UTC chart`
              : "USD · UTC chart"}
        </span>
        <div>
          {live && (
            <button
              className="word-link"
              onClick={loadEarlier}
              disabled={["loading", "end", "limit"].includes(history)}
            >
              {history === "loading"
                ? "Loading history…"
                : history === "end"
                  ? "Start of available history"
                  : history === "limit"
                    ? "History limit reached"
                    : history === "error"
                      ? "Retry history"
                      : "Earlier candles"}
            </button>
          )}
          {(market.status !== "ready" || showSample) && (
            <button
              className="word-link"
              onClick={() => {
                setShowSample(false);
                retry();
              }}
            >
              Retry feed
            </button>
          )}
          <button
            className="word-link"
            onClick={() => api.current?.timeScale().fitContent()}
          >
            Reset view
          </button>
          <button
            className="word-link"
            aria-pressed={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "Compact" : "Expand"}
          </button>
        </div>
      </div>
      {live && history === "error" && (
        <p className="feed-note" role="status">
          Earlier candles could not load. Current candles remain on the chart.
        </p>
      )}
      {market.status === "unconfigured" && (
        <p className="feed-note">
          Codex feed not connected. Orders remain in preview.
        </p>
      )}
    </div>
  );
}
