import { useEffect, useRef, useState } from "react";
import type { AccountReadiness } from "./account-readiness";
import type { SetupKind, SetupCheck } from "./account-setup";
import { exactAmount } from "./portfolio-data";

const labels = {
  usdc: "USDC account",
  token: "Token account",
  "wrapped-sol": "Empty wrapped SOL account",
  "pump-rewards": "PumpSwap reward account",
};
export function AccountSetupCheck({ report }: { report: AccountReadiness }) {
  const missing = report.accounts.filter((a) => a.status === "missing");
  const [selected, setSelected] = useState<SetupKind[]>([]);
  const [result, setResult] = useState<SetupCheck | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [expired, setExpired] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, result.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [result]);
  function change(kind: SetupKind, checked: boolean) {
    request.current?.abort();
    request.current = null;
    setBusy(false);
    setResult(null);
    setError("");
    setExpired(false);
    setSelected((previous) =>
      checked ? [...previous, kind] : previous.filter((k) => k !== kind),
    );
  }
  async function check() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    setResult(null);
    setExpired(false);
    try {
      const response = await fetch(
        `/api/wallet?${new URLSearchParams({ action: "setup", address: report.wallet, mint: report.mint, accounts: selected.join(",") })}`,
        { signal: controller.signal },
      );
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          response.status === 422 && typeof data.message === "string"
            ? data.message
            : response.status === 429
              ? "Setup checks are busy. Try again shortly."
              : "Setup checks are unavailable. Try again.",
        );
      if (
        data.status !== "simulated" ||
        data.wallet !== report.wallet ||
        data.mint !== report.mint ||
        !Array.isArray(data.accounts) ||
        data.accounts.length !== selected.length ||
        new Set(data.accounts).size !== selected.length ||
        selected.some((k) => !data.accounts.includes(k)) ||
        !Number.isSafeInteger(data.expiresAt) ||
        data.expiresAt <= Date.now() ||
        [data.feeLamports, data.rentLamports, data.totalLamports].some(
          (v) => typeof v !== "string" || !/^[1-9]\d{0,9}$/.test(v),
        )
      )
        throw new Error(
          "Setup check did not match this selection. Check again.",
        );
      if (!controller.signal.aborted) setResult(data as SetupCheck);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof Error ? e.message : "Setup checks are unavailable.",
        );
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  if (
    !missing.length ||
    report.accounts.find((a) => a.kind === "token")?.status === "blocked"
  )
    return null;
  return (
    <section className="account-setup" aria-label="Account setup simulation">
      <h3>Check setup before signing</h3>
      <p className="wallet-scope">
        Choose the missing accounts to test together. This runs an unsigned
        on-chain simulation and checks the SOL cost.
      </p>
      <fieldset disabled={busy}>
        <legend>Accounts to simulate</legend>
        {missing.map((a) => (
          <label key={a.kind} className="account-setup-option">
            <input
              type="checkbox"
              checked={selected.includes(a.kind)}
              onChange={(e) => change(a.kind, e.target.checked)}
            />
            <span>
              {labels[a.kind]}
              {a.kind === "pump-rewards" && (
                <small>Separate from copy-trading permission</small>
              )}
            </span>
          </label>
        ))}
      </fieldset>
      <button
        className="button secondary"
        disabled={busy || !selected.length}
        onClick={() => void check()}
      >
        {busy ? "Simulating…" : "Simulate setup"}
      </button>
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      {result && (
        <div role="status" className="account-setup-result">
          <b>
            {expired
              ? "Check expired. Simulate again before proceeding."
              : "Setup simulation passed"}
          </b>
          <dl className="account-check-totals">
            <div>
              <dt>Account rent</dt>
              <dd>{exactAmount(result.rentLamports, 9)} SOL</dd>
            </div>
            <div>
              <dt>Network fee</dt>
              <dd>{exactAmount(result.feeLamports, 9)} SOL</dd>
            </div>
            <div>
              <dt>Total SOL cost</dt>
              <dd>{exactAmount(result.totalLamports, 9)} SOL</dd>
            </div>
          </dl>
        </div>
      )}
      <p className="wallet-scope">
        No accounts are created. Signing this setup from your Fomo wallet is not
        connected yet.
      </p>
    </section>
  );
}
