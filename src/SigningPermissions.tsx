import { useEffect, useRef, useState } from "react";
import type { EnrollmentChallenge } from "./signer-enrollment-model";
import { enrollmentAccess, enrollmentClient, enrollmentReview, enrollmentStatus, validEnrollmentConfig, type EnrollmentConfig, type EnrollmentIdentity, type EnrollmentStatus } from "./enrollment-client";
import { SigningPositions } from "./SigningPositions";
import { shortAddress } from "./assets";

export type SigningPermissionProps = {
  config: EnrollmentConfig; identity: EnrollmentIdentity; origin: string;
  getToken: () => Promise<string | null>;
  sign: (challenge: EnrollmentChallenge) => Promise<string>;
  addSigner: (challenge: EnrollmentChallenge) => Promise<void>;
  removeSigners: () => Promise<void>;
  onDone?: () => void;
};
export function SigningPermissions(props: SigningPermissionProps) {
  const { config, identity, origin } = props;
  const configured = validEnrollmentConfig(config, origin);
  const [records, setRecords] = useState<EnrollmentStatus[]>([]), [loaded, setLoaded] = useState(false);
  const review = useRef<EnrollmentChallenge | null>(null);
  const [duration, setDuration] = useState(86400000), [renewing, setRenewing] = useState(false);
  const [providerState, setProviderState] = useState<'ready' | 'approval-required' | 'unchecked'>('unchecked');
  const [now, setNow] = useState(Date.now);
  const savedActive = records.find(r => r.state === "active" && r.expiresAt > now);
  const active = providerState === 'ready' ? savedActive : undefined;
  const outdated = records.some(r => r.state === 'outdated' && r.expiresAt > now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const alive = useRef(true), locked = useRef(false), request = useRef<AbortController | null>(null);
  const binding = JSON.stringify([identity, config, origin]);
  const latest = useRef(binding); latest.current = binding;
  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current?.abort(); }; }, []);
  const current = () => alive.current && latest.current === binding;
  function check() { if (!current() || request.current?.signal.aborted) throw Error("Wallet or account changed."); }
  async function execute(work: (signal: AbortSignal) => Promise<unknown>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(""); setNotice("");
    const controller = new AbortController(); request.current = controller;
    try { await work(controller.signal); }
    catch (e) { if (current()) setError(e instanceof Error ? e.message : "The request was not confirmed. Refresh before retrying."); }
    finally { locked.current = false; if (current()) setBusy(false); }
  }
  const client = (signal: AbortSignal) => {
    const send = enrollmentClient(config, origin, props.getToken, current);
    return (action: Parameters<typeof send>[0], body: object) => send(action, body, signal);
  };
  async function refresh(signal: AbortSignal) {
    const result = await client(signal)("list", { wallet: identity.wallet }) as { wallet: string; permissions: unknown[] };
    if (result?.wallet !== identity.wallet || !Array.isArray(result.permissions) || result.permissions.length > 20) throw Error("Wallet permissions could not be verified.");
    const items = result.permissions.map(item => enrollmentStatus(item, identity.wallet));
    if (new Set(items.map(r => r.id)).size !== items.length) throw Error("Duplicate permission response.");
    check(); setRecords(items); setLoaded(true); setNow(Date.now());
    setProviderState('unchecked');
    const access = enrollmentAccess(await client(signal)('access', {wallet: identity.wallet, walletId: identity.walletId}), config, identity);
    check(); setProviderState(access); return {items, access};
  }
  useEffect(() => {
    review.current = null; setRenewing(false); setRecords([]); setLoaded(false); setProviderState('unchecked'); setError(""); setNotice(""); setConfirmRemoval(false);
    let cancelled = false;
    queueMicrotask(() => { if (configured && !cancelled) void execute(refresh); });
    return () => { cancelled = true; request.current?.abort(); };
    // The parent remounts this panel whenever the wallet/account/config changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [binding]);
  async function enable(signal: AbortSignal) {
    // This click approves the displayed scope/duration; provider prompts remain explicit.
    const {items: latestRecords, access} = await refresh(signal);
    if (!renewing && access === 'ready' && latestRecords.some(r => r.state === "active" && r.expiresAt > Date.now())) return;
    if (!review.current || review.current.challengeExpiresAt <= Date.now() || review.current.expiresAt - review.current.issuedAt !== duration) {
      const result = await client(signal)("prepare", { wallet: identity.wallet, walletId: identity.walletId, durationMs: duration });
      review.current = enrollmentReview(result, config, identity, origin, duration);
    }
    const challenge = review.current;
    check();
    const signature = await props.sign(challenge);
    check();
    if (challenge.challengeExpiresAt <= Date.now()) throw Error("Approval timed out. Try again when ready.");
    try { if (access !== 'ready') await props.addSigner(challenge); }
    catch {
      // A prior grant can outlive Fub's enrollment, or the SDK response can be
      // lost. Activation independently reads Privy and verifies the exact
      // owner, signer and pinned policy; an SDK error never proves access.
    }
    check();
    if (challenge.challengeExpiresAt <= Date.now()) throw Error("Approval timed out. Try again when ready.");
    try {
      const status = enrollmentStatus(await client(signal)("activate", { id: challenge.id, signature }), identity.wallet, challenge.id);
      if (status.state !== "active" || status.expiresAt <= Date.now()) throw Error("Activation was not confirmed.");
    } catch {
      // Recover an uncertain response before ever asking for another approval.
      const {items} = await refresh(signal);
      if (!items.some(r => r.id === challenge.id && r.state === "active" && r.expiresAt > Date.now()))
        throw Error("Approval was not confirmed. Check status before trying again.");
    }
    review.current = null; setRenewing(false); await refresh(signal);
    setNotice("Wallet access approved. Each exit order and copy plan needs its own trading limits and approval.");
    props.onDone?.();
  }
  async function stop(id: string, signal: AbortSignal) {
    const result = enrollmentStatus(await client(signal)("stop", { id }), identity.wallet, id);
    if (result.state !== "revoked") throw Error("Stopping was not confirmed. Refresh and try again.");
    review.current = null; setRenewing(false); await refresh(signal);
    setNotice("Fub access stopped. Transactions already signed or submitted can still confirm.");
  }
  async function remove(signal: AbortSignal) {
    if (!confirmRemoval) return;
    let stopped = false;
    if (configured) {
      try {
        const list = await client(signal)("list", { wallet: identity.wallet }) as { wallet: string; permissions: unknown[] };
        if (list?.wallet !== identity.wallet || !Array.isArray(list.permissions) || list.permissions.length > 20) throw Error();
        for (const item of list.permissions) {
          const status = enrollmentStatus(item, identity.wallet);
          if (status.state === "active" || status.state === "pending" || status.state === 'outdated') {
            const result = enrollmentStatus(await client(signal)("stop", { id: status.id }), identity.wallet, status.id);
            if (result.state !== "revoked") throw Error();
          }
        }
        stopped = true;
      } catch { /* Provider removal must remain available during a Fub service outage. */ }
    }
    check(); await props.removeSigners(); check();
    review.current = null; setRenewing(false); setConfirmRemoval(false);
    if (configured) { try { await refresh(signal); } catch { setRecords([]); setLoaded(false); setError("Fub status is unavailable. Check again when the service returns."); } }
    setNotice(`Privy confirmed removal of all additional signers from this wallet. ${stopped ? "Fub access is also stopped." : "Fub's saved permission status could not be confirmed; refresh it when the service returns."} Already signed transactions may still confirm.`);
  }
  return <section className="signing-permissions" aria-label="Background permissions">
    <div className="access-summary">
      <span className="access-caption">{shortAddress(identity.wallet)}</span>
      <h3>{active ? "Wallet access approved" : outdated ? "Update wallet access" : "Allow Fub to follow your plans"}</h3>
      <p className="copy-help">{active ? `Access ends ${new Date(active.expiresAt).toLocaleString()}.` : "Approve wallet access, then approve the limits for each exit order or copy plan. Your funds stay in your wallet."}</p>
    </div>
    {!configured ? <p className="wallet-notice" role="status">Wallet access is unavailable. Try again later.</p> : <>
      {!loaded && busy && !error && <p className="copy-help" role="status">Checking wallet access…</p>}
      {loaded && (!active || renewing) && <div className="access-setup">
        <label className="field"><span>Allow access for</span><select value={duration} disabled={busy} onChange={e => { review.current = null; setDuration(Number(e.target.value)); }}><option value={3600000}>1 hour</option><option value={86400000}>24 hours</option><option value={604800000}>7 days</option></select></label>
        <p className="copy-help">For limit orders and copy trades you separately approve. Payments, withdrawals and launches need separate approval.</p>
        {outdated && <p className="copy-help">Your saved access uses an older signing policy. Approve the current access, then review fresh limits for any waiting orders or copy plans. Existing signed transactions keep their status.</p>}
        <p className="copy-help">Fub enforces this time limit. Privy access remains until you remove it under Advanced.</p>
        {renewing && <p className="copy-help">Renewing replaces your current access. Existing exit orders and copy plans need new trading approvals. Cancel waiting exits and review them again after renewal.</p>}
        <button className="button primary full" disabled={busy || providerState === 'unchecked'} onClick={() => void execute(enable)}>{busy ? "Checking or approving access…" : renewing ? "Approve renewed access" : outdated ? "Approve updated access" : "Approve wallet access"}</button>
        {renewing && <button className="word-link" disabled={busy} onClick={() => setRenewing(false)}>Cancel renewal</button>}
      </div>}
      {active && !renewing && <div className="access-active">
        <p className="copy-help">Your wallet setup is complete. Approval alone does not start trades.</p>
        {props.onDone && <button className="button primary full" disabled={busy} onClick={props.onDone}>Done</button>}
        <button className="word-link" disabled={busy} onClick={() => void execute(signal => stop(active.id, signal))}>Pause access</button>
        <p className="copy-help">Already signed transactions may still confirm after pausing.</p>
      </div>}
    </>}
    {notice && <p className="wallet-notice" role="status">{notice}</p>}
    {error && <div><p className="error-message" role="alert">{error}</p><button className="word-link" disabled={busy} onClick={() => void execute(refresh)}>Check status</button></div>}
    <details className="wallet-advanced"><summary>Advanced</summary><div className="wallet-advanced-content">
      {configured && <>
        <button className="word-link" disabled={busy} onClick={() => void execute(refresh)}>Refresh permissions</button>
        {active && <button className="word-link" disabled={busy} onClick={() => setRenewing(true)}>Renew access</button>}
        {savedActive && !active && <button className="word-link" disabled={busy} onClick={() => void execute(signal => stop(savedActive.id, signal))}>Pause saved access</button>}
        <details><summary>Permission history</summary>
          {records.length === 0 && <p className="copy-help">No saved permissions.</p>}
          {records.map(record => <div className="permission-record" key={record.id}>
            <div><strong>{record.expiresAt <= now ? "Expired" : record.state === "outdated" ? "Needs updated access" : record.state === "active" ? "Saved access" : record.state === "pending" ? "Unfinished approval" : "Stopped"}</strong><p className="copy-help">Ends {new Date(record.expiresAt).toLocaleString()}</p></div>
            {(record.state === "pending" || record.state === 'outdated') && <button className="word-link" disabled={busy} onClick={() => void execute(signal => stop(record.id, signal))}>Discard</button>}
          </div>)}
        </details>
        <SigningPositions identity={identity} busy={busy} execute={execute} send={(action,body,signal)=>client(signal)(action,body)} />
      </>}
      <div className="permission-removal"><h3>Remove provider access</h3><p className="copy-help">Removes all additional Privy signers on this wallet, including those used by other features. Ownership and funds stay unchanged.</p>
        <label className="copy-toggle"><input type="checkbox" checked={confirmRemoval} disabled={busy} onChange={e => setConfirmRemoval(e.target.checked)} /><span>Remove all additional signers from this wallet.</span></label>
        <button className="button secondary full" disabled={busy || !confirmRemoval} onClick={() => void execute(remove)}>Remove additional signers</button>
      </div>
    </div></details>
  </section>;
}
