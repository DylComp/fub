import {ViewedTokenChart} from "./ViewedTokenChart";
import {TokenSearch} from "./TokenSearch";
import type {DiscoveredToken} from "./assets";
import {useWalletSetup} from './WalletSetup';
import type {Token22Permission} from "./native-copy-permission";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { CopyAccount } from "./CopyAccount";
import { FomoLeaderPicker } from "./FomoLeaderPicker";
import {CopyPlanCreate} from "./CopyPlanCreate";
import { isMint } from "./assets";
import {copyError,emptyCopyDraft} from './copy-model';
import type {CopyDraft} from './copy-model';

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
  const [chartToken,setChartToken]=useState<DiscoveredToken|null>(null),[chartPicker,setChartPicker]=useState(false);
  const [revision,setRevision]=useState(0);
  const [draft, setDraft] = useState(() => ({
    ...emptyCopyDraft(),
    address: initialAddress,
  }));
  const [review, setReview] = useState<CopyDraft | null>(null);
  const [error, setError] = useState("");
  const addressInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!initialAddress) return;
    setDraft({ ...emptyCopyDraft(), address: initialAddress });
    setReview(null);
    setError("");
  }, [initialAddress]);
  const patch = (value: Partial<CopyDraft>) => {
    setDraft((old) => ({ ...old, ...value }));
    setError("");
  };
  useEffect(()=>{setReview(null);setError('');},[wallet]);
  if(!wallet)return <section className="copy-workspace"><h2>Connect your wallet to copy a trader.</h2><p>Your plan belongs to your wallet. Approve its trading limits before automatic copying starts.</p><button className="button primary" onClick={onConnect}>Connect wallet</button></section>;
  return (
    <section className="copy-workspace" aria-label="Copy trading setup">
      <div className="copy-boundary">
        <strong>Choose a trader. Set your limits.</strong>
        <p>
          Connect your wallet, choose a trader, then approve its trading limits.
          Wallet access and an available trading service are required for execution.
        </p>
      </div>
      <div className="copy-entry-actions">
      {import.meta.env.VITE_CASH_COPY_SETUP==='true'&&<button className="word-link" disabled={!wallet||!isMint(draft.address)} onClick={()=>setup.openCashCopy(draft.address,draft.identity?.handle)}>Copy this trader with USDC across chains</button>}
      {setup.canImport&&<button className="word-link" disabled={!wallet} onClick={()=>setup.openCashPlans()}>Your USDC copy plans</button>}
      </div>
      <div className="copy-chart-picker"><button className="word-link" onClick={()=>setChartPicker(true)}>{chartToken?"Change chart token":"View a token chart"}</button></div>
      {chartToken&&<ViewedTokenChart address={chartToken.address} network={chartToken.chain||"solana"} label={chartToken.symbol} active={active && !setup.modalOpen}/>}
      {chartPicker&&<TokenSearch close={()=>setChartPicker(false)} select={token=>{setChartToken(token);setChartPicker(false);}}/>}
      <div className="copy-grid">
        <section className="copy-builder" aria-label="Copy plan builder">
          <div className="section-heading">
            <h2>
              Choose a Fomo trader to follow.
            </h2>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const issue = copyError(draft, []);
              if (issue) setError(issue);
              else setReview({ ...draft });
            }}
          >
            <FomoLeaderPicker
              address={draft.address}
              identity={draft.identity}
              active={active && !setup.modalOpen}
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
            <p className="copy-help">Set your SOL buy amount, daily spending cap and expiry in the wallet approval step.</p>
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
              Set up Solana copying <ArrowRight size={16} />
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
              trades within those limits, even when you close Fub. An unsigned setup is not an active plan.
            </p>
          </div>
        </aside>
      </div>
      <CopyAccount
        signNativeCopy={signNativeCopy}
        key={wallet || "disconnected"}
        wallet={wallet}
        active={active && !setup.modalOpen}
        externalRevision={revision}
        signSession={signSession}
        onConnect={onConnect}
      />
      {review&&<CopyPlanCreate key={wallet} wallet={wallet} draft={review} signSession={signSession} signNativeCopy={signNativeCopy} close={()=>setReview(null)} onChange={()=>setRevision(v=>v+1)}/>}
    </section>
  );
}
