import {walletSessionRequest} from './wallet-session-client';
import {verifyWalletLogin,type WalletLogin} from './wallet-session-model';
import {CopyNativeApproval} from "./CopyNativeApproval";
import type {Token22Permission} from "./native-copy-permission";
import { CopyNativeAccount } from "./CopyNativeAccount";
import { CopyHistory } from "./CopyHistory";
import { CopyFeed } from "./CopyFeed";
import { CopyControls } from "./CopyControls";
import { CopyInventory } from "./CopyInventory";
import { useEffect, useRef, useState } from "react";
import type { AccountCopyPlan } from "./copy-account";
import type { TriggerSession } from "./live-orders";
import { triggerRequest } from "./trigger-api";
import { shortAddress } from "./assets";
export function CopyAccount({
  wallet,
  active,
  externalRevision,
  signSession,
  onConnect,
  signNativeCopy,
}: {
  wallet?: string;
  active: boolean;
  externalRevision: number;
  signSession: (challenge:WalletLogin)=>Promise<string>;
  onConnect: () => void;
  signNativeCopy: (scope:Token22Permission)=>Promise<string>;
}) {
  const [session, setSession] = useState<TriggerSession | null>(null);
  const [backups, setBackups] = useState<AccountCopyPlan[]>([]);
  const [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [signingIn,setSigningIn]=useState(false);
  const walletRef=useRef(wallet);walletRef.current=wallet;
  const loginLock=useRef(false);
  const [now,setNow]=useState(Date.now);
  useEffect(()=>{const id=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(id);},[]);
  async function authorize(){
    if(!wallet||loginLock.current)return;
    const selected=wallet;loginLock.current=true;setSigningIn(true);setError("");
    const current=()=>alive.current&&walletRef.current===selected;
    try{
      const review=await walletSessionRequest<{challenge:WalletLogin;message:string}>('challenge',{wallet:selected});
      if(!current())return;
      const challenge=verifyWalletLogin(review,selected,location.origin);
      const signature=await signSession(challenge);
      if(!current())return;
      const result=await walletSessionRequest<TriggerSession>('verify',{wallet:selected,signature});
      if(!current()){await walletSessionRequest('logout',{wallet:selected});return;}
      if(result.address!==selected||!result.csrf||!result.expiresAt||result.expiresAt<=Date.now())throw Error('Wallet sign-in was not confirmed.');
      setSession(result);setNow(Date.now());setRevision(v=>v+1);
    }catch(error){if(current())setError(error instanceof Error?error.message:'Wallet sign-in failed.');}
    finally{loginLock.current=false;if(alive.current)setSigningIn(false);}
  }
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [feedId, setFeedId] = useState<string | null>(null);
  const alive = useRef(true),
    locked = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!wallet || !active) return;
    const controller = new AbortController();
    let current = true;
    setLoaded(false);
    setError("");
    (async () => {
      const auth = await walletSessionRequest<TriggerSession>(
        "status",
        undefined,
        controller.signal,
      );
      if (!current) return;
      setSession(auth);
      if (auth.address !== wallet || !auth.csrf) return;
      const reply = await triggerRequest<{
        wallet: string;
        plans: AccountCopyPlan[];
      }>("copy-list", { wallet }, auth.csrf, controller.signal);
      if (
        reply.wallet !== wallet ||
        !Array.isArray(reply.plans) ||
        reply.plans.some((plan) => plan.wallet !== wallet)
      )
        throw new Error("Wallet plan mismatch.");
      if (current) {
        setBackups(reply.plans);
        setLoaded(true);
      }
    })().catch(() => {
      if (current)
        setError(
          "Wallet plans could not be loaded. Refresh before creating another plan.",
        );
    });
    return () => {
      current = false;
      controller.abort();
    };
  }, [wallet, active, revision, externalRevision]);
  const authorized =
    !!wallet &&
    session?.address === wallet &&
    !!session.csrf &&
    (session.expiresAt || 0) > now;
  async function archive(plan: AccountCopyPlan) {
    if (locked.current || !authorized) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      const saved: AccountCopyPlan = await triggerRequest<AccountCopyPlan>(
        "copy-archive",
        { wallet, id: plan.id, version: plan.version },
        session!.csrf,
      );
      if (
        saved.wallet !== wallet ||
        saved.id !== plan.id ||
        !saved.archived ||
        saved.enabled
      )
        throw new Error("Unexpected archive response.");
      if (alive.current) {
        setBackups((current) =>
          current.map((item) => (item.id === saved.id ? saved : item)),
        );
        setNotice(
          "Plan archived. Trade records were kept.",
        );
      }
    } catch (error) {
      if (alive.current) {
        setError(error instanceof Error ? error.message : "Archive failed.");
        setLoaded(false);
      }
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="copy-account" aria-label="Wallet copy plans">
      <div className="section-heading">
        <h2>Your wallet’s copy plans</h2>
        {wallet && <span className="muted small">{shortAddress(wallet)}</span>}
      </div>
      <p className="muted copy-backup-description">
        These plans are saved to your wallet. Check signed permissions and service status below; unfinished setups do not execute.
      </p>
      {!wallet ? (
        <button className="word-link" onClick={onConnect}>
          Connect wallet to manage plans
        </button>
      ) : !authorized ? (
        <button className="button secondary compact" disabled={signingIn} onClick={()=>void authorize()}>
          {signingIn?'Confirm in your wallet…':'Sign in with this wallet'}
        </button>
      ) : (
        <>
          <CopyControls
            key={wallet}
            wallet={wallet!}
            csrf={session!.csrf!}
            plans={backups}
            revision={revision+externalRevision}
            onChange={() => setRevision((value) => value + 1)}
          />
          <div className="live-order-actions">
            <button
              className="word-link"
              disabled={busy}
              onClick={() => setRevision((value) => value + 1)}
            >
              Refresh plans
            </button>
          </div>
          {active && (
            <CopyInventory
              key={wallet}
              wallet={wallet!}
              csrf={session!.csrf!}
            />
          )}
          {active && (
            <CopyNativeAccount
              key={wallet}
              wallet={wallet!}
              csrf={session!.csrf!}
              revision={revision+externalRevision}
            />
          )}
          {loaded && !backups.length && (
            <p className="muted">No plans for this wallet yet.</p>
          )}
          {backups.map((plan) => (
            <article className="copy-backup-row" key={plan.id}>
              <div>
                <b>{plan.name || shortAddress(plan.address)}</b>
                <small>
                  {shortAddress(plan.address)} · {plan.enabled?'Check execution status below':'Needs approval or renewal'}
                  {plan.archived ? " · Archived" : ""}
                </small>
              </div>
              {!plan.archived&&<CopyNativeApproval key={`${wallet}:${plan.id}:${plan.version}`} wallet={wallet!} csrf={session!.csrf!} plan={plan} sign={signNativeCopy} onChange={()=>setRevision(v=>v+1)}/>}
              <div className="live-order-actions">
                <button
                  className="word-link"
                  disabled={busy || !loaded}
                  onClick={() => setFeedId(feedId === plan.id ? null : plan.id)}
                >
                  {feedId === plan.id ? "Close activity" : "Leader activity"}
                </button>
                <button
                  className="word-link"
                  disabled={busy || !loaded}
                  onClick={() =>
                    setHistoryId(historyId === plan.id ? null : plan.id)
                  }
                >
                  {historyId === plan.id
                    ? "Close trade history"
                    : "Trade history"}
                </button>
                {!plan.archived && (
                  <button
                    className="word-link"
                    disabled={busy || !loaded}
                    onClick={() => void archive(plan)}
                  >
                    Archive plan
                  </button>
                )}
              </div>
            </article>
          ))}
          {active && feedId && backups.some((plan) => plan.id === feedId) && (
            <CopyFeed
              key={`${feedId}:${backups.find((plan) => plan.id === feedId)!.version}`}
              plan={backups.find((plan) => plan.id === feedId)!}
              csrf={session!.csrf!}
            />
          )}
          {active &&
            historyId &&
            backups.some((plan) => plan.id === historyId) && (
              <CopyHistory
                key={`${wallet}:${historyId}:${revision}:${backups.find((plan) => plan.id === historyId)!.version}`}
                plan={backups.find((plan) => plan.id === historyId)!}
                csrf={session!.csrf!}
              />
            )}
          <p className="copy-help">
            Only a valid signed permission authorizes copying. Paused or expired plans require renewed approval; pending transactions remain tracked.
          </p>
        </>
      )}
      {notice && (
        <p role="status" className="copy-save-notice">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
    </section>
  );
}
