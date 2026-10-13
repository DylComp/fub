import { WalletTransactionRow } from "./WalletTransactionRow";
import { FomoWalletSearch } from "./FomoWalletSearch";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowUpRight, RefreshCw, Search } from "lucide-react";
import { shortAddress, idFor } from "./assets";
import { fomoTokenUrl } from "./fomo-token";
import type { DiscoveredToken } from "./assets";
import { TokenIcon } from "./TokenSearch";
import { Modal } from "./ui";
import { usePortfolio } from "./usePortfolio";
import { decimalAmount, exactAmount } from "./portfolio-data";
import type { Holding } from "./portfolio-data";

type Props = {
  address: string;
  setAddress: (value: string) => void;
  connectedAddress?: string;
  onConnect: () => void;
  onPlan: (token: DiscoveredToken, amount: number) => string | null;
  onCopy: (address: string) => void;
  onDirectExit?: (mint:string)=>void;
};
export function WalletWorkspace({
  address,
  setAddress,
  connectedAddress,
  onConnect,
  onPlan,
  onCopy,
  onDirectExit,
}: Props) {
  const [view, setView] = useState<"holdings" | "activity">(
    "holdings",
  );
  const [live, setLive] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const [review, setReview] = useState<{
    holding: Holding;
    token: DiscoveredToken;
  } | null>(null);
  const {
    data,
    loading,
    error: readError,
    retry,
  } = usePortfolio(
    address,
    view,
    live,
  );
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    setSearch("");
    setError("");
    setReview(null);
    setOpening(null);
    request.current?.abort();
  }, [address]);
  useEffect(() => () => request.current?.abort(), []);
  const holdings =
    view === "holdings" && data && "holdings" in data ? data : null;
  const activity =
    view === "activity" && data && "transactions" in data ? data : null;
  const filtered =
    holdings?.holdings.filter((holding) =>
      `${holding.symbol || ""} ${holding.name || ""} ${holding.mint}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    ) || [];
  async function openHolding(holding: Holding) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setOpening(holding.mint);
    setError("");
    try {
      const response = await fetch(`/api/tokens?q=${holding.mint}`, {
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error("Token lookup is unavailable. Try again.");
      const body = await response.json();
      const token = (body.tokens as DiscoveredToken[]).find(
        (token) => token.address === holding.mint,
      );
      if (!token)
        throw new Error(
          "No market reference was found for this contract. You can still inspect it on Solscan.",
        );
      if (!controller.signal.aborted) setReview({ holding, token });
    } catch (err) {
      if (!controller.signal.aborted)
        setError(
          err instanceof Error ? err.message : "Token lookup unavailable.",
        );
    } finally {
      if (!controller.signal.aborted) setOpening(null);
    }
  }
  return (
    <section className="wallet-workspace" aria-label="Public wallet workspace">
      <FomoWalletSearch address={address} onView={setAddress} connectedAddress={connectedAddress} onConnect={onConnect} onRefresh={retry} />
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {!address ? (
        <div className="wallet-start">
          <h2>Start with a Fomo username.</h2>
          <p>
            See their Fomo profile and available trading stats, inspect holdings
            and transactions, or use the matched wallet for a copy plan.
          </p>
          <p>
            You can also paste a Fomo profile link or public Solana address.
          </p>
        </div>
      ) : (
        <>
          <div className="wallet-view-heading">
            <div>
              <h2>{shortAddress(address)}</h2>
              <a
                className="word-link"
                href={`https://solscan.io/account/${address}`}
                target="_blank"
                rel="noreferrer"
              >
                View full address <ArrowUpRight size={13} />
              </a>
            </div>
            <button
              className="button secondary"
              onClick={() => onCopy(address)}
            >
              Create copy plan <ArrowRight size={14} />
            </button>
          </div>
          <div className="wallet-view-toolbar">
            <div className="wallet-view-tabs" aria-label="Wallet view">
              <button
                className={view === "holdings" ? "selected" : ""}
                onClick={() => setView("holdings")}
              >
                Holdings
              </button>
              <button
                className={view === "activity" ? "selected" : ""}
                onClick={() => setView("activity")}
              >
                Transactions
              </button>
            </div>
            {(
              <div>
                <label className="wallet-auto">
                  <input
                    type="checkbox"
                    checked={live}
                    onChange={(event) => setLive(event.target.checked)}
                  />
                  Auto refresh
                </label>
                <button
                  className="icon-button"
                  aria-label="Refresh wallet data"
                  disabled={loading}
                  onClick={retry}
                >
                  <RefreshCw size={16} />
                </button>
              </div>
            )}
          </div>
          {(
            <div className="wallet-read-state" role="status">
              {loading
                ? "Reading wallet…"
                : readError
                  ? "Refresh failed. Any data below is an older snapshot."
                  : data
                    ? `Updated ${new Date(data.fetchedAt).toLocaleString()}`
                    : ""}
              {live && (
                <span>Checks every 30 seconds while this page is visible.</span>
              )}
            </div>
          )}
          {readError && (
            <p className="error-message" role="alert">
              {readError}
            </p>
          )}
          {holdings && (
            <>
              {(holdings.missing.length > 0 || holdings.truncated) && (
                <p className="notice">
                  This snapshot is incomplete.
                  {holdings.missing.length > 0 &&
                    ` Unavailable: ${holdings.missing.join(", ")}.`}
                  {holdings.truncated &&
                    " Some token accounts were omitted or the 200 token display limit was reached."}
                </p>
              )}
              <div className="wallet-native">
                <div>
                  <span>Native SOL</span>
                  <strong>
                    {holdings.nativeLamports === null
                      ? "Unavailable"
                      : `${exactAmount(holdings.nativeLamports, 9)} SOL`}
                  </strong>
                </div>
                <div>
                  <span>Token balances shown</span>
                  <strong>{holdings.holdings.length}</strong>
                </div>
              </div>
              <div className="wallet-holdings-heading">
                <h3>Token holdings</h3>
                <label className="wallet-filter">
                  <Search size={15} />
                  <input
                    aria-label="Filter wallet holdings"
                    placeholder="Filter tokens or contracts"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
              </div>
              <p className="wallet-scope">
                SPL and Token 2022 balances, including assets you may not
                recognize. A balance does not prove a token is safe or sellable.
              </p>
              {holdings.metadataUnavailable && (
                <p className="wallet-scope">
                  Some token metadata is not available yet. Those balances remain identified by their contracts.
                </p>
              )}
              <div className="wallet-holdings-list">
                {filtered.map((holding) => (
                  <article
                    className="holding-row"
                    key={`${holding.program}:${holding.mint}`}
                  >
                    <TokenIcon
                      token={{
                        id: idFor(holding.mint),
                        symbol: holding.symbol || "",
                        image: holding.image,
                      }}
                    />
                    <div className="holding-name">
                      <b>{holding.symbol || shortAddress(holding.mint)}</b>
                      {holding.name && <span className="holding-token-name">{holding.name}</span>}
                      <a
                        href={`https://solscan.io/token/${holding.mint}`}
                        target="_blank"
                        rel="noreferrer"
                        title={holding.mint}
                      >
                        {shortAddress(holding.mint)} <ArrowUpRight size={11} />
                      </a>
                      <small>
                        {holding.program}
                        {holding.frozenRawAmount !== "0"
                          ? " · Includes frozen balance"
                          : ""}
                      </small>
                    </div>
                    <div className="holding-amount">
                      <b
                        title={exactAmount(holding.rawAmount, holding.decimals)}
                      >
                        {exactAmount(holding.rawAmount, holding.decimals)}
                      </b>
                      <small>{holding.symbol || "tokens"}</small>
                    </div>
                    <div className="holding-actions">
                      <a
                        className="word-link"
                        href={fomoTokenUrl(holding.mint)}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`Open ${holding.symbol || shortAddress(holding.mint)} on Fomo`}
                      >
                        Fomo <ArrowUpRight size={14} />
                      </a>
                      <button
                        className="word-link"
                        disabled={opening !== null || loading || !!readError}
                        aria-label={`Plan ${holding.symbol || shortAddress(holding.mint)}`}
                        onClick={() => void openHolding(holding)}
                      >
                        {opening === holding.mint ? "Looking up…" : "Plan"}
                        <ArrowRight size={14} />
                      </button>

                      {onDirectExit&&connectedAddress===address&&<button className="word-link" disabled={loading||!!readError} onClick={()=>onDirectExit(holding.mint)}>Set exit <ArrowRight size={14}/></button>}
                    </div>
                  </article>
                ))}
              </div>
              {!filtered.length && (
                <p className="wallet-empty-results">
                  {search
                    ? "No holdings match this filter."
                    : holdings.missing.length || holdings.truncated
                      ? "No token balances could be shown in this incomplete snapshot."
                      : "No nonzero SPL or Token 2022 balances found."}
                </p>
              )}
            </>
          )}
          {activity && (
            <div className="wallet-transactions">
              <p className="wallet-scope">
                Recent Solana activity. Buy and sell labels require a recognized swap route and matching wallet movements. SOL amounts exclude network fees and token-account rent; other setup costs may be included.
              </p>
              {activity.transactions.map((transaction) => (
                <WalletTransactionRow key={transaction.signature} transaction={transaction} />
              ))}
              {!activity.transactions.length && (
                <p className="wallet-empty-results">
                  No recent transactions were returned for this address.
                </p>
              )}
            </div>
          )}
        </>
      )}
      {review && (
        <Modal
          title={`Plan ${review.token.symbol}.`}
          description="Use a snapshot of this holding in the preview planner. No tokens move and no order is placed."
          close={() => {
            setReview(null);
            setError("");
          }}
        >
          <p className="review-contract">
            Source wallet<span>{address}</span>
          </p>
          <p className="review-contract">
            Token contract<span>{review.holding.mint}</span>
          </p>
          <dl className="review-details">
            <div>
              <dt>Token balance</dt>
              <dd>
                {exactAmount(review.holding.rawAmount, review.holding.decimals)}
              </dd>
            </div>
            <div>
              <dt>Excluded frozen balance</dt>
              <dd>
                {exactAmount(
                  review.holding.frozenRawAmount,
                  review.holding.decimals,
                )}
              </dd>
            </div>
            <div>
              <dt>Execution</dt>
              <dd>Preview only</dd>
            </div>
          </dl>
          <p className="fine-print">
            This replaces this token's sample balance. Existing sample sell
            orders must still fit within it. The planner uses approximate
            numbers; the wallet view keeps the exact onchain amounts.
          </p>
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          <button
            className="button primary full"
            onClick={() => {
              const raw = (
                BigInt(review.holding.rawAmount) -
                BigInt(review.holding.frozenRawAmount)
              ).toString();
              const quantity = Number(
                decimalAmount(raw, review.holding.decimals),
              );
              if (!(quantity > 0) || !Number.isFinite(quantity)) {
                setError(
                  "This holding has no usable unfrozen balance for the preview.",
                );
                return;
              }
              const issue = onPlan(review.token, quantity);
              if (issue) setError(issue);
            }}
          >
            Open preview planner <ArrowRight size={15} />
          </button>
        </Modal>
      )}
    </section>
  );
}
