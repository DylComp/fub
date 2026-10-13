import { useEffect, useRef, useState } from "react";
import { decimalTokenUnits, grossForNet, transferAmounts } from "./token-fees";
import type { TokenFeeReport } from "./token-fees";
import { exactAmount } from "./portfolio-data";
export function TokenFeeCheck({ mint }: { mint: string }) {
  const [report, setReport] = useState<TokenFeeReport | null>(null),
    [amount, setAmount] = useState(""),
    [mode, setMode] = useState("send"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [now, setNow] = useState(Date.now());
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    if (!report) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [report]);
  async function check() {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError("");
    setReport(null);
    try {
      const response = await fetch(
        `/api/wallet?action=fees&mint=${encodeURIComponent(mint)}`,
        { signal: controller.signal },
      );
      if (!response.ok) throw Error();
      const data: TokenFeeReport = await response.json();
      if (
        data.mint !== mint ||
        !Number.isSafeInteger(data.fetchedAt) ||
        !Number.isInteger(data.decimals) ||
        data.decimals < 0 ||
        data.decimals > 18
      )
        throw Error();
      transferAmounts("0", data.current);
      if (data.scheduled) transferAmounts("0", data.scheduled);
      if (active.current !== controller) return;
      setReport(data);
      setNow(Date.now());
    } catch {
      if (!controller.signal.aborted)
        setError("Transfer fees could not be checked. Try again.");
    } finally {
      if (active.current === controller) {
        setBusy(false);
        active.current = null;
      }
    }
  }
  const fresh =
    report && now - report.fetchedAt < 60000 && now >= report.fetchedAt - 5000;
  let calculation: ReturnType<typeof transferAmounts> | undefined,
    amountError = "";
  if (report && fresh && amount) {
    try {
      const raw = decimalTokenUnits(amount, report.decimals);
      calculation =
        mode === "send"
          ? transferAmounts(raw, report.current)
          : grossForNet(raw, report.current);
    } catch (e) {
      amountError = e instanceof Error ? e.message : "Check the amount.";
    }
  }
  return (
    <section
      className="account-setup token-fee-check"
      aria-label="Token transfer fees"
    >
      <h3>Know what arrives.</h3>
      <p>
        A token can withhold a fee on each transfer. Check the amount received
        before planning a trade.
      </p>
      <button
        className="button secondary"
        type="button"
        disabled={busy}
        onClick={() => void check()}
      >
        {busy
          ? "Checking fees…"
          : report
            ? "Refresh transfer fees"
            : "Check transfer fees"}
      </button>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {report && (
        <>
          <p>
            Current transfer fee: {report.current.basisPoints / 100}%, capped at{" "}
            {exactAmount(report.current.maximumRaw, report.decimals)} tokens per
            transfer.
          </p>
          {report.scheduled && (
            <p>
              Scheduled for epoch {report.scheduled.epoch}:{" "}
              {report.scheduled.basisPoints / 100}%, capped at{" "}
              {exactAmount(report.scheduled.maximumRaw, report.decimals)}{" "}
              tokens.
            </p>
          )}
          <p>
            {report.canChange
              ? "The token’s fee authority can change these rules."
              : "The token has no authority that can change its transfer fee."}
          </p>
          {!fresh ? (
            <p role="status">Fee check expired. Refresh before calculating.</p>
          ) : (
            <>
              <label className="field">
                <span>Amount to calculate</span>
                <select
                  aria-label="Transfer fee amount direction"
                  value={mode}
                  onChange={(e) => setMode(e.target.value)}
                >
                  <option value="send">I send</option>
                  <option value="receive">I want to receive</option>
                </select>
              </label>
              <label className="field">
                <span>Token amount</span>
                <input
                  aria-label="Transfer fee token amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0"
                />
              </label>
              {amountError && (
                <p className="error-message" role="alert">
                  {amountError}
                </p>
              )}
              {calculation && (
                <dl
                  className="account-check-totals"
                  aria-label="Transfer fee calculation"
                >
                  <div>
                    <dt>Sent</dt>
                    <dd>
                      {exactAmount(calculation.grossRaw, report.decimals)}
                    </dd>
                  </div>
                  <div>
                    <dt>Withheld</dt>
                    <dd>{exactAmount(calculation.feeRaw, report.decimals)}</dd>
                  </div>
                  <div>
                    <dt>Received</dt>
                    <dd>{exactAmount(calculation.netRaw, report.decimals)}</dd>
                  </div>
                </dl>
              )}
            </>
          )}
          <p>
            One transfer, in token units. A swap can include several transfers.
            This excludes network, pool and router fees and is not a trade
            quote.
          </p>
        </>
      )}
    </section>
  );
}
