import { useEffect, useRef, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import type { WalletConnection } from "./useWallet";
import { triggerRequest } from "./trigger-api";
import type { TriggerSession } from "./live-orders";
import { validChallenge } from "./live-orders";
import { fomoProfileUrl, validFomoWalletProof } from "./fomo-identity";
import type { FomoWalletProof } from "./fomo-identity";

export function FomoWalletProfile({ connection, address }: { connection: WalletConnection; address: string }) {
  const [proof, setProof] = useState<FomoWalletProof | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!proof) return;
    const checking = new AbortController();
    const expire = () => { setProof(null); setError("Wallet verification expired. Verify again to refresh the match."); };
    const timer = setTimeout(expire, Math.max(0, proof.expiresAt - Date.now()));
    // Discard a displayed proof when another view logs out the same wallet.
    const onFocus = async () => {
      try {
        const session = await triggerRequest<TriggerSession>("session", undefined, undefined, checking.signal);
        if (!checking.signal.aborted && (session.address !== address || session.expiresAt !== proof.expiresAt)) expire();
      } catch { if (!checking.signal.aborted) expire(); }
    };
    window.addEventListener("focus", onFocus);
    return () => { checking.abort(); clearTimeout(timer); window.removeEventListener("focus", onFocus); };
  }, [proof, address]);
  async function check() {
    if (pending) return;
    const active = new AbortController();
    controller.current?.abort(); controller.current = active;
    setPending(true); setError(""); setProof(null);
    try {
      let session = await triggerRequest<TriggerSession>("session", undefined, undefined, active.signal);
      if (active.signal.aborted) return;
      if (!session.configured) throw new Error("Wallet verification is unavailable. Try again later.");
      if (session.address !== address || !session.csrf || !session.expiresAt || session.expiresAt <= Date.now()) {
        const challenge = await triggerRequest<{ wallet: string; message: string }>("challenge", { wallet: address }, undefined, active.signal);
        if (active.signal.aborted) return;
        if (challenge.wallet !== address || !validChallenge(challenge.message, address)) throw new Error("The wallet login message could not be verified.");
        const signature = await connection.signTriggerChallenge(challenge.message, address);
        if (active.signal.aborted) return;
        session = await triggerRequest<TriggerSession>("verify", { wallet: address, signature }, undefined, active.signal);
      }
      if (active.signal.aborted) return;
      if (session.address !== address || !session.csrf || !session.expiresAt || session.expiresAt <= Date.now()) throw new Error("Wallet verification did not complete.");
      const result = await triggerRequest<unknown>("fomo-profile", { wallet: address }, session.csrf, active.signal);
      if (active.signal.aborted) return;
      if (!validFomoWalletProof(result, address)) throw new Error("The profile result did not match this wallet. Try again.");
      setProof(result);
    } catch (failure) {
      if (!active.signal.aborted) setError(failure instanceof Error ? failure.message : "Wallet verification did not complete.");
    } finally { if (!active.signal.aborted) setPending(false); }
  }
  return <section className="fomo-identity-card" aria-label="Your Fomo profile">
    <div className="fomo-identity-heading"><strong>Your Fomo profile</strong></div>
    <p className="copy-help">Verify control of this wallet, then find its matched Fomo username. The signature uses our Jupiter wallet login and does not authorize a trade.</p>
    {proof && <div role="status">
      <p className="wallet-notice">Wallet signature verified.</p>
      {proof.profiles.length === 0 ? <p className="copy-help">No Fomo profile was found for this address. You can still use this wallet.</p> : <>
        {proof.profiles.length > 1 && <p className="copy-help">Multiple profiles match this wallet. No primary profile has been selected.</p>}
        {proof.profiles.map(profile => <div key={profile.handle}>
          <a className="word-link" href={fomoProfileUrl(profile.handle)} target="_blank" rel="noreferrer">@{profile.handle} <ArrowUpRight size={13} /></a>
          <p className="copy-help">{profile.observedAt ? `Profile checked ${new Date(profile.observedAt).toLocaleDateString()}.` : "Profile check date unavailable."}</p>
        </div>)}
        <p className="copy-help">Profile matches use Fub’s checked Fomo records or the independent fomoapi.dev index. Your signature verifies wallet ownership.</p>
      </>}
    </div>}
    {error && <p role="alert" className="error-message">{error}</p>}
    <button type="button" className="button secondary full" disabled={pending} onClick={() => void check()}>{pending ? "Checking wallet…" : proof ? "Refresh profile match" : "Verify wallet and find profile"}</button>
  </section>;
}
