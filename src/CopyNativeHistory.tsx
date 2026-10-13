import { useEffect, useState } from "react";
import { triggerRequest } from "./trigger-api";
import { shortAddress } from "./assets";
import { tokenUnits } from "./copy-inventory";
import { nativeTradeStatus, nativeConfirmationDelayed } from "./native-history";
import type { NativeHistoryReport } from "./native-history";

export function CopyNativeHistory({
  wallet,
  planId,
  csrf,
}: {
  wallet: string;
  planId: string;
  csrf: string;
}) {
  const [report, setReport] = useState<NativeHistoryReport | null>(null);
  const [busy, setBusy] = useState(true),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  const pending = !!report?.trades.some((t) => t.accounting === "reserved");
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError("");
    triggerRequest<NativeHistoryReport>(
      "copy-native-history",
      { wallet, id: planId },
      csrf,
      controller.signal,
    )
      .then((value) => {
        if (
          value.wallet !== wallet ||
          value.planId !== planId ||
          !Array.isArray(value.trades)
        )
          throw Error("History mismatch.");
        if (!controller.signal.aborted) setReport(value);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError(
            "SOL trade history could not be refreshed. Saved records are unchanged.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [wallet, planId, csrf, revision]);
  useEffect(() => {
    if (!pending || busy) return;
    const refresh = () => {
      if (document.visibilityState === "visible" && navigator.onLine)
        setRevision((n) => n + 1);
    };
    const timer = window.setInterval(refresh, error ? 30000 : 15000);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [pending, busy, error]);
  return (
    <section
      className="copy-feed copy-history"
      aria-label="SOL trade history"
      aria-busy={busy}
    >
      <div className="section-heading">
        <h3>SOL trade history</h3>
        <button
          className="word-link"
          disabled={busy}
          onClick={() => setRevision((n) => n + 1)}
        >
          {busy ? "Loading…" : "Refresh SOL history"}
        </button>
      </div>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {report && (
        <>
          <dl className="copy-history-totals">
            <div>
              <dt>Spent today (UTC)</dt>
              <dd>{tokenUnits(report.spentTodayLamports, 9)} SOL</dd>
            </div>
            <div>
              <dt>Held across all days</dt>
              <dd>{tokenUnits(report.heldLamports, 9)} SOL</dd>
            </div>
            <div>
              <dt>Accounted sale proceeds</dt>
              <dd>{tokenUnits(report.proceedsLamports, 9)} WSOL</dd>
            </div>
          </dl>
          <p className="copy-help">
            Sale proceeds are receipts before buy costs and network fees, not
            profit. Unresolved trades keep their spending reserved.
          </p>
          {!report.trades.length && (
            <p role="status" className="muted">
              No SOL copy trades recorded for this plan.
            </p>
          )}
          <ol>
            {report.trades.map((t) => (
              <li key={t.id}>
                <div>
                  <b>
                    {t.side === "buy" ? "Buy" : "Sell"} {shortAddress(t.mint)}
                  </b>
                  <span>{nativeTradeStatus(t)}</span>
                </div>
                <p>
                  {t.outputRaw ? "Exchanged" : "Planned input"}:{" "}
                  {tokenUnits(t.inputRaw, t.side === "buy" ? 9 : t.decimals)}{" "}
                  {t.side === "buy" ? "SOL" : "tokens"}
                  {t.outputRaw &&
                    ` → ${tokenUnits(t.outputRaw, t.side === "buy" ? t.decimals : 9)} ${t.side === "buy" ? "tokens" : "WSOL"}`}
                </p>
                {t.feeLamports && (
                  <p className="copy-help">
                    Network fee: {tokenUnits(t.feeLamports, 9)} SOL
                    {t.rentLamports &&
                      ` · Account rent: ${tokenUnits(t.rentLamports, 9)} SOL`}
                  </p>
                )}
                {t.tokenFeeRaw && t.tokenFeeRaw !== "0" && (
                  <p className="copy-help">
                    Token transfer fee: {tokenUnits(t.tokenFeeRaw, t.decimals)}{" "}
                    tokens. Received amounts already reflect this fee.
                  </p>
                )}
                {t.accounting === "reserved" && (
                  <p className="copy-help">
                    Reserved: {tokenUnits(t.reservedLamports, 9)} SOL.
                    {t.accountingBlocked
                      ? " Accounting needs review. Spending remains held."
                      : ""}
                  </p>
                )}
                {t.state === "signing" && (
                  <p className="copy-help">
                    A signature was requested. Its result is not known; do not
                    start a replacement trade.
                  </p>
                )}
                {t.state === "signed" && (
                  <p className="copy-help">
                    {nativeConfirmationDelayed(t)
                      ? "Confirmation is taking longer than expected. Recovery is checking the saved transaction. Spending stays reserved until its outcome is verified."
                      : t.submission === null
                      ? "No submission is recorded by Orders. A saved signature does not establish whether a provider broadcast it."
                      : t.submission === "accepted"
                        ? "The RPC accepted the transaction. Finalized confirmation is still required."
                        : "The send claim cannot be retried. Recovery checks the same signature."}
                  </p>
                )}
                {t.state === "expired" && <p className="copy-help">This transaction did not execute. No trade fee was charged and no tokens were exchanged.</p>}
                {t.state === "failed" && (
                  <p className="copy-help">
                    No tokens were exchanged. The verified network fee still
                    applies.
                  </p>
                )}
                {t.state === "signed" && (
                  <p className="copy-help">
                    {t.checkedAt
                      ? `Last chain check ${new Date(t.checkedAt).toLocaleString()}.`
                      : "No chain check recorded yet."}
                    {t.recovery === "inconsistent"
                      ? " Receipt evidence does not match the review."
                      : t.recovery === "unavailable"
                        ? " The last RPC check was unavailable."
                        : ""}
                    {t.nextCheckAt &&
                      ` Next check scheduled ${new Date(t.nextCheckAt).toLocaleString()}.`}
                  </p>
                )}
                <time dateTime={t.updatedAt}>
                  {new Date(t.updatedAt).toLocaleString()}
                </time>
                {t.signature && (
                  <a
                    className="word-link"
                    href={`https://solscan.io/tx/${t.signature}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View transaction
                  </a>
                )}
              </li>
            ))}
          </ol>
          {report.hasMore && (
            <p className="copy-help">
              Showing 50 trades, with unresolved trades first.
            </p>
          )}
        </>
      )}
    </section>
  );
}
