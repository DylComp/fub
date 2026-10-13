import { CopyNativeHistory } from "./CopyNativeHistory";
import { useEffect, useState } from "react";
import { triggerRequest } from "./trigger-api";
import { shortAddress } from "./assets";
import { tokenUnits } from "./copy-inventory";
import { CopyInventory } from "./CopyInventory";
import type { NativeCopyReport } from "./native-copy";

const sol = (raw: string) => `${tokenUnits(raw, 9)} SOL`;
export function CopyNativeAccount({
  wallet,
  csrf,
  revision,
}: {
  wallet: string;
  csrf: string;
  revision: number;
}) {
  const [report, setReport] = useState<NativeCopyReport | null>(null);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    triggerRequest<NativeCopyReport>(
      "copy-native-limits",
      { wallet },
      csrf,
      controller.signal,
    )
      .then((value) => {
        if (value.wallet !== wallet) throw Error("Wallet response mismatch.");
        if (!controller.signal.aborted) setReport(value);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Saved SOL limits could not be loaded.");
      });
    return () => controller.abort();
  }, [wallet, csrf, revision, refresh]);
  if (!report?.plans.length && !error) return null;
  return (
    <section className="copy-controls" aria-label="Saved SOL limits">
      <div className="section-heading">
        <h3>Saved SOL limits</h3>
        <button className="word-link" onClick={() => setRefresh((n) => n + 1)}>
          Refresh SOL limits
        </button>
      </div>
      <p className="muted">
        The daily cap includes purchases, network fees and new account rent.
        Sale proceeds stay in wrapped SOL and do not reset the cap.
      </p>
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      {report?.plans.map((p) => (
        <article className="copy-backup-row native-copy-plan" key={p.id}>
          <div>
            <b>{p.name || shortAddress(p.leader)}</b>
            <small>
              Permission {p.status}. Expires{" "}
              {new Date(p.expiresAt).toLocaleString()}.
            </small>
          </div>
          {p.mint&&<p className="copy-help" style={{overflowWrap:"anywhere"}}>Only token: {p.mint}</p>}
          <dl className="copy-history-totals">
            <div>
              <dt>Per buy</dt>
              <dd>{sol(p.buyLamports)}</dd>
            </div>
            <div>
              <dt>Daily spending cap</dt>
              <dd>{sol(p.dailySpendLamports)}</dd>
            </div>
            <div>
              <dt>Spent today (UTC)</dt>
              <dd>{sol(p.spentTodayLamports)}</dd>
            </div>
            <div>
              <dt>Reserved today (UTC)</dt>
              <dd>{sol(p.reservedTodayLamports)}</dd>
            </div>
            <div>
              <dt>Held across all days</dt>
              <dd>{sol(p.heldLamports)}</dd>
            </div>
            <div>
              <dt>Network fee cap</dt>
              <dd>{sol(p.maxFeeLamports)}</dd>
            </div>
            <div>
              <dt>New account rent cap</dt>
              <dd>{sol(p.maxRentLamports)}</dd>
            </div>
            <div>
              <dt>Slippage limit</dt>
              <dd>{p.slippageBps / 100}%</dd>
            </div>
            <div>
              <dt>Proportional sells</dt>
              <dd>{p.copySells ? "Allowed" : "Off"}</dd>
            </div>
          </dl>
          <button
            className="word-link"
            onClick={() =>
              setHistory((value) => (value === p.id ? null : p.id))
            }
            aria-expanded={history === p.id}
          >
            {history === p.id
              ? "Hide SOL trade history"
              : "View SOL trade history"}
          </button>
          {history === p.id && (
            <CopyNativeHistory
              key={`${wallet}:${p.id}`}
              wallet={wallet}
              planId={p.id}
              csrf={csrf}
            />
          )}
          {p.pendingCount > 0 && (
            <p className="copy-help">
              {p.pendingCount} unresolved{" "}
              {p.pendingCount === 1 ? "trade" : "trades"}. Reserved spending
              stays held until the outcome is verified.
            </p>
          )}
        </article>
      ))}
      {report?.hasMore && (
        <p className="muted">
          Showing the 25 most recently updated plans with SOL limits.
        </p>
      )}
      {!!report?.plans.length && (
        <>
          <p className="copy-help">
            Saved limits do not establish a wallet signing connection. Use
            Trading controls above to pause a plan or stop new copy trades.
          </p>
          <CopyInventory key={wallet} wallet={wallet} csrf={csrf} native />
        </>
      )}
    </section>
  );
}
