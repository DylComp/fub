import { useEffect, useRef, useState } from "react";
import type { AccountCopyPlan } from "./copy-account";
import type { CopyHistoryReport, CopyTradeRecord } from "./copy-history";
import { recoveryStatus, signingStatus } from "./copy-history";
import { triggerRequest } from "./trigger-api";
import { exactAmount } from "./portfolio-data";
import { shortAddress } from "./assets";
const labels: Record<CopyTradeRecord["state"], string> = {
  reserved: "Reserved",
  submitting: "Awaiting confirmation",
  unknown: "Needs recovery",
  confirmed: "Confirmed",
  failed: "Failed on chain",
  released: "Not sent",
  skipped: "Daily cap reached",
};
export function CopyHistory({
  plan,
  csrf,
}: {
  plan: AccountCopyPlan;
  csrf: string;
}) {
  const [report, setReport] = useState<CopyHistoryReport | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(true),
    [revision, setRevision] = useState(0),
    [recovering, setRecovering] = useState<string | null>(null),
    [recoveryNote, setRecoveryNote] = useState("");
  const recoveryRequest = useRef<AbortController | null>(null);
  const hasPending = !!report?.attempts.some((attempt) =>
    ["reserved", "submitting", "unknown"].includes(attempt.state),
  );
  useEffect(() => {
    if (!hasPending || busy || recovering) return;
    const refresh = () => {
      if (document.visibilityState === "visible" && navigator.onLine)
        setRevision((value) => value + 1);
    };
    const timer = window.setInterval(refresh, error ? 30000 : 15000);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [hasPending, busy, recovering, error]);
  useEffect(() => {
    setRecoveryNote("");
    setRecovering(null);
    return () => recoveryRequest.current?.abort();
  }, [plan.wallet, plan.id, csrf]);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError("");
    void triggerRequest<CopyHistoryReport>(
      "copy-history",
      { wallet: plan.wallet, id: plan.id },
      csrf,
      controller.signal,
    )
      .then((result) => {
        if (
          result.wallet !== plan.wallet ||
          result.planId !== plan.id ||
          !Array.isArray(result.attempts)
        )
          throw Error("Trade history does not match this wallet.");
        if (!controller.signal.aborted) setReport(result);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError(
            "Trade history could not be refreshed. Saved records are unchanged.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [plan.wallet, plan.id, csrf, revision]);
  async function recover(id: string) {
    const controller = new AbortController();
    recoveryRequest.current?.abort();
    recoveryRequest.current = controller;
    setRecovering(id);
    setRecoveryNote("");
    try {
      const result = await triggerRequest<{
        id: string;
        state: CopyTradeRecord["state"];
      }>("copy-recover", { wallet: plan.wallet, id }, csrf, controller.signal);
      if (controller.signal.aborted) return;
      if (result.id !== id) throw Error("Trade mismatch");
      setRecoveryNote(
        result.state === "confirmed"
          ? "Trade confirmed."
          : result.state === "failed"
            ? "The trade failed. No tokens were exchanged. Network fees still apply."
            : "Final confirmation is not available yet. The trade remains locked.",
      );
      setRevision((value) => value + 1);
    } catch {
      if (controller.signal.aborted) return;
      setRecoveryNote(
        "Confirmation could not be checked. The trade remains locked.",
      );
    } finally {
      if (!controller.signal.aborted) setRecovering(null);
    }
  }
  return (
    <section
      className="copy-feed copy-history"
      aria-label="Copy trade history"
      aria-busy={busy}
    >
      <div className="section-heading">
        <h3>Trade history</h3>
        <button
          className="word-link"
          disabled={busy}
          onClick={() => setRevision((value) => value + 1)}
        >
          {busy ? "Loading…" : "Refresh trade history"}
        </button>
      </div>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {recoveryNote && (
        <p role="status" className="copy-help">
          {recoveryNote}
        </p>
      )}
      {report && (
        <>
          <dl className="copy-history-totals">
            <div>
              <dt>Buys today (UTC)</dt>
              <dd>{exactAmount(report.buySpentCents, 2)} USDC</dd>
            </div>
            <div>
              <dt>Reserved for buys</dt>
              <dd>{exactAmount(report.buyReservedCents, 2)} USDC</dd>
            </div>
            <div>
              <dt>Confirmed sell proceeds</dt>
              <dd>{exactAmount(report.sellProceedsRaw, 6)} USDC</dd>
            </div>
          </dl>
          <p className="copy-help">
            Sell proceeds are total USDC received across this plan, before
            deducting buy costs and network fees. They are not profit and do not
            reset the daily buy cap.
          </p>
          {!report.attempts.length ? (
            <p role="status" className="copy-help">
              No copied trades for this plan.
            </p>
          ) : (
            <ol>
              {report.attempts.map((attempt) => (
                <li key={attempt.id}>
                  <div>
                    <b>
                      {attempt.side === "sell" ? "Sell" : "Buy"}{" "}
                      {shortAddress(attempt.mint)}
                    </b>
                    <span>{labels[attempt.state]}</span>
                  </div>
                  <p>
                    {exactAmount(attempt.inputRaw, attempt.inputDecimals)}{" "}
                    {attempt.side === "buy" ? "USDC" : "tokens"}
                    {attempt.state === "confirmed" && attempt.outputRaw
                      ? ` → ${exactAmount(attempt.outputRaw, attempt.outputDecimals)} ${attempt.side === "sell" ? "USDC" : "tokens"}`
                      : " planned"}
                  </p>
                  {attempt.state === "unknown" && (
                    <p>
                      Confirmation is unresolved. Another copy trade is blocked
                      until recovery verifies the outcome.
                    </p>
                  )}
                  {signingStatus(attempt) && <p>{signingStatus(attempt)}</p>}
                  {attempt.state === "failed" && (
                    <p>No tokens were exchanged. Network fees still apply.</p>
                  )}
                  {["submitting", "unknown"].includes(attempt.state) && (
                    <p>{recoveryStatus(attempt, report.backgroundRecovery)}</p>
                  )}
                  {attempt.state === "released" && attempt.releaseReason && (
                    <p>
                      {
                        {
                          paused: "Canceled when this plan was paused.",
                          stopped: "Canceled when copy trading was stopped.",
                          edited: "Canceled when this plan was edited.",
                          archived: "Canceled when this plan was archived.",
                          expired:
                            "Canceled because the quote expired before submission.",
                        }[attempt.releaseReason]
                      }{" "}
                      No trade was submitted.
                    </p>
                  )}
                  <div>
                    {["submitting", "unknown"].includes(attempt.state) && (
                      <button
                        className="word-link"
                        disabled={recovering !== null || busy}
                        onClick={() => void recover(attempt.id)}
                      >
                        {recovering === attempt.id
                          ? "Checking confirmation…"
                          : "Check confirmation"}
                      </button>
                    )}
                    <time dateTime={attempt.updatedAt}>
                      {new Date(attempt.updatedAt).toLocaleString()}
                    </time>
                    {attempt.signature && (
                      <a
                        className="word-link"
                        href={`https://solscan.io/tx/${attempt.signature}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View transaction
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
          {report.hasMore && (
            <p className="copy-help">
              Showing 50 records, with unresolved attempts first. Older records
              remain saved.
            </p>
          )}
          <p className="copy-help">
            Last refreshed {new Date(report.checkedAt).toLocaleString()}.
          </p>
        </>
      )}
    </section>
  );
}
