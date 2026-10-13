import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { useWalletSetup } from "./WalletSetup";
import { isMint } from "./assets";
import { displayUnits } from "./funding-model";
import { associated } from "./transaction-review";
import { USDC } from "./funding-model";
import { cardAddresses, validMerchantId, type CardWalletSnapshot } from "./card-allowance";

export async function checkedSnapshot(data: CardWalletSnapshot, wallet: string) {
  const raw = (s: unknown) => typeof s === "string" && /^(0|[1-9]\d{0,19})$/.test(s) && BigInt(s) <= 18446744073709551615n;
  if (!data || data.wallet !== wallet || data.source !== await associated(wallet, USDC) ||
      !["missing", "ready", "frozen"].includes(data.account) || !Number.isSafeInteger(data.slot) || data.slot < 0 ||
      !Number.isSafeInteger(data.fetchedAt) || Math.abs(Date.now() - data.fetchedAt) > 60000 ||
      ![data.solLamports, data.usdcRaw, data.allowanceRaw].every(raw) ||
      !(data.delegate === null || isMint(data.delegate)) || typeof data.cardRegistered !== "boolean") throw Error("The wallet response could not be verified.");
  if (data.merchantId === null) {
    if (data.cardDelegate !== null || data.cardRegistered) throw Error("Unexpected card configuration.");
  } else if (!validMerchantId(data.merchantId) || data.cardDelegate !== (await cardAddresses(wallet, data.merchantId)).delegate) throw Error("Unexpected card delegate.");
  return data;
}
export function PayWallet() {
  const { connection, openConnect } = useWalletSetup();
  const [wallet, setWallet] = useState(connection.session?.address || ""), [data, setData] = useState<CardWalletSnapshot | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  function change(value: string) { controller.current?.abort(); setWallet(value); setData(null); setError(""); setBusy(false); }
  async function read() {
    if (!isMint(wallet) || busy) return;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError(""); setData(null);
    try {
      const result = await fetch(`/api/pay-wallet?wallet=${encodeURIComponent(wallet)}`, { cache: "no-store", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(12000)]) });
      const body = await result.json();
      if (!result.ok) throw Error(typeof body.message === "string" ? body.message : "Wallet check is unavailable.");
      const snapshot = await checkedSnapshot(body, wallet);
      if (!abort.signal.aborted) setData(snapshot);
    } catch (e) { if (!abort.signal.aborted) setError(e instanceof Error && e.name !== "TimeoutError" ? e.message : "Wallet check timed out. Try again."); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  }
  const matching = data?.cardDelegate && data.delegate === data.cardDelegate;
  return <section className="pay-wallet-page">
    <a className="word-link" href="#pay"><ArrowLeft size={15} /> Back to Pay</a>
    <header><h1>Your wallet funds Pay.</h1><p>Pay for gift cards, reimburse a split or treat a friend with USDC. Keep SOL for network fees.</p></header>
    <section className="pay-wallet-panel" aria-label="Wallet funding">
      <label className="field"><span>Solana wallet address</span><input value={wallet} autoComplete="off" spellCheck={false} maxLength={44} onChange={e => change(e.target.value.trim())} placeholder="Your existing Fomo wallet" /></label>
      <div className="pay-request-actions">
        <button className="button primary" disabled={busy || !isMint(wallet)} onClick={() => void read()}>{busy ? "Checking wallet…" : "Check wallet funding"}</button>
        {connection.session && <button className="word-link" onClick={() => change(connection.session!.address)}>Use connected wallet</button>}
        {!connection.session && <button className="word-link" onClick={openConnect}>Connect wallet</button>}
      </div>
      <p className="pay-note">Read-only. A public address shows balances, not ownership or permission to spend.</p>
      {error && <p role="alert" className="form-error">{error}</p>}
      {data && <div aria-live="polite">
        <div className="pay-wallet-balance"><strong>{displayUnits(data.usdcRaw, 6)}</strong><span>USDC in this wallet</span></div>
        <dl className="pay-details">
          <div><dt>Network fees</dt><dd>{displayUnits(data.solLamports, 9)} SOL</dd></div>
          <div><dt>USDC account</dt><dd>{data.account === "missing" ? "Not created" : data.account === "frozen" ? "Frozen" : "Active"}</dd></div>
          <div><dt>Card program</dt><dd>{data.merchantId === null ? "Awaiting provider activation" : data.cardRegistered ? "Delegate registered on Solana" : "No registered card delegate"}</dd></div>
          <div><dt>Card allowance remaining</dt><dd>{matching ? `${displayUnits(data.allowanceRaw, 6)} USDC` : "No verified card allowance"}</dd></div>
        </dl>
        {data.delegate && !matching && <p className="pay-note">This USDC account has a different or unverified token delegate. Fub will not overwrite it.</p>}
        <p className="pay-note">This is the onchain token balance, not an available card balance. Card authorization holds and settlement need the issuer’s records.</p>
        <a className="word-link" href={`https://solscan.io/account/${data.source}`} target="_blank" rel="noreferrer">View USDC account <ArrowUpRight size={14} /></a>
      </div>}
    </section>
    <a className="word-link" href="#pay/history">Your card history <ArrowUpRight size={14} /></a>
    <section className="pay-wallet-panel"><h2>How card access works</h2>
      <ol><li>Verify your identity with the card provider and link this wallet.</li><li>Approve a fixed USDC allowance for the card program.</li><li>Card purchases draw USDC from the same wallet. Revoke the allowance to stop future draws.</li></ol>
      <p className="pay-note">An allowance is a total remaining amount, not a monthly limit. It can apply to later deposits and stays active until used, replaced or revoked. It does not reserve funds from trading, and revocation does not reverse prior purchases.</p>
      <p className="pay-note">Card issuing is not active yet. Bridge’s documented Solana funding path is the integration target; approval and a merchant ID are still required.</p>
    </section>
  </section>;
}
