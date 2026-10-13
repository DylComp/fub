import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useWalletSetup } from "./WalletSetup";
import { payHistoryAuthorization } from "./pay-history-auth";
import { validPayRecord, payStatementTotals, type PayRecord, type PayStatement } from "./pay-ledger-model";
function money(raw: string) { const n = BigInt(raw), abs = n < 0n ? -n : n;return `${n < 0n ? "−" : ""}$${(abs / 100n).toLocaleString("en-US")}.${String(abs % 100n).padStart(2,"0")}`; }
function label(r: PayRecord) {
  if (r.kind === "transaction") return r.status === "capture" ? "Purchase" : BigInt(r.amount) >= 0n ? "Refund recorded" : "Refund reversed";
  if (!r.approved) return "Not approved";
  return { pending: "Authorized", closed: "Authorization closed", expired: "Authorization expired", reversed: "Authorization reversed" }[r.status as "pending"|"closed"|"expired"|"reversed"];
}
export function PayHistory() {
  const { connection } = useWalletSetup();
  const [available, setAvailable] = useState<boolean | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [report, setReport] = useState<PayStatement | null>(null);
  const request = useRef<AbortController | null>(null), owner = connection.session?.address;
  useEffect(() => { const abort = new AbortController(); void fetch("/api/pay-history", { cache: "no-store", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]) }).then(async r => { if (!r.ok) throw Error(); const b = await r.json(); if (typeof b.available !== "boolean") throw Error(); if (!abort.signal.aborted) setAvailable(b.available); }).catch(() => { if (!abort.signal.aborted) { setAvailable(false); setError("Card history availability could not be checked."); } }); return () => abort.abort(); }, []);
  useEffect(() => { request.current?.abort(); setReport(null); setBusy(false); setError(""); return () => request.current?.abort(); }, [owner]);
  async function load() {
    if (!owner || busy || !available) return;
    request.current?.abort(); const abort = new AbortController(); request.current = abort; setBusy(true); setError(""); setReport(null);
    try {
      const authorization = payHistoryAuthorization(owner), signature = await connection.signPayHistory(authorization);
      if (abort.signal.aborted) return;
      const response = await fetch("/api/pay-history", { method: "POST", headers: { "Content-Type": "application/json", "X-Fomo-Request": "1" }, body: JSON.stringify({ authorization, signature }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]) });
      const result = await response.json(); if (abort.signal.aborted) return;
      if (!response.ok) throw Error(result.message || "Card history unavailable.");
      if (result.wallet !== owner || !Array.isArray(result.records) || result.records.length > 100 || !result.records.every(validPayRecord) ||
          typeof result.truncated !== "boolean" || !Number.isSafeInteger(result.pendingSync) || result.pendingSync < 0 || !Number.isSafeInteger(result.asOf) || Math.abs(Date.now()-result.asOf)>60000) throw Error("Card history response did not match this wallet.");
      payStatementTotals(result.records); setReport(result);
    } catch (e) { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "Card history unavailable."); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  }
  const current = report?.wallet === owner ? report : null, totals = current ? payStatementTotals(current.records) : null;
  return <section className="pay-wallet-page">
    <a className="word-link" href="#pay/card"><ArrowLeft size={15}/> Back to card</a>
    <header><h1>Your card purchases.</h1><p>Purchases, authorizations and refunds from your enrolled card. Only its wallet owner can open these records.</p></header>
    <section className="pay-wallet-panel">
      {available === false && !error && <p>Live card history will connect with the approved card program. Sample purchases in the Pay workspace are separate.</p>}
      {available === null && <p role="status">Checking card history…</p>}
      {available && !owner && <p>Connect your existing wallet to load its card history.</p>}
      <button className="button primary" disabled={!available || !owner || busy} onClick={() => void load()}>{busy ? "Loading card history…" : "Load card history"}</button>
      <p className="pay-note">The signature only permits a private history read. It does not approve spending.</p>
      {error && <p role="alert" className="form-error">{error}</p>}
      {current && totals && <>
        <div className="pay-history-totals"><div><span>Purchases</span><strong>{money(totals.purchases)}</strong></div><div><span>Refunds</span><strong>{money(totals.refunds)}</strong></div><div><span>Refund reversals</span><strong>{money(totals.refundReversals)}</strong></div></div>
        {current.truncated && <p className="pay-note">Showing the latest 100 records. Totals cover these records only.</p>}
        {current.pendingSync > 0 && <p role="status">Some records are waiting for a provider update.</p>}
        {current.records.length === 0 && <p>No card records linked to this wallet yet.</p>}
        <div className="pay-history-list">{current.records.map(r => <article key={r.id}><div><strong>{r.merchant}</strong><span>{label(r)} · {new Date(r.created * 1000).toLocaleDateString()}</span></div><strong>{money(r.kind === "transaction" && r.status === "capture" ? String(-BigInt(r.amount)) : r.amount)}</strong></article>)}</div>
        <p className="pay-note">Authorizations are not counted again as purchases. A refund recorded by the issuer does not prove that USDC has returned to your wallet. These records do not calculate an available card balance.</p>
      </>}
    </section>
  </section>;
}
