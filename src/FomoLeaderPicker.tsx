import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { ArrowUpRight } from "lucide-react";
import { isMint } from "./assets";
import { fomoHandle, fomoProfileUrl } from "./fomo-identity";
import type { FomoIdentity } from "./fomo-identity";
import {validFomoRecipient, type FomoRecipient} from "./fomo-recipient";
import {FomoRecipientCard} from "./FomoRecipientCard";
import "./launchpad.css";

export function FomoLeaderPicker({ address, identity, active, inputRef, onChange, purpose = "leader" }: {
  purpose?: "leader" | "owner" | "recipient";
  address: string;
  identity?: FomoIdentity;
  active: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onChange: (address: string, identity?: FomoIdentity) => void;
}) {
  const [wallet, setWallet] = useState("");
  const [error, setError] = useState("");
  const [lookup, setLookup] = useState<FomoRecipient | null>(null);
  const [looking, setLooking] = useState(false);
  const request = useRef<AbortController | null>(null);
  const handle = fomoHandle(address);
  useEffect(() => {
    request.current?.abort();
    setWallet(""); setError(""); setLookup(null); setLooking(false);
    return () => { request.current?.abort(); };
  }, [address]);
  useEffect(() => {
    if (!active) { request.current?.abort(); setLooking(false); }
  }, [active]);
  async function findWallet() {
    if (!handle || !active) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLooking(true); setError(""); setLookup(null); setWallet("");
    const deadline = Date.now() + 180000;
    try {
      for(let attempt=0;attempt<19;attempt++) {
        const response = await fetch(`/api/wallet?action=recipient&handle=${encodeURIComponent(handle)}`, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
        });
        const result: unknown = await response.json();
        if (controller.signal.aborted) return;
        if (!response.ok) {
          setError(response.status === 404
            ? "No Fomo profile found. Check the username or paste the public wallet."
            : response.status === 429 ? "Too many lookups. Try again in a minute."
            : "Username lookup is unavailable. Try again later or paste the public wallet.");
          return;
        }
        if (!validFomoRecipient(result, handle)) throw new Error("Invalid lookup");
        setLookup(result); setWallet(result.state==='matched' ? result.address! : "");
        if ((result.state!=='pending'&&!result.profilePending)||attempt===18||Date.now()>=deadline) return;
        await new Promise<void>((resolve,reject)=>{
          const stop=()=>{clearTimeout(timer);reject(Error("Lookup cancelled"));};
          const timer=setTimeout(()=>{controller.signal.removeEventListener("abort",stop);resolve();},Math.min(deadline-Date.now(),Math.max(5,result.retryAfter||30)*1000));
          controller.signal.addEventListener("abort",stop,{once:true});
        });
      }
    } catch {
      if (!controller.signal.aborted) setError("Username lookup is unavailable. Try again later or paste the public wallet.");
    } finally {
      if (!controller.signal.aborted) setLooking(false);
    }
  }
  const profile = identity?.handle || handle;
  const walletReady = lookup?.state === "matched" && isMint(wallet.trim());
  const selectionBlocked = !active || (looking && !walletReady) || lookup?.state === "conflict";
  function selectWallet() {
    if (selectionBlocked) return;
    const selected = wallet.trim();
    if (!handle || !isMint(selected)) {
      setError(purpose === "owner" ? "Enter your public Solana wallet address." : purpose === "recipient" ? "Enter your friend’s public Solana wallet address." : "Enter the trader's public Solana wallet address.");
      return;
    }
    request.current?.abort();
    setLooking(false);
    onChange(selected, { source: "user-selected", handle, address: selected, selectedAt: Date.now() });
  }
  return (
    <div className="fomo-leader-picker">
      <label className="field">
        <span>{purpose === "owner" ? "Your Fomo username or wallet" : "Fomo username or wallet"}</span>
        <input
          ref={inputRef}
          aria-label={purpose === "owner" ? "Your Fomo wallet address" : purpose === "recipient" ? "Friend’s Fomo username or wallet" : "Leader wallet address"}
          aria-describedby="fomo-leader-help"
          placeholder="@username, Fomo profile link, or Solana address"
          value={address}
          disabled={!active}
          maxLength={200}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          required
        />
        <small id="fomo-leader-help" className="copy-help">
          {purpose === "owner" ? "Find your Fomo username, or paste your existing public Solana address." : purpose === "recipient" ? "Find your friend by Fomo username, or paste their public Solana wallet." : "Find a trader by Fomo username, or paste their public Solana wallet."}
        </small>
      </label>
      {profile && (
        <section className="fomo-identity-card" aria-label="Fomo profile and wallet">
          <div className="fomo-identity-heading">
            <strong>@{profile}</strong>
            <a className="word-link" href={fomoProfileUrl(profile)} target="_blank" rel="noreferrer">
              Open on Fomo <ArrowUpRight size={13} />
            </a>
          </div>
          {identity ? (
            <>
              <p className="fomo-identity-address">{identity.address}</p>
              <p className="copy-help">{purpose === "recipient" ? "Payments go to this exact wallet. Confirm it with your friend before sending." : "Profile link supplied by you. This plan follows the selected wallet; the profile association is not verified."}</p>
            </>
          ) : (
            <>
              <button type="button" className="button secondary full" disabled={!active || looking} onClick={() => void findWallet()}>
                {looking ? walletReady ? "Updating profile…" : "Finding wallet…" : "Find wallet"}
              </button>
              {lookup ? <FomoRecipientCard profile={lookup} purpose="wallet" confirmed={false} onConfirm={()=>{}} onRetry={()=>void findWallet()} busy={looking}/> : <p className="copy-help">{purpose === "owner" ? "Look up your wallet, or copy its public address from Fomo." : "Look up their wallet, or paste it from their Fomo profile."}</p>}
              <label className="field">
                <span>{purpose === "owner" ? "Your Solana wallet" : purpose === "recipient" ? "Friend’s Solana wallet" : "Trader's Solana wallet"}</span>
                <input
                  aria-label={purpose === "owner" ? "Your Solana address" : "Fomo trader Solana wallet"}
                  placeholder="Paste the public trading address"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={64}
                  value={wallet}
                  onChange={(event) => { request.current?.abort(); setLooking(false); setLookup(null); setWallet(event.target.value); setError(""); }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") { event.preventDefault(); selectWallet(); }
                  }}
                />
              </label>
              {error && <p className="error-message" role="alert">{error}</p>}
              <button type="button" className="button secondary full" disabled={selectionBlocked} onClick={selectWallet}>
                Use this wallet
              </button>
              <p className="copy-help">{purpose === "owner" ? "The import must match the exact address you confirm." : purpose === "recipient" ? "Confirm the receiving wallet before sending. Your wallet reviews every payment." : "Your plan follows the exact wallet you confirm. A profile match does not authorize trading."}</p>
            </>
          )}
        </section>
      )}
      {isMint(address.trim()) && !identity && (
        <p className="copy-help">Public wallet entered directly. No Fomo profile is attached.</p>
      )}
    </div>
  );
}
