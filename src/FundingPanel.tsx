import { useEffect, useRef, useState } from "react";
import type { WalletConnection } from "./useWallet";
import type { LiveOrder } from "./live-orders";
import { decimalBps } from "./live-orders";
import {
  displayUnits,
  parsePlan,
  units,
  USDC,
  unresolved,
} from "./funding-model";
import type { FundingOperation, OrderPlan } from "./funding-model";
import { triggerRequest } from "./trigger-api";
import { Modal } from "./ui";
import { FundingTimeline } from "./FundingTimeline";
import { TokenSearch } from "./TokenSearch";
import { loadLiveDraft, saveLiveDraft, percentAmount } from "./order-draft";
import type { OrderIntent } from "./order-draft";
import type { FundingBalance } from "./funding-balance";
import { validateFundingBalance } from "./funding-balance";
import { isMint, shortAddress } from "./assets";

export function FundingPanel({
  connection,
  wallet,
  csrf,
  enabled,
  recoveryEnabled = enabled,
  cancelOrder,
  clearCancel,
  changed,
  intent,
  clearIntent,
}: {
  connection: WalletConnection;
  wallet: string;
  csrf: string;
  enabled: boolean;
  recoveryEnabled?: boolean;
  cancelOrder: LiveOrder | null;
  clearCancel: () => void;
  changed: () => void;
  intent?: OrderIntent | null;
  clearIntent?: () => void;
}) {
  const [operations, setOperations] = useState<FundingOperation[]>([]);
  const [selected, setSelected] = useState<FundingOperation | null>(null);
  const [composer, setComposer] = useState(false);
  const [plan, setPlan] = useState<OrderPlan | null>(null);
  const [loaded] = useState(() => loadLiveDraft(wallet));
  const [draft, setDraft] = useState(loaded.draft);
  const { kind, side, mint, amount, target, stop, trail, slippage, expiry } =
    draft;
  function field(key: keyof typeof draft, value: string) {
    setDraft((current) => ({ ...current, [key]: value }));
  }
  const [draftWarning, setDraftWarning] = useState(loaded.warning);
  const [balance, setBalance] = useState<FundingBalance | null>(null);
  const [searching, setSearching] = useState(false);
  const appliedIntent = useRef<string | null>(null);
  const skipDraftSave = useRef(false);
  useEffect(() => {
    if (
      !intent ||
      intent.wallet !== wallet ||
      appliedIntent.current === intent.id
    )
      return;
    const next = {
      ...draft,
      kind: "oco",
      side: "sell",
      mint: intent.mint,
      amount: intent.amount,
      target: "",
      stop: "",
    };
    skipDraftSave.current = true;
    setDraft(next);
    setBalance(null);
    setPlan(null);
    setComposer(true);
    appliedIntent.current = intent.id;
    try {
      saveLiveDraft(wallet, next);
      clearIntent?.();
      setDraftWarning("");
    } catch {
      setDraftWarning(
        "This draft could not be saved on this device. Keep this page open to retain your changes.",
      );
    }
  }, [intent?.id, wallet]);
  useEffect(() => {
    if (skipDraftSave.current) {
      skipDraftSave.current = false;
      return;
    }
    try {
      saveLiveDraft(wallet, draft);
      setDraftWarning("");
    } catch {
      setDraftWarning(
        "This draft could not be saved on this device. Keep this page open to retain your changes.",
      );
    }
  }, [draft, wallet, intent?.id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [recordsLoaded, setRecordsLoaded] = useState(false);
  const locked = useRef(false),
    generation = useRef(0);
  const alive = useRef(true);
  const recordRevision = useRef(0);
  const refreshSequence = useRef(0);
  const refreshing = useRef(false);
  const requestId = useRef(crypto.randomUUID());
  const hasPending = operations.some(unresolved);
  useEffect(() => {
    if (cancelOrder) requestId.current = crypto.randomUUID();
  }, [cancelOrder?.id]);
  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []);
  async function refresh() {
    const revision = recordRevision.current;
    const sequence = ++refreshSequence.current;
    try {
      const reply = await triggerRequest<{ operations: FundingOperation[] }>(
        "funding-list",
        { wallet },
        csrf,
      );
      if (
        !Array.isArray(reply.operations) ||
        reply.operations.some((operation) => operation.wallet !== wallet)
      )
        throw new Error();
      if (
        alive.current &&
        sequence === refreshSequence.current &&
        revision === recordRevision.current
      ) {
        setOperations(reply.operations);
        setSelected((current) =>
          current
            ? reply.operations.find(
                (operation) => operation.id === current.id,
              ) || current
            : null,
        );
        setStorageError("");
        setRecordsLoaded(true);
      }
    } catch {
      if (
        alive.current &&
        sequence === refreshSequence.current &&
        revision === recordRevision.current
      )
        setStorageError(
          "Could not load recovery records. Refresh them before creating or changing a funding request.",
        );
    }
  }
  const pendingId = operations.find((operation) =>
    ["submitting", "submitted", "unknown", "preparing"].includes(
      operation.state,
    ),
  )?.id;
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function update() {
      if (
        stopped ||
        document.hidden ||
        !navigator.onLine ||
        locked.current ||
        refreshing.current
      )
        return;
      refreshing.current = true;
      try {
        if (recoveryEnabled && pendingId) {
          await triggerRequest<FundingOperation>(
            "funding-reconcile",
            { wallet, id: pendingId },
            csrf,
          );
          if (!stopped) changed();
        }
        if (!stopped) await refresh();
      } catch {
        // Keep the persisted request and manual recovery action on transient failures.
      } finally {
        refreshing.current = false;
      }
    }
    async function tick() {
      await update();
      if (!stopped && pendingId) timer = setTimeout(tick, 10000);
    }
    const wake = () => {
      void update();
    };
    if (pendingId) timer = setTimeout(tick, 3000);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [wallet, csrf, recoveryEnabled, pendingId]);
  function remember(operation: FundingOperation) {
    if (!alive.current) return;
    recordRevision.current++;
    setOperations((current) =>
      [operation, ...current.filter((item) => item.id !== operation.id)].slice(
        0,
        30,
      ),
    );
    setSelected(operation);
  }
  async function run(action: () => Promise<void>) {
    if (locked.current) return;
    const attempt = ++generation.current;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      if (alive.current && generation.current === attempt) {
        setError(
          error instanceof Error
            ? error.message
            : "The request failed. Check recovery before retrying.",
        );
        await refresh();
      }
    } finally {
      if (generation.current === attempt) {
        locked.current = false;
        if (alive.current) setBusy(false);
      }
    }
  }
  async function checkBalance() {
    const inputMint = side === "buy" ? USDC : mint.trim();
    if (!isMint(inputMint))
      throw new Error("Choose a token before checking its balance.");
    const reply = await triggerRequest<FundingBalance>(
      "funding-balance",
      { wallet, mint: inputMint },
      csrf,
    );
    validateFundingBalance(reply, wallet, inputMint);
    if (alive.current) setBalance(reply);
    return reply;
  }
  async function sizeAmount(percent: number) {
    const current = await checkBalance();
    if (!alive.current) return;
    if (current.frozen)
      throw new Error("This token account is frozen and cannot fund an order.");
    field(
      "amount",
      percentAmount(current.rawAmount, current.decimals, percent),
    );
  }
  async function reviewPlan() {
    if (!isMint(mint.trim()) || mint.trim() === USDC)
      throw new Error("Paste the memecoin's exact Solana contract.");
    const token = mint.trim(),
      inputMint = side === "buy" ? USDC : token,
      outputMint = side === "buy" ? token : USDC;
    const info = await checkBalance();
    if (!alive.current) return;
    if (info.frozen)
      throw new Error("This token account is frozen and cannot fund an order.");
    const inputAmount = units(amount, info.decimals);
    if (BigInt(inputAmount) > BigInt(info.rawAmount))
      throw new Error(
        "This amount exceeds the current funding-account balance. Choose a smaller amount or use Max.",
      );
    const common = {
      inputMint,
      outputMint,
      inputAmount,
      triggerMint: token,
      expiresAt: Date.now() + Number(expiry) * 86400000,
    };
    const bps = decimalBps(slippage);
    const next =
      kind === "oco"
        ? {
            ...common,
            orderType: "oco",
            tpPriceUsd: Number(target),
            slPriceUsd: Number(stop),
            tpSlippageBps: bps,
            slSlippageBps: bps,
          }
        : {
            ...common,
            orderType: "single",
            triggerCondition:
              kind === "trailing" || side === "buy" ? "below" : "above",
            ...(kind === "trailing"
              ? { trailingBps: decimalBps(trail) }
              : { triggerPriceUsd: Number(target) }),
            slippageBps: bps,
          };
    setPlan(parsePlan(next));
    requestId.current = crypto.randomUUID();
  }
  async function prepare(kind: "create" | "cancel") {
    if (!enabled)
      throw new Error("Funding is waiting for its execution connection.");
    const payload =
      kind === "create"
        ? { wallet, id: requestId.current, kind, plan }
        : { wallet, id: requestId.current, kind, orderId: cancelOrder?.id };
    const operation = await triggerRequest<FundingOperation>(
      "funding-prepare",
      payload,
      csrf,
    );
    if (!alive.current) return;
    remember(operation);
    setComposer(false);
    setPlan(null);
    clearCancel();
    if (kind === "create") clearIntent?.();
    changed();
  }
  async function signAndSubmit() {
    if (
      !selected?.transaction ||
      !selected.review ||
      (selected.expiresAt || 0) <= Date.now()
    )
      throw new Error(
        "The transaction review expired. Use the recovery actions below.",
      );
    const current = selected,
      revision = generation.current;
    const signed = await connection.signFundingTransaction(
      current.transaction!,
      current.review!,
    );
    if (!alive.current || generation.current !== revision) return;
    // No automatic retries and no localStorage of a signed transaction.
    try {
      const result = await triggerRequest<FundingOperation>(
        "funding-submit",
        { wallet, id: current.id, signedTransaction: signed },
        csrf,
      );
      if (!alive.current || generation.current !== revision) {
        await refresh();
        return;
      }
      remember(result);
      changed();
    } catch {
      if (!alive.current || generation.current !== revision) return;
      setError(
        "Submission could not be confirmed. Do not send again. Refresh recovery to check the server record.",
      );
      setSelected(null);
      await refresh();
    }
  }
  async function reconcile(id: string) {
    remember(
      await triggerRequest<FundingOperation>(
        "funding-reconcile",
        { wallet, id },
        csrf,
      ),
    );
    changed();
  }
  const costs = selected?.review;
  return (
    <section className="funding-panel" aria-label="Order funding and recovery">
      <div className="section-toolbar">
        <button
          className="button primary compact"
          disabled={hasPending || busy || !!storageError || !recordsLoaded}
          onClick={() => {
            setComposer(true);
            setPlan(null);
            setError("");
          }}
        >
          New live order
        </button>
        <button
          className="word-link"
          disabled={busy}
          onClick={() => void run(refresh)}
        >
          Refresh recovery
        </button>
      </div>
      {!enabled && (
        <p className="muted">
          Funding is waiting for its execution connection. Existing orders can
          still be managed above.
        </p>
      )}
      {draftWarning && (
        <p className="error-message" role="alert">
          {draftWarning}
        </p>
      )}
      {storageError && (
        <p className="error-message" role="alert">
          {storageError}
        </p>
      )}
      {hasPending && (
        <p className="live-funds-note">
          Resolve the pending funding request below before creating another.
          This prevents duplicate deposits.
        </p>
      )}
      {operations.length > 0 && (
        <div className="funding-history">
          <h3>Funding and recovery</h3>
          {operations.map((operation) => (
            <div className="funding-record" key={operation.id}>
              <div>
                <b>
                  {operation.kind === "create"
                    ? "Order deposit"
                    : "Order withdrawal"}
                </b>
                <span>
                  {operation.state === "prepared"
                    ? "Awaiting your signature"
                    : operation.state.replaceAll("_", " ")}
                </span>
                <small>{new Date(operation.createdAt).toLocaleString()}</small>
              </div>
              <button
                className="word-link"
                disabled={busy}
                onClick={() => {
                  setSelected(operation);
                  setError("");
                }}
              >
                Review request
              </button>
            </div>
          ))}
        </div>
      )}
      {error && !selected && !composer && !cancelOrder && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {searching && (
        <TokenSearch
          close={() => setSearching(false)}
          select={(token) => {
            setDraft((current) => ({
              ...current,
              mint: token.address,
              amount: "",
              target: "",
              stop: "",
            }));
            setBalance(null);
            setSearching(false);
          }}
        />
      )}
      {composer && !searching && (
        <Modal
          title={plan ? "Review live order" : "New live order"}
          close={() => {
            if (!busy) {
              setComposer(false);
              setPlan(null);
            }
          }}
          description="Standard Solana SPL tokens paired with USDC. Each order needs at least $10 of funding."
        >
          {draftWarning && (
            <p className="error-message" role="alert">
              {draftWarning}
            </p>
          )}
          {plan ? (
            <>
              <p>
                You will deposit {amount} {side === "buy" ? "USDC" : "tokens"}.
              </p>
              <PlanReview plan={plan} />
              <p className="live-funds-note">
                Funding moves tokens into a separate Jupiter vault managed by
                Privy. Jupiter holds them until execution or a signed
                withdrawal. This does not use your Fomo wallet. Execution fees
                and slippage affect the amount received. A stop cannot guarantee
                an exit price.
              </p>
              {!enabled && (
                <p className="muted">
                  This is an unsigned draft. Funding is not available yet; no
                  order has been placed.
                </p>
              )}
              <div className="live-order-actions">
                <button
                  className="word-link"
                  disabled={busy}
                  onClick={() => setPlan(null)}
                >
                  Edit order
                </button>
                <button
                  className="button primary"
                  disabled={
                    busy ||
                    !enabled ||
                    hasPending ||
                    !!storageError ||
                    !recordsLoaded
                  }
                  onClick={() => void run(() => prepare("create"))}
                >
                  {busy ? "Checking deposit…" : "Prepare deposit"}
                </button>
              </div>
            </>
          ) : (
            <fieldset
              className="live-edit-fields funding-fields"
              disabled={busy}
            >
              <label className="field">
                <span>Order type</span>
                <select
                  aria-label="Live order type"
                  value={kind}
                  onChange={(event) => {
                    field("kind", event.target.value);
                    if (event.target.value !== "limit" && side !== "sell") {
                      field("side", "sell");
                      field("amount", "");
                      setBalance(null);
                    }
                  }}
                >
                  <option value="oco">Paired exits</option>
                  <option value="limit">Limit order</option>
                  <option value="trailing">Trailing stop</option>
                </select>
              </label>
              {kind === "limit" && (
                <label className="field">
                  <span>Side</span>
                  <select
                    aria-label="Live order side"
                    value={side}
                    onChange={(event) => {
                      field("side", event.target.value);
                      field("amount", "");
                      setBalance(null);
                    }}
                  >
                    <option value="sell">Sell token for USDC</option>
                    <option value="buy">Buy token with USDC</option>
                  </select>
                </label>
              )}
              <div className="field">
                <label htmlFor="live-token-mint">Token contract</label>
                <button
                  type="button"
                  className="word-link"
                  onClick={() => setSearching(true)}
                >
                  Find token
                </button>
                <input
                  id="live-token-mint"
                  aria-label="Live token contract"
                  value={mint}
                  onChange={(event) => {
                    field("mint", event.target.value);
                    field("amount", "");
                    setBalance(null);
                  }}
                  placeholder="Paste a Solana mint"
                  spellCheck={false}
                />
              </div>
              <label className="field">
                <span>
                  {side === "buy" ? "USDC to spend" : "Tokens to sell"}
                </span>
                <input
                  aria-label="Live funding amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => field("amount", event.target.value)}
                />
              </label>
              <div className="funding-sizing">
                <button
                  className="word-link"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await checkBalance();
                    })
                  }
                >
                  Check balance
                </button>
                <div className="amount-presets">
                  {[25, 50, 75, 100].map((percent) => (
                    <button
                      type="button"
                      key={percent}
                      disabled={busy}
                      onClick={() => void run(() => sizeAmount(percent))}
                    >
                      {percent === 100 ? "Max" : `${percent}%`}
                    </button>
                  ))}
                </div>
                {balance && (
                  <p className="muted">
                    {balance.frozen
                      ? "Frozen account"
                      : `${displayUnits(balance.rawAmount, balance.decimals)} available`}{" "}
                    · {side === "buy" ? "USDC" : "tokens"}
                    <br />
                    Funding account {shortAddress(balance.source)}. Other token
                    accounts are not included. Checked{" "}
                    {new Date(balance.fetchedAt).toLocaleTimeString()}.
                  </p>
                )}
              </div>
              {kind !== "trailing" ? (
                <label className="field">
                  <span>
                    {kind === "oco"
                      ? "Take-profit price (USD)"
                      : "Trigger price (USD)"}
                  </span>
                  <input
                    aria-label="Live target price"
                    inputMode="decimal"
                    value={target}
                    onChange={(event) => field("target", event.target.value)}
                  />
                </label>
              ) : (
                <label className="field">
                  <span>Trailing distance (%)</span>
                  <input
                    aria-label="Live trailing distance"
                    inputMode="decimal"
                    value={trail}
                    onChange={(event) => field("trail", event.target.value)}
                  />
                </label>
              )}
              {kind === "oco" && (
                <label className="field">
                  <span>Stop-loss price (USD)</span>
                  <input
                    aria-label="Live stop price"
                    inputMode="decimal"
                    value={stop}
                    onChange={(event) => field("stop", event.target.value)}
                  />
                </label>
              )}
              <label className="field">
                <span>Slippage limit (%)</span>
                <input
                  aria-label="Live slippage limit"
                  inputMode="decimal"
                  value={slippage}
                  onChange={(event) => field("slippage", event.target.value)}
                />
              </label>
              <label className="field">
                <span>Expires after</span>
                <select
                  aria-label="Live order expiry"
                  value={expiry}
                  onChange={(event) => field("expiry", event.target.value)}
                >
                  <option value="1">1 day</option>
                  <option value="7">7 days</option>
                  <option value="30">30 days</option>
                </select>
              </label>
              <p className="muted">
                Keep SOL in your wallet for fees. Native SOL, wrapped SOL and
                Token 2022 funding are not supported here yet.
              </p>
              <button
                className="button primary full"
                disabled={busy}
                onClick={() => void run(reviewPlan)}
              >
                {busy ? "Checking token…" : "Review live order"}
              </button>
            </fieldset>
          )}
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
        </Modal>
      )}
      {cancelOrder && (
        <Modal
          title="Cancel and withdraw"
          close={() => {
            if (!busy) clearCancel();
          }}
        >
          <p>
            Preparing a withdrawal immediately asks Jupiter to stop this order.
            Returning the tokens takes a separate wallet signature.
          </p>
          <p className="wallet-address">{cancelOrder.id}</p>
          <p className="live-funds-note">
            If you close the page or decline the signature, funds can remain in
            the vault. The recovery record stays available after you sign in
            again.
          </p>
          <button
            className="button primary full"
            disabled={
              busy || !enabled || hasPending || !!storageError || !recordsLoaded
            }
            onClick={() => {
              void run(() => prepare("cancel"));
            }}
          >
            {busy ? "Stopping order…" : "Stop order and prepare withdrawal"}
          </button>
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
        </Modal>
      )}
      {selected && (
        <Modal
          title={
            selected.kind === "create"
              ? "Deposit and order status"
              : "Withdrawal status"
          }
          close={() => {
            if (!busy) {
              generation.current++;
              setSelected(null);
            }
          }}
        >
          <p className="wallet-address">Request {selected.id}</p>
          {selected.plan && <PlanReview plan={selected.plan} />}
          {costs && (
            <dl className="live-details">
              <dt>
                {costs.direction === "deposit"
                  ? "Deposit amount"
                  : "Withdrawal amount"}
              </dt>
              <dd>{displayUnits(costs.amount, costs.decimals)} tokens</dd>
              <dt>Token contract</dt>
              <dd>{costs.mint}</dd>
              <dt>Wallet</dt>
              <dd>{costs.wallet}</dd>
              <dt>Jupiter vault</dt>
              <dd>{costs.vault}</dd>
              {costs.depositAccount && (
                <>
                  <dt>Deposit account owned by this vault</dt>
                  <dd>{costs.depositAccount}</dd>
                </>
              )}
              <dt>Network fee</dt>
              <dd>{displayUnits(costs.feeLamports, 9)} SOL</dd>
              <dt>Maximum token-account rent</dt>
              <dd>{displayUnits(costs.rentLamports, 9)} SOL</dd>
            </dl>
          )}
          {selected.message && (
            <p className="live-funds-note">{selected.message}</p>
          )}
          {selected.signature && (
            <a
              className="word-link"
              href={`https://solscan.io/tx/${selected.signature}`}
              target="_blank"
              rel="noreferrer"
            >
              Check transaction on Solscan
            </a>
          )}
          <FundingTimeline key={selected.id} operation={selected} csrf={csrf} />
          {selected.state === "prepared" && (
            <>
              <p className="live-funds-note">
                Verify the token, amount and destination in your wallet. Signing
                and submitting moves real tokens. The transaction review expires
                at {new Date(selected.expiresAt!).toLocaleTimeString()}.
              </p>
              <button
                className="button primary full"
                disabled={busy || !enabled}
                onClick={() => void run(signAndSubmit)}
              >
                {busy
                  ? "Waiting for wallet or submission…"
                  : selected.kind === "create"
                    ? "Sign deposit and place order"
                    : "Sign and submit withdrawal"}
              </button>
              {busy && (
                <button
                  className="word-link funding-discard"
                  onClick={() => {
                    generation.current++;
                    locked.current = false;
                    setBusy(false);
                    setSelected(null);
                    setError(
                      "Stopped waiting. Close any pending wallet request. If submission started, check recovery before trying again.",
                    );
                    void refresh();
                  }}
                >
                  Stop waiting and check recovery
                </button>
              )}
              {selected.kind === "cancel" && (
                <button
                  className="word-link funding-discard"
                  disabled={busy}
                  onClick={() =>
                    void run(async () =>
                      remember(
                        await triggerRequest(
                          "funding-renew",
                          {
                            wallet,
                            id: selected.id,
                            newId: crypto.randomUUID(),
                          },
                          csrf,
                        ),
                      ),
                    )
                  }
                >
                  Prepare fresh withdrawal after expiry
                </button>
              )}
              {selected.kind === "create" && (
                <button
                  className="word-link funding-discard"
                  disabled={busy}
                  onClick={() =>
                    void run(async () =>
                      remember(
                        await triggerRequest(
                          "funding-abandon",
                          { wallet, id: selected.id },
                          csrf,
                        ),
                      ),
                    )
                  }
                >
                  Discard unsubmitted deposit
                </button>
              )}
            </>
          )}
          {["preparing", "submitted", "submitting", "unknown"].includes(
            selected.state,
          ) && (
            <button
              className="button secondary full"
              disabled={busy}
              onClick={() => void run(() => reconcile(selected.id))}
            >
              {busy ? "Checking records…" : "Check chain and order history"}
            </button>
          )}
          <p>
            <a
              className="word-link"
              href="https://jup.ag/limit"
              target="_blank"
              rel="noreferrer"
            >
              Open Jupiter for recovery
            </a>
          </p>
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
        </Modal>
      )}
    </section>
  );
}
function PlanReview({ plan }: { plan: OrderPlan }) {
  return (
    <dl className="live-details funding-plan">
      <dt>Order</dt>
      <dd>
        {plan.orderType === "oco"
          ? "Paired exits"
          : "trailingBps" in plan
            ? "Trailing stop"
            : "Limit order"}
      </dd>
      <dt>Sell contract</dt>
      <dd>{plan.inputMint}</dd>
      <dt>Receive contract</dt>
      <dd>{plan.outputMint}</dd>
      <dt>Exact input amount in base units</dt>
      <dd>{plan.inputAmount}</dd>
      <dt>Trigger token</dt>
      <dd>{shortAddress(plan.triggerMint)}</dd>
      {plan.orderType === "oco" ? (
        <>
          <dt>Target / stop</dt>
          <dd>
            ${plan.tpPriceUsd} / ${plan.slPriceUsd}
          </dd>
          <dt>Slippage limit for both exits</dt>
          <dd>
            {plan.tpSlippageBps / 100}% / {plan.slSlippageBps / 100}%
          </dd>
        </>
      ) : (
        <>
          <dt>
            {"trailingBps" in plan
              ? "Trailing distance"
              : `Trigger ${plan.triggerCondition}`}
          </dt>
          <dd>
            {"trailingBps" in plan
              ? `${plan.trailingBps / 100}%`
              : `$${plan.triggerPriceUsd}`}
          </dd>
          <dt>Slippage limit</dt>
          <dd>{plan.slippageBps / 100}%</dd>
        </>
      )}
      <dt>Expires</dt>
      <dd>{new Date(plan.expiresAt).toLocaleString()}</dd>
    </dl>
  );
}
