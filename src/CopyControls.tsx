import { useEffect, useRef, useState } from "react";
import type { AccountCopyPlan } from "./copy-account";
import type { CopyControlEvent, CopyControlReport } from "./copy-controls";
import { triggerRequest } from "./trigger-api";
import { shortAddress } from "./assets";

export function CopyControls({
  wallet,
  csrf,
  plans,
  revision,
  onChange,
}: {
  wallet: string;
  csrf: string;
  plans: AccountCopyPlan[];
  revision: number;
  onChange: () => void;
}) {
  const [report, setReport] = useState<CopyControlReport | null>(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const request = useRef<AbortController | null>(null);
  const retries = useRef(new Map<string, string>());
  const planRevision = plans
    .map((plan) => `${plan.id}:${plan.version}`)
    .join(",");
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    triggerRequest<CopyControlReport>(
      "copy-controls",
      { wallet },
      csrf,
      controller.signal,
    )
      .then((value) => {
        if (
          value.wallet !== wallet ||
          !Array.isArray(value.events) ||
          value.events.some((event) => event.wallet !== wallet)
        )
          throw new Error("Wallet control mismatch.");
        if (!controller.signal.aborted) {
          setReport(value);
          setLoadError("");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setLoadError(
            "Trading controls could not be loaded. You can still request a stop.",
          );
      });
    return () => controller.abort();
  }, [wallet, csrf, revision, refresh, planRevision]);

  async function stop(plan?: AccountCopyPlan) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    setNotice("");
    const key = plan ? `${plan.id}:${plan.version}` : "all";
    const requestId = retries.current.get(key) || crypto.randomUUID();
    retries.current.set(key, requestId);
    try {
      const event = await triggerRequest<CopyControlEvent>(
        plan ? "copy-pause" : "copy-stop",
        {
          wallet,
          requestId,
          ...(plan ? { id: plan.id, version: plan.version } : {}),
        },
        csrf,
        controller.signal,
      );
      if (
        event.wallet !== wallet ||
        event.id !== requestId ||
        event.kind !== (plan ? "pause" : "stop") ||
        event.planId !== (plan?.id || null) ||
        event.planVersion !== (plan?.version || null)
      )
        throw new Error("The stop response could not be verified.");
      if (controller.signal.aborted) return;
      retries.current.delete(key);
      const released = event.releasedCount + (event.nativeReleasedCount ?? 0);
      const pending = event.pendingCount + (event.nativePendingCount ?? 0);
      setNotice(
        `${plan ? "Plan paused." : "New copy trades blocked for this wallet."}${released ? ` ${released} unsent ${released === 1 ? "trade" : "trades"} canceled.` : ""}${pending ? ` ${pending} ${pending === 1 ? "trade still needs" : "trades still need"} a signing result or confirmation. Spending stays reserved.` : ""}`,
      );
      setRefresh((value) => value + 1);
      onChange();
    } catch (error) {
      if (!controller.signal.aborted)
        setError(
          `${error instanceof Error ? error.message : "Stop failed."} Stop is not confirmed. Refresh or retry.`,
        );
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section className="copy-controls" aria-label="Copy trading controls">
      <div className="section-heading">
        <h3>Trading controls</h3>
        <button
          className="word-link"
          disabled={busy}
          onClick={() => {
            setLoadError("");
            setRefresh((value) => value + 1);
          }}
        >
          Refresh controls
        </button>
      </div>
      <p className="muted">
        {report?.stoppedAt
          ? "New copy trades are blocked for this wallet. Checking activity and confirming submitted trades still work."
          : "Stop new copy trades without losing your settings or trade history."}
      </p>
      {report && (
        <p className="copy-help">
          {report.activePlans} active{" "}
          {report.activePlans === 1 ? "plan" : "plans"} ·{" "}
          {report.reservedCount + (report.nativeReservedCount ?? 0)} unsent ·{" "}
          {report.pendingCount + (report.nativePendingCount ?? 0)} awaiting a
          result
        </p>
      )}
      <div className="live-order-actions">
        <button
          className="button secondary compact"
          disabled={
            busy ||
            (!!report?.stoppedAt &&
              report.activePlans === 0 &&
              report.reservedCount === 0 &&
              (report.nativeReservedCount ?? 0) === 0)
          }
          onClick={() => void stop()}
        >
          {busy ? "Stopping…" : "Stop all copy trades"}
        </button>
        {!report?.stoppedAt &&
          plans
            .filter((plan) => plan.enabled && !plan.archived)
            .map((plan) => (
              <button
                key={plan.id}
                className="word-link"
                disabled={busy}
                onClick={() => void stop(plan)}
              >
                Pause {plan.name || shortAddress(plan.address)}
              </button>
            ))}
      </div>
      <p className="copy-help">
        Unsigned preparations are canceled. A requested signature or submitted
        trade may still complete. Pausing this plan does not cancel other orders or
        withdraw funds.
      </p>
      {notice && (
        <p role="status" className="copy-save-notice">
          {notice}
        </p>
      )}
      {(error || loadError) && (
        <p role="alert" className="error-message">
          {error || loadError}
        </p>
      )}
      {!!report?.events.length && (
        <details className="copy-control-history">
          <summary>Control history</summary>
          <ol>
            {report.events.map((event) => (
              <li key={event.id}>
                <div>
                  <b>
                    {event.kind === "stop"
                      ? "All copy trading stopped"
                      : `${event.planName || "Copy plan"} paused`}
                  </b>
                  <time dateTime={event.createdAt}>
                    {new Date(event.createdAt).toLocaleString()}
                  </time>
                </div>
                <p>
                  {event.releasedCount + (event.nativeReleasedCount ?? 0)}{" "}
                  unsent trades canceled.{" "}
                  {event.pendingCount + (event.nativePendingCount ?? 0)}{" "}
                  awaiting a result at the time.
                </p>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
