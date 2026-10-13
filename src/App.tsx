import {TASK_COMPLETED,type TaskCompletion} from "./task-completion";
import {NativeSellAmount} from "./NativeSellAmount";
import {MarketCapEntry} from "./MarketCapEntry";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  FlaskConical,
  Layers3,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import type { Account, Draft, Kind, Order, Symbol } from "./model";
import {
  active,
  available,
  availableCash,
  cancelOrder,
  createOrder,
  defaultDraft,
  initialAccount,
  loadAccount,
  priceLabel,
  quantityLabel,
  simulate,
  STORAGE_KEY,
  addToken,
  tokenLabel,
  setSamplePosition,
  usd,
  validate,
} from "./model";
import { Modal, Wordmark } from "./ui";
import { Chart } from "./Chart";
import { useMarket } from "./useMarket";
import type { Period } from "./market-data";
import { idFor, shortAddress } from "./assets";
import { fomoTokenUrl } from "./fomo-token";
import { TokenIcon, TokenSearch } from "./TokenSearch";
import { CopyTrading } from "./CopyTrading";
import { Docs } from "./Docs";
import { useWalletSetup } from "./WalletSetup";
import { WalletPanel } from "./WalletPanel";
import { WalletWorkspace } from "./WalletWorkspace";
import { pages, usePage } from "./navigation";
import type { Page } from "./navigation";
const Overview = lazy(() =>
  import("./Overview").then((module) => ({ default: module.Overview })),
);
const Activity = lazy(() =>
  import("./Activity").then((module) => ({ default: module.Activity })),
);
const Pay = lazy(() =>
  import("./Pay").then((module) => ({ default: module.Pay })),
);
const Launchpad = lazy(() =>
  import("./Launchpad").then((module) => ({ default: module.Launchpad })),
);
const TokenDirectory = lazy(() =>
  import("./TokenDirectory").then((module) => ({
    default: module.TokenDirectory,
  })),
);
type Dialog =
  | "review"
  | "connection"
  | "settings"
  | "simulation"
  | "tokens"
  | "position"
  | null;
const descriptions: Record<Kind, string> = {
  Bracket: "One target. One stop. The first fill cancels the other.",
  Limit: "Set your price. Give the order an expiry.",
  Trailing: "Let the position rise. Follow it with a moving stop.",
};
function State({ order }: { order: Order }) {
  return (
    <span
      className={`order-status status-${order.status.toLowerCase().replaceAll(" ", "-")}`}
    >
      <i />
      {order.status}
    </span>
  );
}
function Rule({ order }: { order: Order }) {
  return (
    <span className="rule-description">
      {order.kind === "Bracket" ? (
        <>
          <span className="positive">
            TP {priceLabel(order.symbol, order.target)}
          </span>
          <span className="negative">
            SL {priceLabel(order.symbol, order.stop)}
          </span>
        </>
      ) : order.kind === "Trailing" ? (
        `Trail by ${order.trail}%`
      ) : (
        `${order.side === "Buy" ? "Below" : "Above"} ${priceLabel(order.symbol, order.target)}`
      )}
    </span>
  );
}

