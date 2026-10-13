import { useEffect, useRef, useState } from "react";
import { Search, ArrowUpRight, Coins } from "lucide-react";
import type { DiscoveredToken, SearchReply } from "./assets";
import { shortAddress } from "./assets";
import { TOKEN_SEARCH_MAX_LENGTH } from "./fomo-token";
import { assetAddress, NETWORKS, NETWORK_KEYS, parseNetworkTokenSearch } from './networks';
import type { Network } from './networks';
import { NetworkTokenPreview } from './NetworkTokenPreview';
import type { Token } from "./model";
import { priceLabel } from "./model";
import { Modal } from "./ui";
const compactUsd = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) || n < 0
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(n);

export function TokenIcon({
  token,
}: {
  token: Pick<Token, "id" | "symbol" | "image">;
}) {
  const [failed, setFailed] = useState(false);
  const source = ["BONK", "SOL", "JUP"].includes(token.id)
    ? `/tokens/${token.id.toLowerCase()}.png`
    : token.image;
  useEffect(() => setFailed(false), [source]);
  return (
    <span className="token-icon">
      {source && !failed ? (
        <img
          src={source}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <Coins size={20} aria-hidden="true" />
      )}
    </span>
  );
}

export function TokenSearch({
  close,
  select,
}: {
  close: () => void;
  select: (token: DiscoveredToken) => void;
}) {
  const [query, setQuery] = useState("");
  const [network, setNetwork] = useState<Network>('solana');
  const [preview, setPreview] = useState<DiscoveredToken | null>(null);
  const [state, setState] = useState<{
    query: string;
    loading: boolean;
    tokens: DiscoveredToken[];
    error?: string;
  }>({ query: "", loading: false, tokens: [] });
  const [retry, setRetry] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const parsed = parseNetworkTokenSearch(query, network);
  const chain = parsed.chain;
  const term = parsed.query;
  const exactMint = parsed.exactAddress;
  const searchKey = `${chain}:${term}`;
  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    setPreview(null);
    if (term.length < 2) return;
    const controller = new AbortController();
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout>;
    setState({ query: searchKey, loading: true, tokens: [] });
    const debounce = setTimeout(async () => {
      timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(
          `/api/tokens?q=${encodeURIComponent(term)}${chain === 'solana' ? '' : `&chain=${chain}`}`,
          { signal: controller.signal },
        );
        if (!response.ok)
          throw new Error(
            response.status === 429
              ? "Search is busy. Try again in a minute."
              : "Token search is unavailable. Try again.",
          );
        const data = (await response.json()) as SearchReply;
        if (!Array.isArray(data.tokens))
          throw new Error("Token search is unavailable. Try again.");
        if (!cancelled)
          setState({
            query: searchKey,
            loading: false,
            tokens: data.tokens.filter(token => assetAddress(chain, token.address) &&
              (token.chain === chain || chain === 'solana' && token.chain === undefined) &&
              (!exactMint || assetAddress(chain, token.address) === exactMint)),
          });
      } catch (error) {
        if (!cancelled)
          setState({
            query: searchKey,
            loading: false,
            tokens: [],
            error:
              error instanceof Error && error.name !== "AbortError"
                ? error.message
                : "Search timed out. Try again.",
          });
      } finally {
        clearTimeout(timeout);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(debounce);
      clearTimeout(timeout);
      controller.abort();
    };
  }, [term, exactMint, retry, chain, searchKey]);
  const current = state.query === searchKey;
  return (
    <Modal
      title="Find your token."
      description="Search by network or paste a token link from Fomo."
      close={close}
    >
      <label className="token-network-label">Network
        <select aria-label="Token network" value={chain} onChange={e => { setNetwork(e.target.value as Network); setQuery(''); setPreview(null); }}>
          {NETWORK_KEYS.map(key => <option key={key} value={key}>{NETWORKS[key].name}</option>)}
        </select>
      </label>
      {chain !== 'solana' && <p className="copy-help">Token data and route checks. {NETWORKS[chain].name} order execution is not active.</p>}
      <div className="token-search-input">
        <Search size={18} />
        <input
          ref={input}
          aria-label={`Search ${NETWORKS[chain].name} tokens`}
          placeholder="Name, ticker, contract or Fomo link"
          value={query}
          maxLength={TOKEN_SEARCH_MAX_LENGTH}
          aria-invalid={!!parsed.error}
          aria-describedby={parsed.error ? "token-search-error" : undefined}
          onChange={(e) => {
            const value = e.target.value;
            setQuery(value);
            const next = parseNetworkTokenSearch(value, network);
            if (!next.error) setNetwork(next.chain);
          }}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div
        className="token-results"
        aria-live="polite"
        aria-busy={term.length >= 2 && (!current || state.loading)}
      >
        {preview && chain !== 'solana' ? <NetworkTokenPreview key={`${chain}:${preview.address}`} token={preview} chain={chain} close={() => setPreview(null)} /> : parsed.error ? (
          <p className="search-message" id="token-search-error" role="alert">
            {parsed.error}
          </p>
        ) : term.length < 2 ? (
          <p className="search-message">
            Enter at least two characters. A contract address is the most
            precise match.
          </p>
        ) : !current || state.loading ? (
          <p className="search-message">Searching…</p>
        ) : state.error ? (
          <div className="search-message">
            <p role="alert">{state.error}</p>
            <button
              className="word-link"
              onClick={() => setRetry((n) => n + 1)}
            >
              Try again
            </button>
          </div>
        ) : !state.tokens.length ? (
          <p className="search-message">
            No priced {NETWORKS[chain].name} pools found. Check the contract address or try
            another name.
          </p>
        ) : (
          state.tokens.map((token) => (
            <button
              className="token-result"
              key={`${chain}:${token.address}`}
              onClick={() => chain === 'solana' ? select(token) : setPreview(token)}
              aria-label={`${chain === 'solana' ? 'Open' : 'View'} ${token.symbol} ${shortAddress(token.address)}`}
            >
              <TokenIcon
                token={{
                  id: token.address,
                  symbol: token.symbol,
                  image: token.image,
                }}
              />
              <span className="token-result-name">
                <b>
                  {token.symbol}
                  <span>{token.name}</span>
                </b>
                <small title={token.address}>
                  {shortAddress(token.address)}
                </small>
              </span>
              <span className="token-result-price">
                {priceLabel(token.address, token.price)}
                <ArrowUpRight size={14} />
              </span>
              <span className="token-result-stats">
                <span><small>Market cap</small><strong>{compactUsd(token.marketCap)}</strong></span>
                <span><small>Volume · 24h</small><strong>{compactUsd(token.volume)}</strong></span>
                <span><small>Liquidity</small><strong>{compactUsd(token.liquidity)}</strong></span>
              </span>
            </button>
          ))
        )}
      </div>
      <p className="search-source">
        DEX Screener · sorted by reported 24h volume. Check the contract; names
        and logos can be copied.
      </p>
    </Modal>
  );
}
