import {useWalletSetup} from './WalletSetup';
import type {Token22Permission} from "./native-copy-permission";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowUpRight, Pencil, Trash2 } from "lucide-react";
import { CopyAccount } from "./CopyAccount";
import { FomoLeaderPicker } from "./FomoLeaderPicker";
import { Modal } from "./ui";
import { shortAddress, isMint } from "./assets";
import { usd } from "./model";
import {
  COPY_STORAGE_KEY,
  copyError,
  draftFromPlan,
  emptyCopyDraft,
  loadCopyPlans,
  saveCopyPlan,
} from "./copy-model";
import type { CopyDraft, CopyPlan } from "./copy-model";

export function CopyTrading({
  initialAddress = "",
  onInspect,
  wallet,
  active,
  signSession,
  onConnect,
  signNativeCopy,
}: {
  initialAddress?: string;
  wallet?: string;
  active: boolean;
  signSession: (challenge: import("./wallet-session-model").WalletLogin) => Promise<string>;
  onConnect: () => void;
  signNativeCopy: (scope:Token22Permission)=>Promise<string>;
  onInspect: (address: string) => void;
}) {
  const setup=useWalletSetup();
  const [loaded] = useState(loadCopyPlans);
  const [plans, setPlans] = useState(loaded.plans);
  const [draft, setDraft] = useState(() => ({
    ...emptyCopyDraft(),
    address: initialAddress,
  }));
  const [editing, setEditing] = useState<string>();
  const [review, setReview] = useState<CopyDraft | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(loaded.warning);
  const addressInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!initialAddress) return;
    setDraft({ ...emptyCopyDraft(), address: initialAddress });
    setEditing(undefined);
    setReview(null);
    setError("");
  }, [initialAddress]);
  const patch = (value: Partial<CopyDraft>) => {
    setDraft((old) => ({ ...old, ...value }));
    setError("");
  };
  function persist(next: CopyPlan[], message: string) {
    try {
      localStorage.setItem(
        COPY_STORAGE_KEY,
        JSON.stringify({ version: 1, plans: next }),
      );
    } catch {
      setError("Browser storage is unavailable. This change was not saved.");
      return false;
    }
    setPlans(next);
    setNotice(message);
    setError("");
    return true;
  }
  function reset() {
    setDraft(emptyCopyDraft());
    setEditing(undefined);
    setError("");
  }
  function edit(plan: CopyPlan) {
    setDraft(draftFromPlan(plan));
    setEditing(plan.id);
    setError("");
    addressInput.current?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
    addressInput.current?.focus({ preventScroll: true });
  }
  return (
    <section className="copy-workspace" aria-label="Copy trading setup">
      <div className="copy-boundary">
        <strong>Choose a trader. Set your limits.</strong>
        <p>
          Save a plan, sign in with your wallet, then approve its trading limits.
          Wallet access and an available trading service are required for execution.
        </p>
      </div>
      {import.meta.env.VITE_CASH_COPY_SETUP==='true'&&(!import.meta.env.VITE_CASH_COPY_PILOT_WALLET||wallet===import.meta.env.VITE_CASH_COPY_PILOT_WALLET)&&<button className="word-link" disabled={!wallet||!isMint(draft.address)} onClick={()=>setup.openCashCopy(draft.address,draft.identity?.handle)}>Copy this trader with USDC across chains</button>}
      {setup.canImport&&<button className="word-link" disabled={!wallet} onClick={()=>setup.openCashPlans()}>Your USDC copy plans</button>}
      <div className="copy-grid">
        <section className="copy-builder" aria-label="Copy plan builder">
          <div className="section-heading">
            <h2>
              {editing ? "Edit your copy plan." : "Choose a Fomo trader to follow."}
            </h2>
            {editing && (
              <button className="word-link" onClick={reset}>
                Cancel edit
              </button>
            )}
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const issue = copyError(draft, plans, editing);
              if (issue) setError(issue);
              else setReview({ ...draft });
            }}
          >
            <FomoLeaderPicker
              address={draft.address}
              identity={draft.identity}
              active={active}
              inputRef={addressInput}
              onChange={(address, identity) => patch({
                address,
                identity,
                ...(!draft.name || (draft.identity && draft.name === `@${draft.identity.handle}`.slice(0, 40))
                  ? { name: identity ? `@${identity.handle}`.slice(0, 40) : "" } : {}),
              })}
            />
            <label className="field">
              <span>
                Wallet label <small>Optional</small>
              </span>
              <input
                aria-label="Wallet label"
                placeholder="A name you’ll recognize"
                value={draft.name}
                maxLength={40}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </label>
            <div className="copy-amounts">
              <label className="field">
                <span>Per buy · USD</span>
                <input
                  aria-label="Copy buy amount"
                  inputMode="decimal"
                  value={draft.buyUsd}
                  onChange={(e) => patch({ buyUsd: e.target.value })}
                  required
                />
              </label>
              <label className="field">
                <span>Daily buy cap · USD</span>
                <input
                  aria-label="Daily copy cap"
                  inputMode="decimal"
                  value={draft.dailyUsd}
                  onChange={(e) => patch({ dailyUsd: e.target.value })}
                  required
                />
              </label>
            </div>
            <p className="copy-help copy-cap-note">
              Per wallet, per UTC day. A buy that exceeds the remaining cap
              would be skipped. Fees need a separate balance.
            </p>
            <label className="field copy-slippage">
              <span>
                Maximum slippage <small>0.10–5.00%</small>
              </span>
              <div className="input-shell">
                <input
                  aria-label="Copy slippage percent"
                  inputMode="decimal"
                  value={draft.slippage}
                  onChange={(e) => patch({ slippage: e.target.value })}
                  required
                />
                <span>%</span>
              </div>
            </label>
            <label className="copy-sells">
              <input
                type="checkbox"
                checked={draft.copySells}
                onChange={(e) => patch({ copySells: e.target.checked })}
              />
              <span>
                <b>Follow their sells</b>
                <small>
                  Sell the same fraction of positions acquired by this plan.
                  Leave your other holdings alone.
                </small>
              </span>
            </label>
            {error && !review && (
              <p className="error-message" role="alert">
                {error}
              </p>
            )}
            <button className="button primary full" type="submit">
              Review copy plan <ArrowRight size={16} />
            </button>
          </form>
          <button
            className="word-link copy-inspect"
            disabled={!isMint(draft.address.trim())}
            onClick={() => onInspect(draft.address.trim())}
          >
            Inspect this wallet <ArrowUpRight size={14} />
          </button>
        </section>
        <aside className="copy-explainer">
          <p className="eyebrow">HOW COPYING WORKS</p>
          <h2>
            Their next move.
            <br />
            Your own size.
          </h2>
          <ol>
            <li>
              <b>A new confirmed swap</b>
              <p>
                Watch future Solana swaps from the chosen address. Transfers,
                airdrops, and old trades are not copied.
              </p>
            </li>
            <li>
              <b>Your limits, checked first</b>
              <p>
                Quote your fixed buy amount. Skip unavailable routes or trades
                that breach your spending and slippage caps.
              </p>
            </li>
            <li>
              <b>A separate execution</b>
              <p>
                Your authorized wallet places its own trade. Your timing,
                price, fees, and returns will differ from the leader’s.
              </p>
            </li>
          </ol>
          <div className="copy-prerequisites">
            <b>Before activation</b>
            <p>
              Set up your Fomo or connected Solana wallet for automatic signing and approve the plan’s
              trading limits. Once activated, the service copies supported new
              trades within those limits, even when you close Fub. Saving a plan
              alone does not start trading.
            </p>
          </div>
        </aside>
      </div>
      <section className="copy-saved" aria-label="Saved copy plans">
        <div className="section-heading">
          <h2>
            Your copy plans <span>{plans.length}</span>
          </h2>
          <span className="muted small">Saved on this device</span>
        </div>
        {notice && (
          <p className="copy-save-notice" role="status">
            {notice}
          </p>
        )}
        {!plans.length ? (
          <div className="copy-empty">
            <p>No wallets added yet.</p>
            <span>Save a plan to keep its address and limits ready.</span>
          </div>
        ) : (
          <div className="copy-plan-list">
            {plans.map((plan) => (
              <article className="copy-plan-row" key={plan.id}>
                <div className="copy-plan-wallet">
                  <h3>{plan.name || shortAddress(plan.address)}</h3>
                  {plan.identity && <p className="copy-help">@{plan.identity.handle} · Profile link</p>}
                  <a
                    href={`https://solscan.io/account/${plan.address}`}
                    target="_blank"
                    rel="noreferrer"
                    title={plan.address}
                  >
                    {shortAddress(plan.address)} <ArrowUpRight size={12} />
                  </a>
                </div>
                <dl>
                  <div>
                    <dt>Per buy</dt>
                    <dd>{usd(plan.buyCents / 100)}</dd>
                  </div>
                  <div>
                    <dt>Daily cap</dt>
                    <dd>{usd(plan.dailyCents / 100)}</dd>
                  </div>
                  <div>
                    <dt>Slippage</dt>
                    <dd>{plan.slippageBps / 100}%</dd>
                  </div>
                  <div>
                    <dt>Sells</dt>
                    <dd>{plan.copySells ? "Proportional" : "Off"}</dd>
                  </div>
                </dl>
                <div className="copy-plan-actions">
                  <button
                    className="icon-button"
                    aria-label={`Inspect ${plan.name || shortAddress(plan.address)}`}
                    onClick={() => onInspect(plan.address)}
                  >
                    <ArrowUpRight size={15} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Edit ${plan.name || shortAddress(plan.address)}`}
                    onClick={() => edit(plan)}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Remove ${plan.name || shortAddress(plan.address)}`}
                    onClick={() => {
                      if (
                        persist(
                          plans.filter((p) => p.id !== plan.id),
                          "Copy plan removed.",
                        ) &&
                        editing === plan.id
                      )
                        reset();
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      <CopyAccount
        signNativeCopy={signNativeCopy}
        key={wallet || "disconnected"}
        wallet={wallet}
        active={active}
        plans={plans}
        signSession={signSession}
        onConnect={onConnect}
        onLoad={(plan) => {
          setDraft(draftFromPlan(plan));
          setEditing(plans.find((local) => local.address === plan.address)?.id);
          setError("");
          setReview(null);
          addressInput.current?.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
          addressInput.current?.focus({ preventScroll: true });
        }}
      />
      {review && (
        <Modal
          title="Review your copy plan."
          description="Save these settings only. This does not connect, monitor, or trade from a wallet."
          close={() => {
            setReview(null);
            setError("");
          }}
        >
          <p className="review-contract">
            Leader’s Solana address<span>{review.address.trim()}</span>
          </p>
          {review.identity && (
            <p className="copy-help">
              @{review.identity.handle} · Profile link supplied by you.
              This plan follows the exact address above.
            </p>
          )}
          <dl className="review-details">
            <div>
              <dt>Each copied buy</dt>
              <dd>{usd(Number(review.buyUsd))}</dd>
            </div>
            <div>
              <dt>Daily buy cap · UTC</dt>
              <dd>{usd(Number(review.dailyUsd))}</dd>
            </div>
            <div>
              <dt>Maximum slippage</dt>
              <dd>{review.slippage}%</dd>
            </div>
            <div>
              <dt>Leader sells</dt>
              <dd>
                {review.copySells
                  ? "Same fraction of copied positions"
                  : "Do not copy"}
              </dd>
            </div>
            <div>
              <dt>Execution</dt>
              <dd>Not connected</dd>
            </div>
          </dl>
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          <button
            className="button primary full"
            onClick={() => {
              try {
                const next = saveCopyPlan(plans, review, editing);
                if (
                  persist(
                    next,
                    "Copy plan saved. Monitoring and execution remain inactive.",
                  )
                ) {
                  setReview(null);
                  reset();
                }
              } catch (e) {
                setError(
                  e instanceof Error ? e.message : "Unable to save this plan.",
                );
              }
            }}
          >
            Save inactive plan
          </button>
        </Modal>
      )}
    </section>
  );
}