export default function App() {
  const { connection, canImport, openImport, openPermissions, openDirectExits } = useWalletSetup();
  const [orderMode, setOrderMode] = useState<"live" | "plans" | "builder">(
    () =>
      window.location.hash === "#orders/planner"
        ? "builder"
        : window.location.hash === "#orders/plans"
          ? "plans"
          : "live",
  );
  const [watchedAddress, setWatchedAddress] = useState("");
  const [copyAddress, setCopyAddress] = useState("");
  const [account, setAccount] = useState(loadAccount);
  const accountRef = useRef(account);
  const tokens = account.tokens;
  const tokenFor = (id: string) => tokens.find((t) => t.id === id)!;
  const label = (id: string) => tokenLabel(account, id);
  const [draft, setDraft] = useState(() => defaultDraft(account, "BONK"));
  const [amountReady,setAmountReady]=useState(false);
  const [mcReady,setMcReady]=useState(true),[mcSummary,setMcSummary]=useState<string|null>(null);
  const [period, setPeriod] = useState<Period>("1D");
  const [page, setPage] = usePage();
  const {
    market,
    retry: retryMarket,
    history,
    loadEarlier,
  } = useMarket(
    draft.symbol,
    period,
    page === "Orders" && orderMode === "builder",
  );
  const draftDirty = useRef(false);
  const anchoredToken = useRef<string | null>(null);
  const latestBar = market.bars.at(-1);
  const marketPrice = latestBar?.close;
  useEffect(() => {
    if (market.status !== "ready" || !marketPrice) return;
    const next = {
      ...accountRef.current,
      prices: { ...accountRef.current.prices, [draft.symbol]: marketPrice },
    };
    accountRef.current = next;
    setAccount(next);
    if (anchoredToken.current !== draft.symbol && !draftDirty.current) {
      setDraft(defaultDraft(next, draft.symbol, draft.kind));
    }
    anchoredToken.current = draft.symbol;
  }, [marketPrice, market.status, market.stale, draft.symbol, draft.kind]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [filter, setFilter] = useState("Open");
  const [search, setSearch] = useState("");
  const [toast, setToast] = useState("");
  const [storageError, setStorageError] = useState(false);
  const [positionAmount, setPositionAmount] = useState("");
  const [simPrice, setSimPrice] = useState("");
  const [simFraction, setSimFraction] = useState(1);
  const [formError, setFormError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const composer = useRef<HTMLElement>(null);
  useEffect(() => {
    let last = window.scrollY;
    const scroll = () => {
      const now = Math.max(0, window.scrollY);
      if (now <= 8) setCollapsed(false);
      else if (Math.abs(now - last) >= 3) setCollapsed(now > last);
      last = now;
    };
    window.addEventListener("scroll", scroll, { passive: true });
    return () => window.removeEventListener("scroll", scroll);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(account));
    } catch {
      setStorageError(true);
    }
  }, [account]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    document.title = `${page} | Fub`;
    setCollapsed(false);
    setSearch("");
    const nav = document.querySelector<HTMLElement>(
      'nav[aria-label="Main navigation"]',
    );
    const item = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (nav && item && nav.scrollWidth > nav.clientWidth)
      nav.scrollLeft =
        item.offsetLeft - (nav.clientWidth - item.offsetWidth) / 2;
  }, [page]);
  useEffect(() => {
    const completed = (event: Event) => {
      const detail = (event as CustomEvent<TaskCompletion>).detail;
      if (!detail?.message) return;
      setDialog(null); setDetail(null); notify(detail.message);
      if (detail.destination) window.location.hash = detail.destination;
    };
    window.addEventListener(TASK_COMPLETED, completed);
    return () => window.removeEventListener(TASK_COMPLETED, completed);
  }, []);
  function notify(message: string) {
    setToast(message);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(""), 4000);
  }
  function commit(fn: (a: Account) => Account) {
    try {
      const next = fn(accountRef.current);
      accountRef.current = next;
      setAccount(next);
      setFormError("");
      return true;
    } catch (e) {
      setFormError(
        e instanceof Error ? e.message : "Unable to update the preview.",
      );
      return false;
    }
  }
  function go(p: Page) {
    setPage(p);
    setCollapsed(false);
    setSearch("");
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function choose(symbol: Symbol) {
    draftDirty.current = false;
    anchoredToken.current = null;
    setDraft(
      defaultDraft(
        accountRef.current,
        symbol,
        available(accountRef.current, symbol) === 0 ? "Limit" : draft.kind,
      ),
    );
    setFormError("");
  }
  function patch(d: Partial<Draft>) {
    draftDirty.current = true;
    setDraft((prev) => ({ ...prev, ...d }));
    setFormError("");
  }
  function showOrderWorkspace(mode: "live" | "plans" | "builder") {
    const hash =
      mode === "builder"
        ? "#orders/planner"
        : mode === "plans"
          ? "#orders/plans"
          : "#orders";
    if (window.location.hash !== hash) {
      window.history.pushState(null, "", hash);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    }
    setOrderMode(mode);
    setCollapsed(false);
    setSearch("");
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  useEffect(() => {
    const restore = () => {
      if (window.location.hash.startsWith("#orders"))
        setOrderMode(
          window.location.hash === "#orders/planner"
            ? "builder"
            : window.location.hash === "#orders/plans"
              ? "plans"
              : "live",
        );
    };
    window.addEventListener("hashchange", restore);
    window.addEventListener("popstate", restore);
    return () => {
      window.removeEventListener("hashchange", restore);
      window.removeEventListener("popstate", restore);
    };
  }, []);
  function newPlan(kind: Kind = "Limit") {
    setDraft(defaultDraft(accountRef.current, draft.symbol, kind));
    showOrderWorkspace("builder");
    setFormError("");
    requestAnimationFrame(() => {
      composer.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      composer.current
        ?.querySelector<HTMLInputElement>("input")
        ?.focus({ preventScroll: true });
    });
  }
  function simulation() {
    setSimPrice(String(account.prices[draft.symbol]));
    setFormError("");
    setDialog("simulation");
  }
  const price = account.prices[draft.symbol];
  const openOrders = account.orders.filter(active);
  const total =
    account.cash +
    tokens.reduce(
      (sum, t) => sum + account.holdings[t.id] * account.prices[t.id],
      0,
    );
  const selectedOrder = account.orders.find((o) => o.id === detail);
  const error = validate(account, draft);
  const orders = account.orders.filter(
    (o) =>
      (filter === "All" || (filter === "Open" ? active(o) : !active(o))) &&
      `${label(o.symbol)} ${o.symbol} ${o.kind} ${o.status}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  function orderList(list: Order[]) {
    return (
      <div className="order-list">
        {list.length ? (
          list.map((o) => (
            <button
              className="order-row"
              key={o.id}
              title={tokenFor(o.symbol).address}
              onClick={() => setDetail(o.id)}
            >
              <TokenIcon token={tokenFor(o.symbol)} />
              <span className="order-asset">
                <b>
                  {label(o.symbol)} <span>{o.side}</span>
                </b>
                <small>
                  {quantityLabel(o.quantity)} {label(o.symbol)} · {o.kind}
                </small>
                {o.symbol === tokenFor(o.symbol).address && (
                  <small>{shortAddress(o.symbol)}</small>
                )}
              </span>
              <Rule order={o} />
              <State order={o} />
              <ChevronRight size={15} />
            </button>
          ))
        ) : (
          <div className="empty-state">
            <Layers3 size={28} />
            <h3>{search ? "No matching orders." : "Nothing waiting here."}</h3>
            <p>
              {search
                ? "Try a token symbol or order type."
                : "Create a plan from a position to see it here."}
            </p>
            <button
              className="word-link"
              onClick={() => {
                setSearch("");
                newPlan();
              }}
            >
              Create an order <ArrowRight size={15} />
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="app">
      <a
        className="skip-link"
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main")?.focus();
        }}
      >
        Skip to content
      </a>
      <header className={`header ${collapsed ? "is-collapsed" : ""}`}>
        <div className="header-inner">
          <button
            className="brand-button"
            aria-label="Fub home"
            onClick={() => go("Overview")}
          >
            <Wordmark />
          </button>
          <nav aria-label="Main navigation" inert={collapsed}>
            {pages.map((p) => (
              <button
                key={p}
                aria-current={p === page ? "page" : undefined}
                className={`nav-link ${p === page ? "active" : ""}`}
                onClick={() => go(p)}
              >
                {p}
              </button>
            ))}
          </nav>
          <div className="header-actions" inert={collapsed}>
            <a
              className="social-x-link"
              href="https://github.com/DylComp/fub"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Fub source on GitHub"
              title="Fub source on GitHub"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
                <path d="M12 .75a11.25 11.25 0 0 0-3.558 21.923c.563.104.77-.244.77-.542 0-.267-.01-.974-.016-1.913-3.13.68-3.79-1.509-3.79-1.509-.512-1.3-1.25-1.646-1.25-1.646-1.023-.7.078-.686.078-.686 1.131.08 1.726 1.161 1.726 1.161 1.005 1.723 2.636 1.225 3.277.937.102-.728.393-1.225.715-1.507-2.499-.284-5.126-1.25-5.126-5.567 0-1.23.44-2.235 1.16-3.022-.116-.284-.504-1.43.11-2.98 0 0 .945-.303 3.094 1.155A10.77 10.77 0 0 1 12 6.175c.957.004 1.922.13 2.824.38 2.148-1.458 3.091-1.155 3.091-1.155.615 1.55.227 2.696.112 2.98.722.787 1.158 1.792 1.158 3.022 0 4.329-2.632 5.28-5.139 5.56.404.349.764 1.04.764 2.096 0 1.514-.014 2.736-.014 3.108 0 .3.203.651.774.541A11.25 11.25 0 0 0 12 .75Z" />
              </svg>
            </a>
            <a
              className="social-x-link"
              href="https://x.com/FubTool"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Fub on X (@FubTool)"
              title="@FubTool on X"
            >
              <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true">
                <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.64 7.584H.47l8.6-9.835L0 1.154h7.594l5.243 6.932 6.064-6.933Zm-1.29 19.49h2.039L6.487 3.24H4.3l13.31 17.403Z" />
              </svg>
            </a>
            <button
              className="button wallet-button"
              aria-label={
                connection.session ? "Connected wallet" : "Connect wallet"
              }
              onClick={() => { if (!connection.session && page !== "Launch" && canImport) openImport(); else setDialog("connection"); }}
            >
              <Wallet size={15} />
              <span>
                {connection.session
                  ? shortAddress(connection.session.address)
                  : "Connect wallet"}
              </span>
            </button>
          </div>
        </div>
      </header>
      <main id="main" className="main" tabIndex={-1}>
        {storageError && (
          <div className="notice" role="alert">
            Browser storage is unavailable. Preview changes will reset on
            reload.
          </div>
        )}
        {page !== "Pay" && page !== "Overview" && (
          <div className="page-heading">
            <div>
              <p className="eyebrow">
                {page === "Docs" || page === "Activity"
                  ? "FOMO HUB"
                  : page === "Tokens" || page === "Launch"
                    ? "PUMP.FUN CREATOR FEES"
                    : "SPOT MEMECOINS. YOUR RULES."}
              </p>
              <h1>
                {page === "Orders"
                  ? "Every move, planned."
                  : page === "Copy trading"
                    ? "Their trades. Your limits."
                    : page === "Wallets"
                      ? "Find your people on Fomo."
                      : page === "Launch"
                        ? "A coin for someone on Fomo."
                        : page === "Tokens"
                          ? "Coins for the people on Fomo."
                          : page === "Docs"
                            ? "Fub documentation."
                            : "Know what happened."}
              </h1>
              <p className="workspace-caption">
                {page === "Copy trading"
                  ? "Find a Fomo trader. Set your own limits."
                  : page === "Wallets"
                    ? "Fomo profiles, trading stats and wallet holdings. Search by username."
                    : page === "Launch"
                      ? "Choose a recipient. Create a coin. Split creator fees 80/20."
                      : page === "Tokens"
                        ? "Every Fub launch. Every recipient. Confirmed creator fees."
                        : page === "Docs"
                          ? "Orders, copy trading, Pay, launches and creator fees."
                          : page === "Activity"
                            ? "Launches, trades, creator fees and payment records."
                            : "Discover on Fomo. Plan your exits here."}
              </p>
            </div>
            <div className="heading-actions">
              {page !== "Docs" && page !== "Activity" && (
                <button
                  className="icon-button"
                  aria-label="Preview settings"
                  onClick={() => setDialog("settings")}
                >
                  <Settings2 size={18} />
                </button>
              )}
              <a
                className="word-link fomo-link"
                href="https://fomo.family/"
                target="_blank"
                rel="noreferrer"
              >
                Open fomo <ArrowUpRight size={15} />
              </a>
            </div>
          </div>
        )}
        {page === "Overview" && (
          <Suspense fallback={<p className="copy-help">Loading Fub…</p>}>
            <Overview onNavigate={go} onPlan={newPlan} />
          </Suspense>
        )}
        {page === "Orders" && orderMode === "builder" && (
          <>
            <div
              className="wallet-view-tabs order-mode"
              aria-label="Order workspace"
            >
              <button onClick={() => showOrderWorkspace("live")}>
                Live orders
              </button>
              <button className="selected" aria-pressed="true">
                Order planner
              </button>
              <button onClick={() => showOrderWorkspace("plans")}>
                Saved plans
              </button>
            </div>
            <section className="portfolio-strip" aria-label="Sample portfolio">
              <div className="portfolio-total">
                <span className="muted">Sample portfolio</span>
                <div className="balance-value">
                  {usd(total).split(".")[0]}
                  <span>.{usd(total).split(".")[1]}</span>
                </div>
                <span className="portfolio-caption">
                  Illustrative balances · not a connected wallet
                </span>
              </div>
              <div className="stat">
                <span>Open orders</span>
                <strong>
                  {openOrders.length.toString().padStart(2, "0")}
                  <span className="stat-dot" />
                </strong>
                <small>Saved on this device</small>
              </div>
              <div className="stat">
                <span>Available USDC</span>
                <strong>{usd(availableCash(account))}</strong>
                <small>Unallocated sample balance</small>
              </div>
              <button
                className="button primary new-order"
                onClick={() => newPlan()}
              >
                <Plus size={17} />
                New order
              </button>
            </section>
            <div className="workspace">
              <section className="market-panel" aria-label="Position and chart">
                <div className="market-top">
                  <div className="token-picker">
                    <TokenIcon token={tokenFor(draft.symbol)} />
                    <label className="sr-only" htmlFor="token-select">
                      Selected token
                    </label>
                    <select
                      id="token-select"
                      value={draft.symbol}
                      onChange={(e) => choose(e.target.value as Symbol)}
                    >
                      {[...tokens]
                        .sort(
                          (a, b) =>
                            Number(b.symbol === "BONK") -
                            Number(a.symbol === "BONK"),
                        )
                        .map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name} · {t.symbol}
                            {t.id === t.address
                              ? ` · ${shortAddress(t.address)}`
                              : ""}
                          </option>
                        ))}
                    </select>
                    <ChevronDown size={14} />
                  </div>
                  <button
                    className="word-link search-token-button"
                    onClick={() => setDialog("tokens")}
                  >
                    <Search size={15} /> Find token
                  </button>
                </div>
                <div className="token-contract">
                  <a
                    href={`https://solscan.io/token/${tokenFor(draft.symbol).address}`}
                    target="_blank"
                    rel="noreferrer"
                    title={tokenFor(draft.symbol).address}
                  >
                    {shortAddress(tokenFor(draft.symbol).address)}{" "}
                    <ArrowUpRight size={12} />
                  </a>
                  <button
                    className="word-link"
                    aria-label="Copy token contract"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(
                          tokenFor(draft.symbol).address,
                        );
                        notify("Contract address copied.");
                      } catch {
                        notify(
                          "Copy unavailable. Open the contract link to view the address.",
                        );
                      }
                    }}
                  >
                    Copy
                  </button>
                  <a
                    className="word-link token-fomo-link"
                    href={fomoTokenUrl(tokenFor(draft.symbol).address)}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open ${label(draft.symbol)} on Fomo`}
                  >
                    View on Fomo <ArrowUpRight size={12} />
                  </a>
                </div>
                <div className="quote">
                  <h2>{priceLabel(draft.symbol, price)}</h2>
                  {market.bars.length ? (
                    <span
                      className={
                        market.stale || market.status !== "ready"
                          ? "muted"
                          : "positive"
                      }
                    >
                      <small>
                        {market.stale || market.status !== "ready"
                          ? "Last reference · feed delayed"
                          : "Market reference · preview orders"}
                      </small>
                    </span>
                  ) : (
                    <span className="muted">
                      <small>
                        {["BONK", "SOL", "JUP"].includes(draft.symbol)
                          ? "Sample price"
                          : "Saved search reference"}
                      </small>
                    </span>
                  )}
                </div>
                <Chart
                  key={draft.symbol}
                  label={label(draft.symbol)}
                  symbol={draft.symbol}
                  price={price}
                  draft={draft}
                  change={(value)=>{if(mcReady&&!mcSummary)patch(value);}}
                  period={period}
                  setPeriod={setPeriod}
                  market={market}
                  retry={retryMarket}
                  history={history}
                  loadEarlier={loadEarlier}
                />
                <div className="position-summary">
                  <div>
                    <button
                      className="word-link sample-position-edit"
                      onClick={() => {
                        setPositionAmount(
                          String(account.holdings[draft.symbol]),
                        );
                        setFormError("");
                        setDialog("position");
                      }}
                    >
                      Your sample position <Settings2 size={11} />
                    </button>
                    <b>
                      {quantityLabel(account.holdings[draft.symbol])}{" "}
                      {label(draft.symbol)}
                    </b>
                  </div>
                  <div>
                    <span>Position value</span>
                    <b>{usd(account.holdings[draft.symbol] * price)}</b>
                  </div>
                  <div>
                    <span>Available for rules</span>
                    <b>
                      {quantityLabel(available(account, draft.symbol))}{" "}
                      {label(draft.symbol)}
                    </b>
                  </div>
                </div>
                <div className="chart-bottom">
                  <span>
                    <span className="legend-dot blue" />
                    Price <span className={`legend-dot ${draft.side === "Sell" ? "red" : "green"}`} />
                    {draft.side} limit
                  </span>
                  <button className="word-link" onClick={simulation}>
                    <FlaskConical size={13} />
                    Test a price
                  </button>
                </div>
              </section>
              <section
                ref={composer}
                className="composer"
                aria-label="Order builder"
              >
                <div className="composer-heading">
                  <h2>Set your next move.</h2>
                  <span className="mini-label">PREVIEW</span>
                </div>
                <div className="order-tabs" aria-label="Order type">
                  {(["Limit"] as Kind[]).map((k) => (
                    <button
                      key={k}
                      aria-pressed={draft.kind === k}
                      className={draft.kind === k ? "selected" : ""}
                      onClick={() => {
                        setDraft(defaultDraft(account, draft.symbol, k));
                        setFormError("");
                      }}
                    >
                      {k}
                    </button>
                  ))}
                </div>
                <p className="order-explainer">{descriptions[draft.kind]}</p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if(draft.side==="Sell"&&!amountReady){setFormError("Check the native-currency sell amount before reviewing.");return;}
                    if (!mcReady) { setFormError("Check the market cap and fresh supply before reviewing."); return; }
                    if (error) {
                      setFormError(error);
                      return;
                    }
                    setDialog("review");
                  }}
                >
                  {draft.kind === "Limit" && (
                    <div className="side-tabs">
                      {(["Buy", "Sell"] as const).map((side) => (
                        <button
                          type="button"
                          key={side}
                          className={`${draft.side === side ? "selected" : ""} ${side.toLowerCase()}`}
                          aria-pressed={draft.side === side}
                          onClick={() =>
                            patch({
                              side,
                              quantity:
                                side === "Sell"
                                  ? available(account, draft.symbol) * 0.25
                                  : 100 / price,
                              target: Number(
                                (
                                  price * (side === "Buy" ? 0.9 : 1.15)
                                ).toPrecision(6),
                              ),
                            })
                          }
                        >
                          {side}
                        </button>
                      ))}
                    </div>
                  )}
                  {draft.side === "Sell" ? <NativeSellAmount key={draft.symbol} mint={tokenFor(draft.symbol).address} quantity={Number.isFinite(draft.quantity)?String(draft.quantity):''} decimals={9} disabled={dialog==='review'} onChange={quantity=>patch({quantity:Number(quantity)})} onReady={setAmountReady}/> : <>
                  <label className="field">
                    <span>
                      Amount to buy
                      <small>
                        ≈{" "}
                        {usd(
                          (Number.isFinite(draft.quantity)
                            ? draft.quantity
                            : 0) * price,
                        )}
                      </small>
                    </span>
                    <div className="input-shell">
                      <input
                        aria-label="Token amount"
                        type="number"
                        min="0"
                        step="any"
                        required
                        value={
                          Number.isFinite(draft.quantity) ? draft.quantity : ""
                        }
                        onChange={(e) =>
                          patch({
                            quantity:
                              e.target.value === ""
                                ? NaN
                                : Number(e.target.value),
                          })
                        }
                      />
                      <span>{label(draft.symbol)}</span>
                    </div>
                  </label>
                  </>}
                  <div className="percent-buttons">
                    {[25, 50, 75, 100].map((p) => (
                      <button
                        type="button"
                        key={p}
                        onClick={() =>
                          patch({
                            quantity:
                              Math.floor(
                                (((draft.side === "Sell"
                                  ? available(account, draft.symbol)
                                  : availableCash(account) / draft.target) *
                                  p) /
                                  100) *
                                  1e6,
                              ) / 1e6,
                          })
                        }
                      >
                        {p === 100 ? "Max" : p + "%"}
                      </button>
                    ))}
                  </div>
                  <MarketCapEntry disabled={dialog==="review"} valueKey={`${draft.target}:${draft.stop}`} key={`${draft.symbol}:${draft.kind}:${draft.side}`} mint={tokenFor(draft.symbol).address} active={draft.kind!=="Trailing"} hasStop={draft.kind==="Bracket"} onChange={(target,stop)=>patch({target:Number(target),...(stop!==undefined?{stop:Number(stop)}:{})})} onReady={(ready,summary)=>{setMcReady(ready);setMcSummary(summary);}}>
                  {draft.kind !== "Trailing" && (
                    <label className="field target-field">
                      <span>
                        <i className={`legend-dot ${draft.side === "Sell" ? "red" : "green"}`} />
                        {draft.kind === "Bracket"
                          ? "Take profit at"
                          : "Limit price"}
                        <small>
                          {Number.isFinite(draft.target)
                            ? ((draft.target / price - 1) * 100).toFixed(1)
                            : "0"}
                          %
                        </small>
                      </span>
                      <div className="input-shell">
                        <span>$</span>
                        <input
                          aria-label={
                            draft.kind === "Bracket"
                              ? "Take profit price"
                              : "Limit price"
                          }
                          type="number"
                          min="0"
                          step="any"
                          required
                          value={
                            Number.isFinite(draft.target) ? draft.target : ""
                          }
                          onChange={(e) =>
                            patch({
                              target:
                                e.target.value === ""
                                  ? NaN
                                  : Number(e.target.value),
                            })
                          }
                        />
                        <span>USD</span>
                      </div>
                    </label>
                  )}
                  {draft.kind === "Bracket" && (
                    <label className="field stop-field">
                      <span>
                        <i className="legend-dot pink" />
                        Stop loss at
                        <small>
                          {Number.isFinite(draft.stop)
                            ? ((draft.stop / price - 1) * 100).toFixed(1)
                            : "0"}
                          %
                        </small>
                      </span>
                      <div className="input-shell">
                        <span>$</span>
                        <input
                          aria-label="Stop loss price"
                          type="number"
                          min="0"
                          step="any"
                          required
                          value={Number.isFinite(draft.stop) ? draft.stop : ""}
                          onChange={(e) =>
                            patch({
                              stop:
                                e.target.value === ""
                                  ? NaN
                                  : Number(e.target.value),
                            })
                          }
                        />
                        <span>USD</span>
                      </div>
                    </label>
                  )}
                  </MarketCapEntry>
                  {draft.kind === "Trailing" && (
                    <label className="field">
                      <span>
                        Distance from highest price<b>{draft.trail}%</b>
                      </span>
                      <input
                        aria-label="Trailing distance"
                        type="range"
                        min="1"
                        max="50"
                        value={draft.trail}
                        onChange={(e) =>
                          patch({ trail: Number(e.target.value) })
                        }
                      />
                      <small className="muted">
                        Initial sample trigger:{" "}
                        {priceLabel(
                          draft.symbol,
                          price * (1 - draft.trail / 100),
                        )}
                      </small>
                    </label>
                  )}
                  <label className="expiry-row">
                    <span>
                      <Clock3 size={13} />
                      Expires in
                    </span>
                    <select
                      aria-label="Order expiry"
                      value={draft.days}
                      onChange={(e) => patch({ days: Number(e.target.value) })}
                    >
                      <option value="1">24 hours</option>
                      <option value="7">7 days</option>
                      <option value="30">30 days</option>
                    </select>
                  </label>
                  {formError && (
                    <p className="error-message" role="alert">
                      {formError}
                    </p>
                  )}
                  <button className="button primary full" type="submit">
                    Review order <ArrowRight size={16} />
                  </button>
                  <p className="form-note">
                    Preview only. No signature. No funds moved.
                  </p>
                </form>
              </section>
            </div>
            <section className="orders-section">
              <div className="section-heading">
                <h2>
                  Open orders <span>{openOrders.length}</span>
                </h2>
                <button
                  className="word-link"
                  onClick={() => {
                    showOrderWorkspace("plans");
                  }}
                >
                  View all <ArrowUpRight size={15} />
                </button>
              </div>
              {orderList(openOrders.slice(0, 4))}
            </section>
            <section className="positions-section">
              <div className="section-heading">
                <h2>Your positions</h2>
                <span className="muted small">Sample holdings</span>
              </div>
              <div className="position-cards">
                {tokens.map((t) => (
                  <button
                    className={draft.symbol === t.id ? "selected" : ""}
                    key={t.id}
                    onClick={() => {
                      choose(t.id);
                      window.scrollTo({ top: 150, behavior: "smooth" });
                    }}
                  >
                    <TokenIcon token={t} />
                    <span>
                      <b>{t.symbol}</b>
                      <small>
                        {quantityLabel(account.holdings[t.id])} tokens
                      </small>
                    </span>
                    <span className="position-value">
                      <b>
                        {usd(account.holdings[t.id] * account.prices[t.id])}
                      </b>
                      <small>
                        Set a rule <ArrowUpRight size={11} />
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          </>
        )}
        {page === "Docs" && (
          <Docs
            onPlan={newPlan}
            onCopy={() => go("Copy trading")}
            onPay={() => go("Pay")}
            onToken={() => go("Tokens")}
            onLaunch={() => go("Launch")}
          />
        )}
        {page === "Pay" && (
          <Suspense fallback={<p>Loading Fomo Pay…</p>}>
            <Pay />
          </Suspense>
        )}
        {page === "Launch" && (
          <Suspense fallback={<p className="copy-help">Loading launchpad…</p>}>
            <Launchpad
              connection={connection}
              onConnect={() => setDialog("connection")}
            />
          </Suspense>
        )}
        {page === "Tokens" && (
          <Suspense fallback={<p>Loading token details…</p>}>
            <TokenDirectory onLaunch={() => go("Launch")} />
          </Suspense>
        )}
        {page === "Wallets" && (
          <WalletWorkspace
            address={watchedAddress}
            setAddress={setWatchedAddress}
            connectedAddress={connection.session?.address}
            onConnect={() => setDialog("connection")}
            onCopy={(address) => {
              setCopyAddress(address);
              go("Copy trading");
            }}
            onDirectExit={openDirectExits}
            onPlan={(token, quantity) => {
              try {
                let next = addToken(accountRef.current, token);
                const id = idFor(token.address);
                next = {
                  ...next,
                  prices: { ...next.prices, [id]: token.price },
                };
                next = setSamplePosition(next, id, quantity);
                accountRef.current = next;
                setAccount(next);
                setDraft(defaultDraft(next, id, "Limit"));
                draftDirty.current = false;
                anchoredToken.current = null;
                setFormError("");
                showOrderWorkspace("builder");
                notify(
                  "Holding copied into the sample planner. No real order was placed.",
                );
                return null;
              } catch (error) {
                return error instanceof Error
                  ? error.message
                  : "Unable to open this holding.";
              }
            }}
          />
        )}
        <div hidden={page !== "Copy trading"}>
          <CopyTrading
            signNativeCopy={connection.signNativeCopy}
            initialAddress={copyAddress}
            wallet={connection.session?.address}
            active={page === "Copy trading"}
            onConnect={() => setDialog("connection")}
            signSession={connection.signWalletSession}
            onInspect={(address) => {
              setWatchedAddress(address);
              go("Wallets");
            }}
          />
        </div>
        {page === "Orders" && orderMode !== "builder" && (
          <>
            <section className="orders-scope" aria-label="Fomo limit orders">
              <h2>Limit orders for your Fomo wallet.</h2>
              <p>Choose your buy or sell level, amount and expiry. Review a fixed SOL buy or a sale from your existing wallet.</p>
              <button className="button primary" onClick={connection.session?()=>openDirectExits():()=>setDialog('connection')}>{connection.session?'Manage limit orders':'Connect Fomo wallet'}</button>
              <button className="word-link" onClick={()=>newPlan('Limit')}>Open limit planner <ArrowUpRight size={14}/></button>
            </section>
            <div
              className="wallet-view-tabs order-mode"
              aria-label="Order workspace"
            >
              <button
                className={orderMode === "live" ? "selected" : ""}
                aria-pressed={orderMode === "live"}
                onClick={() => showOrderWorkspace("live")}
              >
                Live orders
              </button>
              <button onClick={() => newPlan()}>Order planner</button>
              <button
                className={orderMode === "plans" ? "selected" : ""}
                aria-pressed={orderMode === "plans"}
                onClick={() => showOrderWorkspace("plans")}
              >
                Saved plans
              </button>
            </div>
            {orderMode === "plans" && (
              <>
                <div className="section-toolbar">
                  <div className="filter-tabs" aria-label="Order filter">
                    {["Open", "History", "All"].map((f) => (
                      <button
                        className={filter === f ? "selected" : ""}
                        aria-pressed={filter === f}
                        key={f}
                        onClick={() => setFilter(f)}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                  <button
                    className="button primary compact"
                    onClick={() => newPlan()}
                  >
                    <Plus size={16} />
                    New order
                  </button>
                </div>
                <label className="search-field">
                  <Search size={16} />
                  <input
                    aria-label="Search orders"
                    placeholder="Search token or order type"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
                <p className="table-label">
                  SAVED PREVIEW ORDERS · LOCAL TO THIS BROWSER
                </p>
                {orderList(orders)}
              </>
            )}
          </>
        )}
        {page === "Activity" && (
          <Suspense fallback={<p className="copy-help">Loading activity…</p>}>
            <Activity
              connection={connection}
              onConnect={() => setDialog("connection")}
              onNavigate={go}
            />
          </Suspense>
        )}
        {page !== "Pay" &&
          page !== "Tokens" &&
          page !== "Docs" &&
          page !== "Activity" &&
          page !== "Overview" && (
            <div className="bottom-strip">
              <p>
                Saved plans do not place trades. Execution requires wallet
                permission and an active trading plan.
              </p>
              <button
                className="word-link"
                onClick={() => setDialog("connection")}
              >
                Connection status <ArrowUpRight size={13} />
              </button>
            </div>
          )}
      </main>
      {page !== "Pay" && (
        <>
          <footer className="footer">
            <span>
              <Wordmark />
              <span>Independent companion. Not affiliated with Fomo.</span>
            </span>
            <div>
              <button onClick={() => go("Docs")}>Docs</button>
              {page !== "Docs" && page !== "Activity" && page !== "Overview" && (
                <button onClick={() => setDialog("settings")}>
                  Preview settings
                </button>
              )}
              <a href="https://fomo.family/" target="_blank" rel="noreferrer">
                fomo.family <ArrowUpRight size={12} />
              </a>
            </div>
          </footer>
          <p className="chart-attribution">
            TradingView Lightweight Charts™ · Copyright (с) 2025{" "}
            <a
              href="https://www.tradingview.com/"
              target="_blank"
              rel="noreferrer"
            >
              TradingView, Inc.
            </a>{" "}
            · Market data by{" "}
            <a href="https://www.codex.io/" target="_blank" rel="noreferrer">
              Codex
            </a>{" "}
            when connected.
          </p>
        </>
      )}
      {dialog === "tokens" && (
        <TokenSearch
          close={() => setDialog(null)}
          select={(token) => {
            if (commit((a) => addToken(a, token))) {
              choose(idFor(token.address));
              setDialog(null);
            } else
              notify(
                "Unable to add this token. The preview supports up to 100 saved tokens.",
              );
          }}
        />
      )}
      {dialog === "position" && (
        <Modal
          title={`Plan a ${label(draft.symbol)} position.`}
          description="Enter a hypothetical token balance to test exits. This changes only your sample account."
          close={() => setDialog(null)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (
                commit((a) =>
                  setSamplePosition(a, draft.symbol, Number(positionAmount)),
                )
              ) {
                setDraft(
                  defaultDraft(accountRef.current, draft.symbol, "Limit"),
                );
                draftDirty.current = true;
                setDialog(null);
                notify("Sample position updated. No wallet balance changed.");
              }
            }}
          >
            <label className="field">
              <span>Sample token amount</span>
              <input
                aria-label="Sample token amount"
                type="number"
                min="0"
                step="any"
                required
                value={positionAmount}
                onChange={(e) => setPositionAmount(e.target.value)}
              />
            </label>
            {formError && (
              <p className="error-message" role="alert">
                {formError}
              </p>
            )}
            <button type="submit" className="button primary full">
              Use sample position
            </button>
          </form>
        </Modal>
      )}
      {dialog === "review" && (
        <Modal
          title="Your plan, before you commit."
          description="Review a preview order. This does not request a wallet signature or place a trade."
          close={() => setDialog(null)}
        >
          {mcSummary&&<p className="copy-help">{mcSummary}</p>}
          <div className="review-token">
            <TokenIcon token={tokenFor(draft.symbol)} />
            <div>
              <b>
                {draft.side} {quantityLabel(draft.quantity)}{" "}
                {label(draft.symbol)}
              </b>
              <span>
                {draft.kind} · {draft.days}-day expiry
              </span>
            </div>
            <span className="mini-label">PREVIEW</span>
          </div>
          <p className="review-contract">
            Solana contract <span>{tokenFor(draft.symbol).address}</span>
          </p>
          <dl className="review-details">
            <div>
              <dt>Sample allocation</dt>
              <dd>{usd(draft.quantity * price)}</dd>
            </div>
            {draft.kind !== "Trailing" && (
              <div>
                <dt>
                  {draft.kind === "Bracket"
                    ? "Take-profit trigger"
                    : "Limit trigger"}
                </dt>
                <dd className="positive">
                  {priceLabel(draft.symbol, draft.target)}
                </dd>
              </div>
            )}
            {draft.kind === "Bracket" && (
              <div>
                <dt>Stop-loss trigger</dt>
                <dd className="negative">
                  {priceLabel(draft.symbol, draft.stop)}
                </dd>
              </div>
            )}
            {draft.kind === "Trailing" && (
              <div>
                <dt>Trailing distance</dt>
                <dd>{draft.trail}% from the highest observed price</dd>
              </div>
            )}
            <div>
              <dt>Funds destination</dt>
              <dd>None · local simulation</dd>
            </div>
            <div>
              <dt>Fees</dt>
              <dd>Excluded from preview fills</dd>
            </div>
          </dl>
          <div className="notice">
            <ShieldCheck size={18} />
            <p>
              Real trigger orders may fill at a different price. This preview
              models the rule, not liquidity or execution quality.
            </p>
          </div>
          {formError && (
            <p className="error-message" role="alert">
              {formError}
            </p>
          )}
          <button
            className="button primary full"
            onClick={() => {
              if (commit((a) => createOrder(a, draft))) {
                setDialog(null);
                setDraft(
                  defaultDraft(accountRef.current, draft.symbol, draft.kind),
                );
                notify("Preview order saved. Try a price scenario to test it.");
              }
            }}
          >
            Save preview order <Check size={17} />
          </button>
        </Modal>
      )}
      {dialog === "connection" && (
        <Modal
          title={connection.session ? "Your wallet." : "Connect your wallet."}
          description={
            connection.session
              ? "Manage wallet access and view your holdings."
              : "Connect the Solana wallet you use with Fomo."
          }
          close={() => setDialog(null)}
        >
          <WalletPanel
            connection={connection}
            onConnected={() => setDialog(null)}
            onImport={canImport ? () => { setDialog(null); openImport(); } : undefined}
            onPermissions={canImport ? () => { setDialog(null); openPermissions(); } : undefined}
            onView={(address) => {
              setWatchedAddress(address);
              setDialog(null);
              go("Wallets");
            }}
          />
        </Modal>
      )}
      {dialog === "settings" && (
        <Modal
          title="Make yourself at home."
          description="This preview is saved only in this browser. It uses separate storage from the old Fomo Pay demo."
          close={() => setDialog(null)}
        >
          <div className="connection-item">
            <CircleHelp size={20} />
            <div>
              <b>What can I try?</b>
              <p>
                Create bracket, limit and trailing orders. Test sample prices,
                inspect fills, cancel allocations, and export activity.
              </p>
            </div>
          </div>
          <button
            className="button secondary full"
            onClick={() => {
              commit(() => initialAccount());
              setDraft(defaultDraft(accountRef.current, "BONK"));
              draftDirty.current = false;
              anchoredToken.current = null;
              setDialog(null);
              notify("Sample account reset.");
            }}
          >
            <RotateCcw size={16} />
            Reset sample account
          </button>
        </Modal>
      )}
      {dialog === "simulation" && (
        <Modal
          title="Test your rules."
          description="Change a sample price to evaluate saved orders. Nothing is sent to a wallet or exchange."
          close={() => setDialog(null)}
        >
          <label className="field">
            <span>Token</span>
            <select
              aria-label="Simulation token"
              value={draft.symbol}
              onChange={(e) => {
                choose(e.target.value as Symbol);
                setSimPrice(String(account.prices[e.target.value as Symbol]));
              }}
            >
              {tokens.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.symbol} · {shortAddress(t.address)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Next sample price · USD</span>
            <input
              aria-label="Simulation price"
              type="number"
              min="0"
              step="any"
              value={simPrice}
              onChange={(e) => setSimPrice(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Simulated fill size</span>
            <select
              aria-label="Simulated fill size"
              value={simFraction}
              onChange={(e) => setSimFraction(Number(e.target.value))}
            >
              <option value="1">100% of remaining order</option>
              <option value="0.5">50% of remaining order</option>
            </select>
          </label>
          <p className="fine-print">
            Only matching saved rules will fill. Trailing highs update with each
            scenario. Fees and slippage are excluded; this is not a backtest.
          </p>
          {formError && (
            <p role="alert" className="error-message">
              {formError}
            </p>
          )}
          <button
            className="button primary full"
            onClick={() => {
              if (
                commit((a) =>
                  simulate(a, draft.symbol, Number(simPrice), simFraction),
                )
              ) {
                setDialog(null);
                setDraft(
                  defaultDraft(accountRef.current, draft.symbol, draft.kind),
                );
                notify(
                  "Scenario applied. Check orders and activity for the result.",
                );
              }
            }}
          >
            <FlaskConical size={16} />
            Run preview scenario
          </button>
        </Modal>
      )}
      {selectedOrder && (
        <Modal
          title={`${label(selectedOrder.symbol)} · ${selectedOrder.kind}`}
          description="Saved preview order. No real transaction or execution receipt exists."
          close={() => setDetail(null)}
        >
          <p className="review-contract">
            Solana contract{" "}
            <span>{tokenFor(selectedOrder.symbol).address}</span>
          </p>
          <div className="order-detail-status">
            <State order={selectedOrder} />
            <span className="mini-label">PREVIEW</span>
          </div>
          <dl className="review-details">
            <div>
              <dt>Amount</dt>
              <dd>
                {selectedOrder.side} {quantityLabel(selectedOrder.quantity)}{" "}
                {label(selectedOrder.symbol)}
              </dd>
            </div>
            <div>
              <dt>Rule</dt>
              <dd>
                <Rule order={selectedOrder} />
              </dd>
            </div>
            <div>
              <dt>Simulated fill</dt>
              <dd>
                {quantityLabel(selectedOrder.filled)} /{" "}
                {quantityLabel(selectedOrder.quantity)}
              </dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>
                {new Date(selectedOrder.expiresAt).toLocaleString([], {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </dd>
            </div>
            <div>
              <dt>Storage</dt>
              <dd>This browser only</dd>
            </div>
          </dl>
          <div className="detail-events">
            {account.events
              .filter((e) => e.orderId === selectedOrder.id)
              .map((e) => (
                <div key={e.id}>
                  <i />
                  <span>
                    <b>{e.title}</b>
                    <small>{e.detail}</small>
                  </span>
                </div>
              ))}
          </div>
          {active(selectedOrder) && (
            <button
              className="button danger full"
              onClick={() => {
                commit((a) => cancelOrder(a, selectedOrder.id));
                notify("Preview cancelled. Unfilled allocation released.");
              }}
            >
              <X size={16} />
              Cancel preview order
            </button>
          )}
          <button
            className="button secondary full"
            onClick={() => setDetail(null)}
          >
            Done
          </button>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
    </div>
  );
}
