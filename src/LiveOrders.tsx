import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import type { WalletConnection } from "./useWallet";
import {
  canAmend,
  decimalBps,
  parseAmendment,
  validChallenge,
} from "./live-orders";
import type {
  Amendment,
  LiveHistory,
  LiveOrder,
  TriggerSession,
} from "./live-orders";
import { TriggerError, triggerRequest } from "./trigger-api";
import { idFor, shortAddress } from "./assets";
import { Modal } from "./ui";
import type { OrderIntent } from "./order-draft";
import { FundingPanel } from "./FundingPanel";

type Login = { wallet: string; message: string; expiresAt: number };
const label = (mint: string) =>
  idFor(mint) === mint ? shortAddress(mint) : idFor(mint);
const stateLabel = (state: string) => state.replaceAll("_", " ");
const price = (value?: number) =>
  value === undefined
    ? "Not provided"
    : `$${value.toLocaleString("en-US", { maximumSignificantDigits: 12 })}`;

export function LiveOrders({
  connection,
  onConnect,
  intent,
  clearIntent,
}: {
  connection: WalletConnection;
  onConnect: () => void;
  intent?: OrderIntent | null;
  clearIntent?: () => void;
}) {
  const address = connection.session?.address;
  const identity = connection.session;
  const [session, setSession] = useState<TriggerSession | null>(null);
  const [login, setLogin] = useState<Login | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [state, setState] = useState<"active" | "past">("active");
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [history, setHistory] = useState<LiveHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<LiveOrder | null>(null);
  const [details, setDetails] = useState<LiveOrder | null>(null);
  const [cancelling, setCancelling] = useState<LiveOrder | null>(null);
  const generation = useRef(0);
  const signing = useRef(0);
  const authRequest = useRef<AbortController | null>(null);
  const retryAt = useRef(0);
  const ready =
    !!address &&
    session?.address === address &&
    !!session.csrf &&
    (session.expiresAt || 0) > Date.now();

  useEffect(() => {
    const id = ++generation.current;
    signing.current++;
    busyRef.current = false;
    setBusy(false);
    setSession(null);
    setHistory(null);
    setError("");
    setNotice("");
    setLogin(null);
    setEditing(null);
    setDetails(null);
    setCancelling(null);
    setOffset(0);
    const controller = new AbortController();
    void triggerRequest<TriggerSession>(
      "session",
      undefined,
      undefined,
      controller.signal,
    )
      .then(async (next) => {
        if (generation.current !== id) return;
        // A cookie never grants UI access to another connected account.
        if (next.address && next.address !== address) {
          await triggerRequest("logout", {}, undefined, controller.signal);
          next = { configured: next.configured, address: null };
        }
        if (generation.current === id) setSession(next);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Could not check the Jupiter connection. Try again.");
      });
    return () => {
      generation.current++;
      signing.current++;
      authRequest.current?.abort();
      controller.abort();
    };
  }, [identity, revision]);

  useEffect(() => {
    if (!ready || !session?.expiresAt) return;
    const timeout = setTimeout(
      () => {
        setSession((current) =>
          current ? { configured: current.configured, address: null } : null,
        );
        setHistory(null);
        setEditing(null);
        setError("Jupiter authorization expired. Sign in again.");
      },
      Math.max(0, session.expiresAt - Date.now()),
    );
    return () => clearTimeout(timeout);
  }, [ready, session?.expiresAt]);

  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!ready || !address) {
      setHistory(null);
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    setHistory(null);
    async function read() {
      if (
        running ||
        controller.signal.aborted ||
        document.hidden ||
        !navigator.onLine
      )
        return;
      if (Date.now() < retryAt.current) {
        timer = setTimeout(read, retryAt.current - Date.now());
        return;
      }
      running = true;
      setLoading(true);
      try {
        const next = await triggerRequest<LiveHistory>(
          "history",
          { wallet: address, state, offset },
          session!.csrf,
          controller.signal,
        );
        if (
          next.address !== address ||
          next.offset !== offset ||
          !Array.isArray(next.orders)
        )
          throw new Error();
        if (!controller.signal.aborted) {
          setHistory(next);
          setError("");
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          handleError(error);
          if (error instanceof TriggerError && error.status === 429)
            retryAt.current = Date.now() + error.retryAfter * 1000;
        }
      } finally {
        running = false;
        if (!controller.signal.aborted) {
          setLoading(false);
          timer = setTimeout(
            read,
            Math.max(10000, retryAt.current - Date.now()),
          );
        }
      }
    }
    const wake = () => {
      clearTimeout(timer);
      void read();
    };
    void read();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
    };
  }, [ready, address, session?.csrf, state, offset, refresh]);

  function handleError(error: unknown) {
    if (
      error instanceof TriggerError &&
      error.code === "authorization_required"
    ) {
      setSession((current) =>
        current ? { configured: current.configured, address: null } : null,
      );
      setHistory(null);
      setEditing(null);
    }
    setError(
      error instanceof Error ? error.message : "The request failed. Try again.",
    );
  }
  async function startLogin() {
    if (!address || busyRef.current) return;
    const id = generation.current;
    authRequest.current?.abort();
    const controller = new AbortController();
    authRequest.current = controller;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await triggerRequest<Login>(
        "challenge",
        { wallet: address },
        undefined,
        controller.signal,
      );
      if (generation.current !== id) return;
      if (
        next.wallet !== address ||
        !validChallenge(next.message, address) ||
        next.expiresAt <= Date.now()
      )
        throw new Error("The sign-in message could not be verified.");
      setLogin(next);
    } catch (error) {
      if (generation.current === id) handleError(error);
    } finally {
      if (generation.current === id) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  function closeLogin() {
    authRequest.current?.abort();
    signing.current++;
    setLogin(null);
    busyRef.current = false;
    setBusy(false);
  }
  async function authorize() {
    if (!login || !address || busyRef.current) return;
    const id = generation.current,
      attempt = ++signing.current;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      if (login.wallet !== address || login.expiresAt <= Date.now())
        throw new Error("This message expired. Close it and start again.");
      const signature = await connection.signTriggerChallenge(
        login.message,
        address,
      );
      if (generation.current !== id || signing.current !== attempt) return;
      const next = await triggerRequest<TriggerSession>(
        "verify",
        { wallet: address, signature },
        undefined,
        authRequest.current?.signal,
      );
      if (generation.current !== id || signing.current !== attempt) return;
      if (next.address !== address || !next.csrf || !next.expiresAt)
        throw new Error("The authorized account did not match.");
      setSession(next);
      setLogin(null);
    } catch (error) {
      if (generation.current === id && signing.current === attempt)
        handleError(error);
    } finally {
      if (generation.current === id && signing.current === attempt) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  async function logout() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await triggerRequest("logout");
      setRevision((n) => n + 1);
    } catch (error) {
      handleError(error);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  const currentHistory = history?.address === address && ready ? history : null;
  return (
    <section className="live-orders" aria-label="Connected order management">
      <div className="live-heading">
        <div>
          <h2>Existing Jupiter orders.</h2>
          <p>Manage orders you placed through Jupiter. This optional connection uses a separate vault and does not activate Fub’s direct wallet exits.</p>
        </div>
        {ready && (
          <button
            className="word-link"
            disabled={busy}
            onClick={() => void logout()}
          >
            End order session
          </button>
        )}
      </div>
      <details className="order-connection-details">
        <summary>How order execution works</summary>
        <p>Jupiter supplies this live price-order connection. You sign with your connected wallet, including an imported Fomo wallet. Its orders use a separate Jupiter vault, so your Fomo balance is not automatically available to them.</p>
        <p>These existing provider orders keep their own authorization and funding. Manage same-wallet limit orders in Orders.</p>
      </details>
      {intent && (
        <aside className="order-intent" aria-label="Selected holding for order">
          <div>
            <b>Order draft: {intent.symbol || shortAddress(intent.mint)}</b>
            <p>
              {intent.amount} tokens from {shortAddress(intent.wallet)}
            </p>
            <p className="wallet-address">{intent.mint}</p>
            <p className="muted">
              {address && address !== intent.wallet
                ? "Switch to the source wallet to use this draft."
                : "The associated token-account balance will be checked again before review. No order has been placed."}
            </p>
          </div>
          <button className="word-link" onClick={clearIntent}>
            Discard selected holding
          </button>
        </aside>
      )}
      {!ready && (
        <div className="live-connect">
          <h3>
            {session?.configured === false
              ? "Order connection unavailable."
              : address
                ? "View your Jupiter orders."
                : "Connect wallet to view Jupiter orders."}
          </h3>
          <p>
            {session?.configured === false
              ? "The live order connection is not available yet. New orders and trading remain unavailable."
              : "Sign a wallet ownership message to load orders and authorize order changes. It does not move funds or enable Fub’s automatic copy trading."}
          </p>
          <p className="muted">
            Use the same Solana address you hold in Fomo through Fub’s wallet
            setup. An existing compatible Solana wallet also works.
          </p>
          {!address ? (
            <button className="button primary" onClick={onConnect}>
              Connect wallet
            </button>
          ) : session?.configured ? (
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void startLogin()}
            >
              {busy ? "Requesting message…" : "Review wallet sign-in"}
            </button>
          ) : null}
          {!session && (
            <button
              className="word-link"
              onClick={() => setRevision((n) => n + 1)}
            >
              Check connection
            </button>
          )}
        </div>
      )}
      {ready && (
        <>
          <div className="live-account">
            <span>Authorized wallet</span>
            <a
              className="word-link"
              href={`https://solscan.io/account/${address}`}
              target="_blank"
              rel="noreferrer"
            >
              {shortAddress(address!)} <ArrowUpRight size={13} />
            </a>
          </div>
          <div className="section-toolbar">
            <div className="filter-tabs" aria-label="Live order filter">
              {(["active", "past"] as const).map((value) => (
                <button
                  key={value}
                  className={state === value ? "selected" : ""}
                  aria-pressed={state === value}
                  onClick={() => {
                    setState(value);
                    setOffset(0);
                  }}
                >
                  {value === "active" ? "Active" : "Past"}
                </button>
              ))}
            </div>
            <button
              className="word-link"
              disabled={loading}
              onClick={() => setRefresh((n) => n + 1)}
            >
              <RefreshCw size={14} /> Refresh orders
            </button>
          </div>
          {loading && !currentHistory && (
            <p role="status">Reading your orders…</p>
          )}
          {currentHistory?.orders.length === 0 && (
            <div className="live-empty">
              No {state} Jupiter price orders found for this wallet.
            </div>
          )}
          {currentHistory &&
            currentHistory.orders.map((order) => (
              <article className="live-order" key={order.id}>
                <div className="live-order-top">
                  <div>
                    <h3>
                      {label(order.inputMint)} <span>→</span>{" "}
                      {label(order.outputMint)}
                    </h3>
                    <p>
                      {order.orderType === "oco"
                        ? "Paired exits"
                        : order.orderType === "otoco"
                          ? "Entry with exits"
                          : order.trailingBps
                            ? "Trailing stop"
                            : "Limit order"}
                    </p>
                  </div>
                  <span className="live-order-state">
                    {stateLabel(order.orderState)}
                  </span>
                </div>
                <dl className="live-order-values">
                  {order.orderType === "oco" ? (
                    <>
                      <div>
                        <dt>Target</dt>
                        <dd>{price(order.tpPriceUsd)}</dd>
                      </div>
                      <div>
                        <dt>Stop</dt>
                        <dd>{price(order.slPriceUsd)}</dd>
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <dt>
                          {order.trailingBps
                            ? "Current trigger"
                            : `Trigger ${order.triggerCondition || "price"}`}
                        </dt>
                        <dd>{price(order.triggerPriceUsd)}</dd>
                      </div>
                      <div>
                        <dt>
                          {order.trailingBps ? "Trail" : "Slippage limit"}
                        </dt>
                        <dd>
                          {order.trailingBps
                            ? `${order.trailingBps / 100}%`
                            : order.slippageBps === undefined
                              ? "Not provided"
                              : `${order.slippageBps / 100}%`}
                        </dd>
                      </div>
                    </>
                  )}
                  <div>
                    <dt>Expires</dt>
                    <dd>{new Date(order.expiresAt).toLocaleString()}</dd>
                  </div>
                </dl>
                {["expired", "pending_withdraw"].includes(order.orderState) && (
                  <p className="live-funds-note">
                    Unspent funds may still be in your Jupiter vault. Complete
                    the withdrawal in Jupiter.
                  </p>
                )}
                <div className="live-order-actions">
                  <button
                    className="word-link"
                    onClick={() => setDetails(order)}
                  >
                    Details and transactions
                  </button>
                  {canAmend(order) && (
                    <button
                      className="word-link"
                      disabled={!!error || loading}
                      onClick={() => {
                        setNotice("");
                        setEditing(order);
                      }}
                    >
                      Edit levels
                    </button>
                  )}
                  {session?.funding &&
                    ["open", "expired", "pending_withdraw"].includes(
                      order.orderState,
                    ) && (
                      <button
                        className="word-link"
                        disabled={!!error || loading}
                        onClick={() => setCancelling(order)}
                      >
                        Cancel and withdraw
                      </button>
                    )}
                  <a
                    className="word-link"
                    href="https://jup.ag/limit"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Manage in Jupiter <ArrowUpRight size={13} />
                  </a>
                </div>
              </article>
            ))}
          {currentHistory && (
            <div className="live-pagination">
              <button
                className="word-link"
                disabled={offset === 0 || loading}
                onClick={() => setOffset((n) => Math.max(0, n - 20))}
              >
                Previous
              </button>
              <span>Page {offset / 20 + 1}</span>
              <button
                className="word-link"
                disabled={
                  offset + 20 >= currentHistory.total ||
                  loading ||
                  offset >= 10000
                }
                onClick={() => setOffset((n) => n + 20)}
              >
                Next
              </button>
            </div>
          )}
          <FundingPanel
            intent={intent?.wallet === address ? intent : null}
            clearIntent={clearIntent}
            key={address}
            connection={connection}
            wallet={address!}
            csrf={session!.csrf!}
            enabled={session?.funding === true}
            recoveryEnabled={
              session?.recovery === true || session?.funding === true
            }
            cancelOrder={cancelling}
            clearCancel={() => setCancelling(null)}
            changed={() => setRefresh((value) => value + 1)}
          />
          <p className="live-footnote">
            Existing Jupiter orders can continue executing after you close this
            page. A stopped or expired order can still hold funds in its vault
            until withdrawal completes.
          </p>
        </>
      )}
      {notice && (
        <p className="wallet-notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {login && (
        <Modal
          title="Review wallet sign-in"
          close={closeLogin}
          description="This signature authorizes order access for up to 24 hours. It does not transfer tokens."
        >
          <p className="live-funds-note">
            The session can read orders, change price levels and slippage, and
            initiate cancellation without another wallet signature. Deposits and
            withdrawals need separate transaction signatures.
          </p>
          <p className="wallet-address">{login.wallet}</p>
          <pre className="login-message">{login.message}</pre>
          <p className="muted">
            Expires {new Date(login.expiresAt).toLocaleTimeString()}. Read the
            same message in your wallet before approving.
          </p>
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          <button
            className="button primary full"
            disabled={busy}
            onClick={() => void authorize()}
          >
            {busy ? "Check your wallet…" : "Sign this login message"}
          </button>
        </Modal>
      )}
      {editing && ready && (
        <AmendOrder
          key={editing.id}
          order={editing}
          address={address!}
          csrf={session!.csrf!}
          close={() => setEditing(null)}
          saved={() => {
            setEditing(null);
            setNotice(
              "Jupiter accepted the change. Refreshing the confirmed order details.",
            );
            setRefresh((n) => n + 1);
          }}
          onAuthError={handleError}
        />
      )}
      {details && (
        <Modal title="Order details" close={() => setDetails(null)}>
          <dl className="live-details">
            <dt>Order ID</dt>
            <dd>{details.id}</dd>
            <dt>Input contract</dt>
            <dd>{details.inputMint}</dd>
            <dt>Output contract</dt>
            <dd>{details.outputMint}</dd>
            <dt>Deposited amount in base units</dt>
            <dd>{details.initialInputAmount}</dd>
            <dt>Unfilled amount in base units</dt>
            <dd>{details.remainingInputAmount}</dd>
            <dt>Provider state</dt>
            <dd>{details.rawState}</dd>
          </dl>
          <p className="muted">
            Amounts use the token's smallest units. Unfilled amount is not a
            confirmed withdrawable balance.
          </p>
          <h3>Recent order events</h3>
          {details.events.length ? (
            <ul className="live-events">
              {details.events.map((event, index) => (
                <li key={index}>
                  <div>
                    <b>
                      {stateLabel(event.type)} · {stateLabel(event.state)}
                    </b>
                    <small>{new Date(event.timestamp).toLocaleString()}</small>
                  </div>
                  {event.txSignature && (
                    <a
                      className="word-link"
                      href={`https://solscan.io/tx/${event.txSignature}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Transaction <ArrowUpRight size={12} />
                    </a>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No events returned by Jupiter.</p>
          )}
        </Modal>
      )}
    </section>
  );
}

function AmendOrder({
  order,
  address,
  csrf,
  close,
  saved,
  onAuthError,
}: {
  order: LiveOrder;
  address: string;
  csrf: string;
  close: () => void;
  saved: () => void;
  onAuthError: (error: unknown) => void;
}) {
  const [target, setTarget] = useState(
    String(order.tpPriceUsd ?? order.triggerPriceUsd ?? ""),
  );
  const [stop, setStop] = useState(String(order.slPriceUsd ?? ""));
  const [trail, setTrail] = useState(String((order.trailingBps || 0) / 100));
  const [slippage, setSlippage] = useState(
    order.slippageBps === undefined && order.tpSlippageBps === undefined
      ? ""
      : String((order.slippageBps ?? order.tpSlippageBps!) / 100),
  );
  const [stopSlippage, setStopSlippage] = useState(
    order.slSlippageBps === undefined ? "" : String(order.slSlippageBps / 100),
  );
  const [review, setReview] = useState<Amendment | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function prepare() {
    try {
      const changes =
        order.orderType === "oco"
          ? {
              orderType: "oco",
              tpPriceUsd: Number(target),
              slPriceUsd: Number(stop),
              tpSlippageBps: decimalBps(slippage),
              slSlippageBps: decimalBps(stopSlippage),
            }
          : {
              orderType: "single",
              ...(order.trailingBps
                ? { trailingBps: decimalBps(trail) }
                : { triggerPriceUsd: Number(target) }),
              slippageBps: decimalBps(slippage),
            };
      setReview(parseAmendment(changes));
      setError("");
    } catch {
      setError(
        "Check positive prices, a target above the stop, and slippage from 0.10% to 5%. Trailing distance must be 0.50% to 90%.",
      );
    }
  }
  async function apply() {
    if (!review || locked.current || uncertain) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await triggerRequest(
        "amend",
        { wallet: address, id: order.id, changes: review },
        csrf,
      );
      if (mounted.current) saved();
    } catch (error) {
      if (!mounted.current) return;
      if (
        error instanceof TriggerError &&
        error.code === "authorization_required"
      ) {
        onAuthError(error);
        return;
      }
      const unknown =
        !(error instanceof TriggerError) ||
        error.code === "provider_unknown" ||
        error.status >= 500;
      setUncertain(unknown);
      if (unknown)
        onAuthError(
          new Error(
            "Refresh orders to check the last change before editing again.",
          ),
        );
      setError(
        unknown
          ? "The result is unknown. Close this dialog and refresh orders before making another change."
          : error.message,
      );
    } finally {
      if (mounted.current) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <Modal
      title={review ? "Confirm live order change" : "Edit live order"}
      close={() => {
        if (!busy) close();
      }}
      description={`${label(order.inputMint)} to ${label(order.outputMint)}. This changes a real Jupiter order.`}
    >
      {!review ? (
        <div className="live-edit-fields">
          {order.trailingBps ? (
            <label className="field">
              <span>Trailing distance (%)</span>
              <input
                aria-label="Trailing distance (%)"
                inputMode="decimal"
                value={trail}
                onChange={(e) => setTrail(e.target.value)}
              />
            </label>
          ) : (
            <label className="field">
              <span>
                {order.orderType === "oco"
                  ? "Take-profit price (USD)"
                  : "Trigger price (USD)"}
              </span>
              <input
                aria-label="Trigger price (USD)"
                inputMode="decimal"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              />
            </label>
          )}
          {order.orderType === "oco" && (
            <label className="field">
              <span>Stop-loss price (USD)</span>
              <input
                aria-label="Stop-loss price (USD)"
                inputMode="decimal"
                value={stop}
                onChange={(e) => setStop(e.target.value)}
              />
            </label>
          )}
          <label className="field">
            <span>
              {order.orderType === "oco"
                ? "Take-profit slippage (%)"
                : "Slippage limit (%)"}
            </span>
            <input
              aria-label="Slippage limit (%)"
              inputMode="decimal"
              value={slippage}
              onChange={(e) => setSlippage(e.target.value)}
            />
          </label>
          {order.orderType === "oco" && (
            <label className="field">
              <span>Stop-loss slippage (%)</span>
              <input
                aria-label="Stop-loss slippage (%)"
                inputMode="decimal"
                value={stopSlippage}
                onChange={(e) => setStopSlippage(e.target.value)}
              />
            </label>
          )}
          <button className="button primary full" onClick={prepare}>
            Review change
          </button>
        </div>
      ) : (
        <>
          <dl className="live-details">
            <dt>Wallet</dt>
            <dd>{address}</dd>
            <dt>Order</dt>
            <dd>{order.id}</dd>
            {Object.entries(review)
              .filter(([key]) => key !== "orderType")
              .map(([key, value]) => {
                const labels: Record<string, string> = {
                  triggerPriceUsd: "Trigger price",
                  tpPriceUsd: "Take-profit price",
                  slPriceUsd: "Stop-loss price",
                  trailingBps: "Trailing distance",
                  slippageBps: "Slippage",
                  tpSlippageBps: "Take-profit slippage",
                  slSlippageBps: "Stop-loss slippage",
                };
                const format = (v: unknown) =>
                  typeof v !== "number"
                    ? "Not provided"
                    : key.endsWith("Bps")
                      ? `${v / 100}%`
                      : price(v);
                return (
                  <div key={key}>
                    <dt>{labels[key]}</dt>
                    <dd>
                      {format(order[key as keyof LiveOrder])} → {format(value)}
                    </dd>
                  </div>
                );
              })}
          </dl>
          <p className="live-funds-note">
            This applies immediately using your Jupiter session. Moving a
            trigger across the market price may cause the order to execute. Your
            wallet will not ask for another signature.
          </p>
          <div className="live-order-actions">
            <button
              className="word-link"
              disabled={busy || uncertain}
              onClick={() => setReview(null)}
            >
              Back to edit
            </button>
            <button
              className="button primary"
              disabled={busy || uncertain}
              onClick={() => void apply()}
            >
              {busy ? "Applying…" : "Apply to live order"}
            </button>
          </div>
        </>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
