import { useEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { isMint } from "./assets";
import { fomoHandle } from "./fomo-identity";
import { validFomoRecipient, type FomoRecipient } from "./fomo-recipient";
import { FomoRecipientCard } from "./FomoRecipientCard";
import { FomoWalletOverview } from "./FomoWalletOverview";
import "./launchpad.css";

type Props = { address: string; connectedAddress?: string; onView: (address: string) => void; onConnect: () => void; onRefresh: () => void };
export function FomoWalletSearch({ address, connectedAddress, onView, onConnect, onRefresh }: Props) {
  const [input, setInput] = useState(address), [profile, setProfile] = useState<FomoRecipient | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const selected = useRef<FomoRecipient | null>(null);
  useEffect(() => {
    if (!address || selected.current?.address === address) return;
    request.current?.abort(); setBusy(false); setError(""); setProfile(null); selected.current = null; setInput(address);
  }, [address]);
  useEffect(() => () => request.current?.abort(), []);
  function edit(value: string) {
    request.current?.abort(); setBusy(false); setError(""); setProfile(null); selected.current = null; setInput(value);
  }
  async function find() {
    request.current?.abort(); setBusy(false); setError("");
    const value = input.trim();
    if (isMint(value)) {
      setProfile(null); selected.current = null;
      if (address === value) onRefresh(); else onView(value);
      return;
    }
    const handle = fomoHandle(value);
    if (!handle) { setError("Enter a Fomo username, profile link or public Solana address."); return; }
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setProfile(null); selected.current = null; onView("");
    const deadline = Date.now() + 180000;
    try {
      for (let attempt = 0; attempt < 19; attempt++) {
        const response = await fetch(`/api/wallet?action=recipient&handle=${encodeURIComponent(handle)}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) });
        const result: unknown = await response.json();
        if (controller.signal.aborted) return;
        if (!response.ok) throw Error(response.status === 404 ? "No profile match returned. Check the username or paste the public wallet address." : response.status === 429 ? "Too many lookups. Try again in a minute." : "Fomo lookup is unavailable. Try again or paste the public wallet address.");
        if (!validFomoRecipient(result, handle)) throw Error("The returned profile does not match this username. Try again.");
        setProfile(result); selected.current = result;
        if (result.state === "matched" && result.address) { onView(result.address); if (!result.profilePending) return; }
        if ((result.state !== "pending" && !result.profilePending) || attempt === 18 || Date.now() >= deadline) return;
        await new Promise<void>((resolve, reject) => {
          const stop = () => { clearTimeout(timer); reject(Error("Lookup cancelled")); };
          const timer = setTimeout(() => { controller.signal.removeEventListener("abort", stop); resolve(); }, Math.min(deadline - Date.now(), Math.max(5, result.retryAfter || 30) * 1000));
          controller.signal.addEventListener("abort", stop, { once: true });
        });
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Fomo lookup is unavailable.");
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <div className="fomo-wallet-search">
    <form className="wallet-lookup" onSubmit={event => { event.preventDefault(); void find(); }}>
      <label className="field"><span>Fomo username or wallet</span><input aria-label="Fomo username or wallet" value={input} onChange={event => edit(event.target.value)} maxLength={200} spellCheck={false} autoComplete="off" placeholder="@username, profile link or Solana address" required /></label>
      <button className="button primary" type="submit" disabled={busy}>{busy ? "Finding profile…" : "View wallet"}<ArrowRight size={15} /></button>
      {connectedAddress ? <button className="word-link" type="button" onClick={() => { edit(connectedAddress); if (address === connectedAddress) onRefresh(); else onView(connectedAddress); }}>Use connected wallet</button> : <button className="word-link" type="button" onClick={onConnect}>Connect my Fomo wallet</button>}
    </form>
    {error && <p className="error-message" role="alert">{error}</p>}
    {profile?.state === "matched" ? <FomoWalletOverview key={profile.handle} profile={profile} busy={busy} onRefresh={() => void find()} /> : profile && <FomoRecipientCard key={profile.handle} profile={profile} purpose="wallet" confirmed={false} onConfirm={() => {}} onRetry={() => void find()} busy={busy} />}
    <p className="wallet-scope">Search a Fomo profile to view its matched Solana wallet. No connection or signature needed to look.</p>
  </div>;
}
