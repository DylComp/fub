import { TokenFeeCheck } from "./TokenFeeCheck";
import { useEffect, useRef, useState } from "react";
import { isMint, shortAddress } from "./assets";
import { exactAmount } from "./portfolio-data";
import { USDC, WSOL } from "./funding-model";
import type { AccountReadiness } from "./account-readiness";
import { AccountSetupCheck } from "./AccountSetupCheck";

const labels = {
  usdc: "USDC account",
  token: "Token account",
  "wrapped-sol": "Wrapped SOL account",
  "pump-rewards": "PumpSwap reward account",
};
export function WalletReadiness({ wallet }: { wallet: string }) {
  const [mint, setMint] = useState(""),
    [report, setReport] = useState<AccountReadiness | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function check() {
    const contract = mint.trim();
    if (!isMint(contract) || [USDC, WSOL].includes(contract)) {
      setError("Enter a memecoin's Solana contract address.");
      return;
    }
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    setReport(null);
    try {
      const response = await fetch(
        `/api/wallet?${new URLSearchParams({ action: "accounts", address: wallet, mint: contract })}`,
        { signal: controller.signal },
      );
      if (!response.ok)
        throw new Error(
          response.status === 429
            ? "Account checks are busy. Try again shortly."
            : "Account checks are unavailable. Try again.",
        );
      const value = (await response.json()) as AccountReadiness;
      if (
        value.wallet !== wallet ||
        value.mint !== contract ||
        !Array.isArray(value.accounts) ||
        value.accounts.length !== 4 ||
        !Number.isSafeInteger(value.slot)
      )
        throw new Error("Account check response did not match this wallet.");
      if (!controller.signal.aborted) setReport(value);
    } catch (err) {
      if (!controller.signal.aborted)
        setError(
          err instanceof Error
            ? err.message
            : "Account checks are unavailable.",
        );
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <section className="account-check" aria-label="Trading account check">
      <h3>Check trading accounts</h3>
      <p className="wallet-scope">
        See which accounts this wallet needs for a token, and what their
        creation would cost.
      </p>
      <form
        className="wallet-lookup"
        onSubmit={(event) => {
          event.preventDefault();
          void check();
        }}
      >
        <label className="field">
          <span>Token contract</span>
          <input
            aria-label="Account check token contract"
            placeholder="Paste a Solana token contract"
            value={mint}
            maxLength={44}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              request.current?.abort();
              request.current = null;
              setBusy(false);
              setMint(event.target.value);
              setReport(null);
              setError("");
            }}
            required
          />
        </label>
        <button className="button secondary" type="submit" disabled={busy}>
          {busy ? "Checking…" : "Check accounts"}
        </button>
      </form>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {report && (
        <div aria-live="polite">
          {report.tokenSetup && (
            <p className="notice">
              Token-2022 account checks and setup simulation are supported for
              this token.
              {report.tokenSetup.transferFee
                ? " It has a transfer-fee extension."
                : ""}{" "}
              Copy execution and order funding for Token-2022 are not supported
              yet.
            </p>
          )}
          {report.tokenSetup?.transferFee && (
            <TokenFeeCheck key={report.mint} mint={report.mint} />
          )}
          <div className="account-check-list">
            {report.accounts.map((account) => (
              <article className="account-check-row" key={account.kind}>
                <div>
                  <b>{labels[account.kind]}</b>
                  <a
                    className="word-link"
                    href={`https://solscan.io/account/${account.address}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {shortAddress(account.address)}
                  </a>
                  <p>{account.detail}</p>
                </div>
                <div className="account-check-state">
                  <strong>
                    {account.status === "ready"
                      ? "Available"
                      : account.status === "missing"
                        ? "Not created"
                        : "Needs attention"}
                  </strong>
                  {account.status === "missing" && (
                    <span>{exactAmount(account.rentLamports, 9)} SOL rent</span>
                  )}
                </div>
              </article>
            ))}
          </div>
          <dl className="account-check-totals">
            <div>
              <dt>Wallet SOL</dt>
              <dd>{exactAmount(report.balanceLamports, 9)} SOL</dd>
            </div>
            <div>
              <dt>Known creation rent</dt>
              <dd>{exactAmount(report.setupRentLamports, 9)} SOL</dd>
            </div>
          </dl>
          {(!report.buyRentWithinLimit || !report.sellRentWithinLimit) && (
            <p className="notice">
              The missing token accounts exceed the{" "}
              {exactAmount(report.tradeRentLimitLamports, 9)} SOL rent limit for{" "}
              {!report.buyRentWithinLimit && !report.sellRentWithinLimit
                ? "buys and sells"
                : !report.buyRentWithinLimit
                  ? "buys"
                  : "sells"}
              . Prepare accounts separately before using that route.
            </p>
          )}
          {report.rewardConsentRequired && (
            <p className="wallet-scope">
              Reward-account creation is separate from copy-trading permission.
              PumpSwap buys cannot proceed until that account exists.
            </p>
          )}
          <p className="wallet-scope">
            Rent estimates exclude network fees. Available accounts do not prove
            a trade can execute. This check does not connect Fomo, create
            accounts or authorize trades.
          </p>
          <p className="wallet-read-state">
            Checked {new Date(report.fetchedAt).toLocaleString()}
          </p>
          <AccountSetupCheck
            key={`${report.wallet}:${report.mint}:${report.fetchedAt}`}
            report={report}
          />
        </div>
      )}
    </section>
  );
}
