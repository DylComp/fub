import { useEffect, useState } from "react";
import { ArrowUpRight, Copy, RefreshCw, Wallet } from "lucide-react";
import type { WalletConnection } from "./useWallet";
import { walletIcon, walletName } from "./useWallet";
import {isLaunchWalletRoute} from "./wallet-route-policy";
import { shortAddress } from "./assets";

type Balance = { address: string; lamports: string; fetchedAt: number };
export function formatSol(lamports: string): string {
  const value = BigInt(lamports);
  const whole = value / 1000000000n;
  const fraction = (value % 1000000000n)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "");
  return `${whole.toLocaleString()}${fraction ? `.${fraction}` : ""} SOL`;
}
export function WalletPanel({
  connection,
  onView,
  onPermissions,
  onImport,
  onConnected,
}: {
  connection: WalletConnection;
  onView: (address: string) => void;
  onPermissions?: () => void;
  onImport?: () => void;
  onConnected?: () => void;
}) {
  const {
    wallets,
    session,
    pending,
    error,
    connect,
    disconnect,
    select,
    cancel,
  } = connection;
  const address = session?.address;
  const launchRoute=isLaunchWalletRoute(location.hash);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [balanceError, setBalanceError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [copyNotice, setCopyNotice] = useState("");
  useEffect(() => {
    setBalance(null);
    setBalanceError("");
    setCopyNotice("");
    if (!address) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    async function read() {
      try {
        const response = await fetch(
          `/api/wallet?address=${encodeURIComponent(address!)}`,
          { signal: controller.signal, cache: "no-store" },
        );
        if (!response.ok) throw new Error();
        const body = await response.json();
        if (
          body.address !== address ||
          typeof body.lamports !== "string" ||
          !/^\d{1,16}$/.test(body.lamports) ||
          !Number.isFinite(body.fetchedAt)
        )
          throw new Error();
        if (!controller.signal.aborted) setBalance(body);
      } catch {
        if (!controller.signal.aborted)
          setBalanceError(
            "SOL balance is unavailable. Try refreshing shortly.",
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void read();
    return () => controller.abort();
  }, [address, refresh]);
  const currentBalance = balance?.address === address ? balance : null;
  return (
    <section className="wallet-panel" aria-label={launchRoute?"Launch wallet":"Fomo wallet"}>
      <div className="wallet-panel-heading">
        <h3>
          {session ? walletName(session.wallet) : launchRoute?"Connect a launch wallet":"Set up Fomo wallet"}
        </h3>
        {session && (
          <button className="word-link" onClick={() => void disconnect()}>
            Disconnect
          </button>
        )}
      </div>
      <p className="wallet-explanation">
        {session ? "Your funds stay in this wallet." : launchRoute?"Use Phantom or another Solana wallet for this launch. Connecting does not move funds.":"Use your privately imported Fomo wallet for Pay, orders and copy trading. Your Fomo address and balance stay the same."}
      </p>
      {session ? (
        <div className="wallet-account">
          {session.accounts.length > 1 && (
            <label className="field">
              <span>Account</span>
              <select
                aria-label="Connected wallet account"
                value={session.address}
                onChange={(event) => select(event.target.value)}
              >
                {session.accounts.map((account) => (
                  <option key={account.address} value={account.address}>
                    {shortAddress(account.address)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="wallet-address">{session.address}</p>
          {onPermissions && <button className="button primary full" onClick={onPermissions}>Wallet access</button>}
          {onImport && <button className="word-link" onClick={onImport}>Set up this wallet for trading</button>}
          <div className="wallet-account-actions">
            <button
              className="word-link"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(session.address);
                  setCopyNotice("Address copied.");
                } catch {
                  setCopyNotice(
                    "Could not copy. Select the address above to copy it.",
                  );
                }
              }}
            >
              <Copy size={13} /> Copy address
            </button>
            <a
              className="word-link"
              href={`https://solscan.io/account/${session.address}`}
              target="_blank"
              rel="noreferrer"
            >
              View on Solscan <ArrowUpRight size={13} />
            </a>
          </div>
          {copyNotice && (
            <p className="wallet-notice" role="status">
              {copyNotice}
            </p>
          )}
          <div className="wallet-balance">
            <div>
              <span>Native SOL balance</span>
              <strong aria-live="polite">
                {loading
                  ? "Loading balance…"
                  : currentBalance
                    ? formatSol(currentBalance.lamports)
                    : "Unavailable"}
              </strong>
              {currentBalance && !loading && (
                <small>
                  Updated{" "}
                  {new Date(currentBalance.fetchedAt).toLocaleTimeString()}
                </small>
              )}
            </div>
            <button
              className="icon-button"
              aria-label="Refresh SOL balance"
              disabled={loading}
              onClick={() => setRefresh((value) => value + 1)}
            >
              <RefreshCw size={16} />
            </button>
          </div>
          {balanceError && (
            <p className="error-message" role="alert">
              {balanceError}
            </p>
          )}
          <p className="wallet-explanation">
            This balance excludes tokens and wrapped SOL. Open the wallet view
            for token holdings and recent transactions.
          </p>
          <button
            className="button secondary full"
            onClick={() => onView(session.address)}
          >
            View holdings and transactions <ArrowUpRight size={15} />
          </button>
        </div>
      ) : (
        <div className="wallet-choices">
          {!launchRoute&&onImport&&<button className="button primary full" onClick={onImport}>Set up Fomo wallet</button>}
          {wallets.length ? (
            wallets.map((wallet, index) => (
              <button
                className="wallet-choice"
                key={`${wallet.name}-${index}`}
                disabled={!!pending}
                onClick={async () => { if (await connect(wallet)) onConnected?.(); }}
              >
                <span>
                  {walletIcon(wallet) ? (
                    <img
                      src={walletIcon(wallet)}
                      alt=""
                      onError={(event) => {
                        event.currentTarget.style.visibility = "hidden";
                      }}
                    />
                  ) : (
                    <Wallet size={24} />
                  )}
                  {walletName(wallet)}
                </span>
                <span>
                  {pending === wallet ? "Check your wallet" : "Connect"}
                </span>
              </button>
            ))
          ) : launchRoute ? (
            <div className="wallet-empty">
              <b>No compatible wallet detected.</b>
              <p>
                Open this page in a Solana wallet's browser, or enable a browser
                wallet that supports Wallet Standard. You can keep using the
                planning tools without connecting.
              </p>
            </div>
          ) : null}
          {pending && (
            <button className="word-link" onClick={cancel}>
              Cancel connection request
            </button>
          )}
        </div>
      )}
      {!session && launchRoute && onImport && <details className="wallet-advanced">
        <summary>Fomo wallet setup</summary>
        <p className="wallet-explanation">Pay, orders and copy trading use your privately imported Fomo wallet. This setup keeps its existing address and balance.</p>
        <button className="button secondary full" onClick={onImport}>Set up Fomo wallet</button>
      </details>}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
