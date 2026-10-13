import { useCallback, useEffect, useRef, useState } from "react";
import type { AccountCopyPlan } from "./copy-account";
import type { CopyFeedReport } from "./copy-feed";
import { triggerRequest } from "./trigger-api";
import { shortAddress } from "./assets";
import { exactAmount } from "./portfolio-data";
import { USDC } from "./funding-model";
export function CopyFeed({
  plan,
  csrf,
}: {
  plan: AccountCopyPlan;
  csrf: string;
}) {
  const [report, setReport] = useState<CopyFeedReport | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [monitorUncertain, setMonitorUncertain] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const monitorRevision = useRef(0);
  const read = useCallback(
    (action: "copy-feed" | "copy-scan" | "copy-monitor", enabled?: boolean) => {
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      setBusy(true);
      setError("");
      void triggerRequest<CopyFeedReport>(
        action,
        {
          wallet: plan.wallet,
          id: plan.id,
          ...(action === "copy-monitor"
            ? {
                version: plan.version,
                revision: monitorRevision.current,
                enabled,
              }
            : {}),
        },
        csrf,
        controller.signal,
      )
        .then((result) => {
          if (result.planId !== plan.id || result.leader !== plan.address)
            throw new Error("Activity does not match this wallet.");
          if (!controller.signal.aborted) {
            monitorRevision.current = result.monitor?.revision || 0;
            setReport(result);
            setMonitorUncertain(false);
          }
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            if (action === "copy-monitor") setMonitorUncertain(true);
            setError(
              error instanceof Error
                ? error.message
                : "Activity is unavailable.",
            );
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            pending.current = null;
            setBusy(false);
          }
        });
    },
    [plan.wallet, plan.id, plan.address, plan.version, csrf],
  );
  useEffect(() => {
    read("copy-feed");
    return () => pending.current?.abort();
  }, [read]);
  return (
    <section className="copy-feed" aria-label="Leader activity checks">
      <div className="section-heading">
        <h3>Leader activity</h3>
        <button
          className="word-link"
          disabled={busy || plan.archived}
          onClick={() => {
            if (!pending.current && !plan.archived) read("copy-scan");
          }}
        >
          {busy ? "Checking…" : "Check new activity"}
        </button>
      </div>
      <p className="copy-help">
        The first check saves a starting point. Later checks inspect new
        finalized transactions. Activity checks never place trades.
      </p>
      <p className="copy-help">
        Recognizes supported Solana swaps against SOL or USDC,
        including verified wrapping and Token 2022 transfers. Mixed transactions
        and transfers with unexplained fees are excluded. Recognized activity
        does not enable trading.
      </p>
      {report?.monitor && (
        <div className="copy-monitor">
          <div className="section-heading">
            <h3>Background checks</h3>
            <button
              className="word-link"
              disabled={
                busy ||
                monitorUncertain ||
                plan.archived ||
                (!report.monitor.enabled &&
                  (!report.monitor.available || report.status === "gap"))
              }
              onClick={() => {
                if (!pending.current)
                  read("copy-monitor", !report.monitor!.enabled);
              }}
            >
              {report.monitor.enabled ? "Pause checks" : "Start checks"}
            </button>
          </div>
          <p className="copy-help">
            Checks continue after you close the site for up to seven days.
            Wallets take turns in a minute-based queue. This does not authorize
            trading.
          </p>
          <p className="copy-help" role="status">
            {monitorUncertain
              ? "The change could not be confirmed. Refresh saved activity before changing checks again."
              : !report.monitor.available
                ? "Background checks are unavailable. You can still check manually."
                : report.monitor.enabled
                  ? report.status === "gap"
                    ? "Checks need attention. The saved checkpoint could not be reached."
                    : report.monitor.outcome === "retry"
                      ? "A check failed. Saved progress is kept and the worker will retry."
                      : !report.monitor.workerLastStartedAt ||
                          Date.now() -
                            new Date(
                              report.monitor.workerLastStartedAt,
                            ).getTime() >
                            180000
                        ? "Waiting for the background worker. The last worker check is overdue or unavailable."
                        : "Background checks are on. New activity appears after your wallet is checked."
                  : report.monitor.expiresAt &&
                      new Date(report.monitor.expiresAt).getTime() <= Date.now()
                    ? "Checks expired. Start again to resume from the saved checkpoint."
                    : "Background checks are off."}
          </p>
          {report.monitor.enabled && report.monitor.expiresAt && (
            <p className="copy-help">
              Stops {new Date(report.monitor.expiresAt).toLocaleString()}.
              Editing or archiving this backup pauses checks.
            </p>
          )}
          <button
            className="word-link"
            disabled={busy}
            onClick={() => read("copy-feed")}
          >
            Refresh saved activity
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      {report && (
        <>
          <p role="status" className="copy-feed-status">
            {report.message}
          </p>
          {report.checkedAt && (
            <p className="copy-help">
              Last checked {new Date(report.checkedAt).toLocaleString()}
            </p>
          )}
          <ol>
            {report.events.map((event) => (
              <li key={event.signature}>
                <div>
                  <b>
                    {event.decision.kind === "swap"
                      ? `${event.decision.side === "buy" ? "Buy" : "Sell"} ${shortAddress(event.decision.mint)}`
                      : "Not a copy signal"}
                  </b>
                  <a
                    className="word-link"
                    href={`https://solscan.io/tx/${event.signature}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View transaction
                  </a>
                </div>
                <p>
                  {event.decision.kind === "swap"
                    ? `${exactAmount(event.decision.tokenRaw, event.decision.tokenDecimals)} tokens · ${exactAmount(event.decision.quoteRaw, event.decision.quoteDecimals)} ${event.decision.quoteMint === USDC ? "USDC" : event.decision.quoteMode === "native" ? "SOL" : "wSOL"}`
                    : event.decision.reason}
                </p>
                {event.decision.kind === "swap" &&
                  event.decision.separateNativeTransferLamports && (
                    <p className="copy-help">
                      Separate SOL transfer:{" "}
                      {exactAmount(event.decision.separateNativeTransferLamports, 9)}.
                      Excluded from the trade and never copied.
                    </p>
                  )}
                {event.decision.kind === "swap" &&
                  event.decision.separateQuoteTransferRaw && (
                    <p className="copy-help">
                      Separate USDC transfer:{" "}
                      {exactAmount(event.decision.separateQuoteTransferRaw, 6)}.
                      Excluded from the route amount.
                    </p>
                  )}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
