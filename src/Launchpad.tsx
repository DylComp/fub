import {finishTask} from "./task-completion";
import {LaunchFlow} from "./LaunchFlow";
import { SOL_PAIR_MINT } from "./launch-pairs";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ArrowUpRight, ArrowRight, ImagePlus, Check, X } from "lucide-react";
import { Modal } from "./ui";
import { fomoHandle, validFomoLookup } from "./fomo-identity";
import type { FomoLookup } from "./fomo-identity";
import { validFomoRecipient } from "./fomo-recipient";
import type { FomoRecipient } from "./fomo-recipient";
import { FomoRecipientCard } from "./FomoRecipientCard";
import { confirmedLaunchRecipient, emptyLaunch, launchDraft, launchShares, LAUNCH_DRAFT_KEY } from "./launch-model";
import type { LaunchDraft } from "./launch-model";
import { launchAuthorization, launchHash, publicationPayload, validPublishedLaunch } from "./launch-publication";
import type { PublishedLaunch } from "./launch-publication";
import type { WalletConnection } from "./useWallet";
import "./launchpad.css";
import { LaunchExecutionPanel } from "./LaunchExecutionPanel";
import { LaunchTableSetup } from "./LaunchTableSetup";
const GraduatedSetup = lazy(() => import('./GraduatedSetup').then(m => ({default:m.GraduatedSetup})));
const BuybackSetup = lazy(() => import('./BuybackSetup').then(m => ({default:m.BuybackSetup})));
import { LaunchHistory } from "./LaunchHistory";
type Review = { recipient: string; handle: string; split: { address: string; shareBps: number }[] | null; blockers: string[]; executable: boolean; metadataUrl?: string };
function solDraft(draft: LaunchDraft): LaunchDraft {
  // Never reinterpret a saved amount in another asset as SOL.
  const { quoteMint, ...fields } = draft;
  return { ...fields, website: "", initialBuy: quoteMint && quoteMint !== SOL_PAIR_MINT ? "" : draft.initialBuy };
}
function restored(): LaunchDraft {
  try { const r = JSON.parse(localStorage.getItem(LAUNCH_DRAFT_KEY) || "null");
    if (r && Object.keys(emptyLaunch).every(k => typeof r[k] === "string" && r[k].length <= 1000)) return solDraft({ ...Object.fromEntries(Object.keys(emptyLaunch).map(k => [k, r[k]])), ...(typeof r.quoteMint === "string" ? {quoteMint:r.quoteMint} : {}) } as LaunchDraft);
  } catch { /* An unavailable draft never prevents a new launch. */ }
  return { ...emptyLaunch };
}
export function Launchpad({ connection, onConnect }: { connection: WalletConnection; onConnect: () => void }) {
  const [launching,setLaunching]=useState(false);
  const [draft, setDraft] = useState(restored), [lookup, setLookup] = useState<FomoRecipient | null>(null);
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [image, setImage] = useState<{ url: string; name: string; type: string; bytes: number; file: File } | null>(null);
  const [review, setReview] = useState<Review | null>(null), [saved, setSaved] = useState("");
  const [publication, setPublication] = useState<PublishedLaunch | null>(null), [publications, setPublications] = useState<PublishedLaunch[]>([]);
  const request = useRef<AbortController | null>(null), imageGeneration = useRef(0);
  useEffect(() => { request.current?.abort(); setBusy(false); setPublication(null); setPublications([]); setReview(null); setLaunching(false); }, [connection.session?.address]);
  useEffect(() => () => { request.current?.abort(); imageGeneration.current++; }, []);
  useEffect(() => () => { if (image) URL.revokeObjectURL(image.url); }, [image]);
  useEffect(() => {
    if (busy || !lookup || (lookup.state !== 'pending' && !lookup.profilePending) || lookup.handle !== fomoHandle(draft.handle)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetch(`/api/wallet?action=recipient&handle=${encodeURIComponent(lookup.handle)}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) })
        .then(async response => {
          if (!response.ok) throw Error('Wallet lookup is paused. Check again shortly.');
          const next: unknown = await response.json();
          if (!validFomoRecipient(next, lookup.handle)) throw Error('The profile response did not match this username.');
          if (!controller.signal.aborted) { setLookup(next); setConfirmed(false); setReview(null); }
        }).catch(e => { if (!controller.signal.aborted) { setError(e instanceof Error ? e.message : 'Lookup unavailable.'); setLookup(null); } });
    }, Math.max(5, lookup.retryAfter || 30) * 1000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [lookup, draft.handle, busy]);
  function update(key: keyof LaunchDraft, value: string) {
    request.current?.abort(); setBusy(false); setError(""); setReview(null); setSaved(""); setPublication(null);
    if (key === "handle") { setLookup(null); setConfirmed(false); }
    setDraft(d => ({ ...d, [key]: value }));
  }
  async function findRecipient() {
    const handle = fomoHandle(draft.handle);
    if (!handle) { setError("Enter a Fomo username or profile link."); return; }
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(""); setLookup(null); setConfirmed(false);
    try {
      const response = await fetch(`/api/wallet?action=recipient&handle=${encodeURIComponent(handle)}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
      const data: unknown = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok) throw Error(response.status === 404 ? "No profile found. Check the username or paste their Fomo profile link." : response.status === 429 ? "Too many lookups. Try again in a minute." : "Profile lookup is temporarily unavailable. Try again shortly.");
      if (!validFomoRecipient(data, handle)) throw Error("The profile response did not match this username. Try again.");
      setLookup(data);
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Lookup unavailable."); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  async function chooseImage(file?: File) {
    const generation = ++imageGeneration.current; request.current?.abort(); setBusy(false); setReview(null); setError(""); setPublication(null);
    if (!file) return;
    let url = "";
    try {
      if (!["image/png", "image/jpeg", "image/gif"].includes(file.type) || file.size > 2 * 1024 * 1024 || !file.size) throw Error("Choose a PNG, JPG or GIF up to 2 MB.");
      const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      const format = b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71 ? "image/png" : b[0] === 255 && b[1] === 216 && b[2] === 255 ? "image/jpeg" : String.fromCharCode(...b.slice(0, 6)).match(/^GIF8[79]a$/) ? "image/gif" : "";
      if (format !== file.type) throw Error("The file contents do not match its image type.");
      url = URL.createObjectURL(file); const img = new Image(); img.src = url; await img.decode();
      if (img.naturalWidth !== img.naturalHeight || img.naturalWidth < 64 || img.naturalWidth > 4096) throw Error("Use a square image, 64–4096 pixels wide.");
      if (generation !== imageGeneration.current) { URL.revokeObjectURL(url); return; }
      setImage({ url, name: file.name, type: file.type, bytes: file.size, file });
    } catch (e) { if (url) URL.revokeObjectURL(url); if (generation === imageGeneration.current) { setImage(null); setError(e instanceof Error ? e.message : "Could not load image."); } }
  }
  async function prepare() {
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    setError(""); setSaved("");
    try {
      const d = launchDraft(draft);
      if (!image) throw Error("Choose the token image.");
      if (!confirmed || !lookup || !validFomoLookup(lookup, d.handle)) throw Error("Find and confirm the Fomo recipient first.");
      confirmedLaunchRecipient(d, lookup as FomoLookup);
      setBusy(true);
      const response = await fetch("/api/launch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draft: d, recipient: lookup.address, ...(publication && publication.owner === connection.session?.address ? { publicationId: publication.id, wallet: publication.owner } : {}) }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
      const data = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok) throw Error(data.message || "Launch review unavailable.");
      if (typeof data.executable !== "boolean" || data.handle !== d.handle || data.recipient !== lookup.address || !Array.isArray(data.blockers)) throw Error("Invalid launch review.");
      if(data.split!==null&&(!Array.isArray(data.split)||data.split.length!==2||data.split[0].address!==lookup.address||data.split[0].shareBps!==8000||data.split[1].shareBps!==2000))throw Error("Invalid fee split.");
      if(data.split)launchShares(data.split[0].address,data.split[1].address);
      if(data.executable&&(!publication||!data.split||data.blockers.length))throw Error("Launch setup is incomplete.");
      setReview(data);
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Launch review unavailable."); }
    finally { if (request.current === controller && !controller.signal.aborted) setBusy(false); }
  }
  async function publishOrLoad(action: "publish" | "list") {
    const wallet = connection.session?.address;
    if (!wallet) { onConnect(); return; }
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(""); setSaved("");
    try {
      let payload: object = {}, signedPayload = "{}";
      if (action === "publish") {
        const d = launchDraft(draft);
        if (!image || !confirmed || !lookup || !validFomoLookup(lookup, d.handle)) throw Error("Choose an image and confirm the Fomo recipient first.");
        confirmedLaunchRecipient(d, lookup as FomoLookup);
        const bytes = new Uint8Array(await image.file.arrayBuffer());
        signedPayload = publicationPayload({ draft: d, recipient: lookup.address, imageHash: await launchHash(bytes), imageType: image.type, imageBytes: bytes.length });
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        payload = { draft: d, recipient: lookup.address, image: { type: image.type, data: btoa(binary) } };
      }
      const authorization = await launchAuthorization(action, wallet, signedPayload);
      controller.signal.throwIfAborted();
      const signature = await connection.signLaunchAuthorization(authorization);
      controller.signal.throwIfAborted();
      const response = await fetch("/api/launch-assets", { method: "POST", headers: { "Content-Type": "application/json", "X-Fomo-Request": "1" },
        body: JSON.stringify({ authorization, signature, payload }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
      const data = await response.json().catch(() => {
        throw Error("Draft storage did not respond. Your coin has not been launched. Load saved drafts before trying again.");
      });
      controller.signal.throwIfAborted();
      if (!response.ok) throw Error(data.message || "Draft storage unavailable.");
      if (action === "publish") {
        if (!validPublishedLaunch(data.publication, wallet)) throw Error("Invalid saved draft response.");
        setPublication(data.publication); setReview(null);
        setSaved("Image and metadata published. Launch draft saved to your wallet. No coin has been created.");
      } else {
        if (!Array.isArray(data.publications) || data.publications.length > 20 || !data.publications.every((p: unknown) => validPublishedLaunch(p, wallet))) throw Error("Invalid saved draft response.");
        setPublications(data.publications); if (!data.publications.length) setSaved("No published drafts for this wallet yet.");
      }
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Draft storage unavailable."); }
    finally { if (request.current === controller && !controller.signal.aborted) setBusy(false); }
  }
  async function restorePublished(p: PublishedLaunch) {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    imageGeneration.current++; setBusy(true); setError("");
    try {
      if (!validPublishedLaunch(p, connection.session?.address || "")) throw Error("Connect the wallet that saved this draft.");
      const response = await fetch(p.imageUrl, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
      if (!response.ok || Number(response.headers.get("content-length")) > 2097152) throw Error("Saved image unavailable.");
      const blob = await response.blob(), bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes.length > 2097152 || await launchHash(bytes) !== p.imageHash || !["image/png", "image/jpeg", "image/gif"].includes(blob.type)) throw Error("Saved image failed its integrity check.");
      controller.signal.throwIfAborted();
      const file = new File([blob], "saved-coin-image", { type: blob.type });
      setImage({ file, name: file.name, url: URL.createObjectURL(file), type: blob.type, bytes: file.size });
      const next = solDraft(p.draft);
      const changed = JSON.stringify(next) !== JSON.stringify(p.draft);
      setDraft(next); setLookup(null); setConfirmed(false); setReview(null); setPublication(changed ? null : p);
      setSaved(p.draft.quoteMint && p.draft.quoteMint !== SOL_PAIR_MINT ? "Draft restored for a SOL launch. Enter a new initial buy amount and confirm the recipient." : "Draft restored. Find and confirm the recipient again before reviewing.");
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Could not restore draft."); }
    finally { if (request.current === controller && !controller.signal.aborted) setBusy(false); }
  }
  function startLaunch(){
    setError('');setSaved('');
    if(!connection.session){onConnect();return;}
    try{const d=launchDraft(draft);if(!image)throw Error('Choose the token image.');if(!confirmed||!lookup)throw Error('Find and confirm the Fomo recipient first.');confirmedLaunchRecipient(d,lookup as FomoLookup);setLaunching(true);}catch(e){setError(e instanceof Error?e.message:'Check your coin details.');}
  }
  if (new URLSearchParams(window.location.search).get("setup") === "launch-table") return <LaunchTableSetup/>;
  if (new URLSearchParams(window.location.search).get("setup") === "graduated") return <Suspense fallback={<p role="status">Loading approved setup…</p>}><GraduatedSetup connection={connection} onConnect={onConnect}/></Suspense>;
  if (new URLSearchParams(window.location.search).get("setup") === "buyback") return <Suspense fallback={<p role="status">Loading treasury setup…</p>}><BuybackSetup connection={connection} onConnect={onConnect}/></Suspense>;
  return <section className="launchpad" aria-label="Launch a coin">
    <form className="launch-form" onSubmit={e => { e.preventDefault(); startLaunch(); }}>
      <div className="launch-section-title"><span>01</span><h2>The recipient</h2></div>
      <label className="field"><span>Fomo username</span><div className="launch-recipient-input"><input aria-label="Recipient Fomo username" placeholder="@username" value={draft.handle} onChange={e => update("handle", e.target.value)} maxLength={200} autoComplete="off" spellCheck={false} required /><button className="word-link" type="button" disabled={busy} onClick={() => void findRecipient()}>{busy ? "Checking…" : "Find wallet"}<ArrowRight size={16}/></button></div></label>
      {lookup && <FomoRecipientCard key={lookup.handle + lookup.fetchedAt} profile={lookup} confirmed={confirmed} onConfirm={value => { request.current?.abort(); setBusy(false); setConfirmed(value); setReview(null); }} onRetry={() => void findRecipient()} busy={busy}/>}
      <div className="launch-section-title"><span>02</span><h2>The coin</h2></div>
      <div className="launch-image-row"><label className="launch-image"><input type="file" accept="image/png,image/jpeg,image/gif" aria-label="Token image" onChange={e => { void chooseImage(e.target.files?.[0]); e.target.value = ""; }}/>{image ? <img src={image.url} alt="Token image preview"/> : <ImagePlus size={24}/>}</label><div><strong>Token image <span aria-hidden="true">*</span></strong><p>PNG, JPG or GIF · square · up to 2 MB</p>{image && <button type="button" className="word-link" onClick={() => { imageGeneration.current++; request.current?.abort(); setBusy(false); setImage(null); setReview(null); setPublication(null); }}><X size={13}/> Remove</button>}</div></div>
      <div className="launch-two-fields"><label className="field"><span>Name *</span><input aria-label="Token name" value={draft.name} maxLength={32} onChange={e => update("name", e.target.value)} placeholder="Your coin" required/></label><label className="field"><span>Ticker *</span><input aria-label="Token ticker" value={draft.ticker} maxLength={10} onChange={e => update("ticker", e.target.value.toUpperCase())} placeholder="COIN" required/></label></div>
      <label className="field"><span>Description <small>optional</small><small className="launch-count">{draft.description.length}/1000</small></span><textarea aria-label="Token description" rows={3} maxLength={1000} value={draft.description} onChange={e => update("description", e.target.value)}/></label>
      <div className="launch-socials">{([['twitter','X / Twitter'],['telegram','Telegram']] as const).map(([key,label]) => <label className="field" key={key}><span>{label} <small>optional</small></span><input aria-label={label} type="url" placeholder="https://" maxLength={200} value={draft[key]} onChange={e => update(key, e.target.value)}/></label>)}</div>
      <div className="launch-section-title"><span>03</span><h2>Initial buy <small>optional</small></h2></div>
      <p className="copy-help">Buy in the transaction that creates the coin. No other transaction can trade between its creation and your buy.</p>
      <label className="field launch-buy"><span>Amount in SOL</span><div className="input-shell"><input aria-label="Initial buy in SOL" inputMode="decimal" placeholder="0" value={draft.initialBuy} onChange={e => update("initialBuy",e.target.value)} maxLength={40}/><span>SOL</span></div><small>Creation, account rent and network fees are additional.</small></label>
      {error && <p className="error-message" role="alert">{error}</p>}
      <div className="launch-actions"><button type="submit" className="button primary" disabled={busy}>{busy ? "Checking…" : "Launch with SOL"} <ArrowRight size={16}/></button><button type="button" className="word-link" onClick={() => { try { localStorage.setItem(LAUNCH_DRAFT_KEY,JSON.stringify(draft)); setSaved("Draft saved on this device. Choose the image again after reopening."); } catch { setError("Browser storage is unavailable."); } }}>Save draft</button></div>
      <p className="copy-help">Your coin’s website links to its token page on Fub.</p><details className="launch-advanced"><summary>Saved drafts and recovery</summary><button type="button" className="word-link" disabled={busy} onClick={()=>void prepare()}>Review saved launch</button><div className="launch-publication-actions"><button type="button" className="word-link" disabled={busy} onClick={() => void publishOrLoad("publish")}>Publish image &amp; save</button><button type="button" className="word-link" disabled={busy} onClick={() => void publishOrLoad("list")}>Load saved drafts</button></div>
      <p className="copy-help">Publishing makes the image and coin metadata public. A wallet signature saves the draft without launching the coin or moving funds.</p>
      {publication && <p className="copy-help"><a className="word-link" href={publication.metadataUrl} target="_blank" rel="noreferrer">View published metadata <ArrowUpRight size={13}/></a></p>}
      {publications.length > 0 && <div className="launch-saved-list" aria-label="Saved launch drafts">{publications.map(p => <div key={p.id}><span><strong>{p.draft.name}</strong> · {p.draft.ticker}<small>@{p.draft.handle}</small></span><button type="button" className="word-link" disabled={busy} onClick={() => void restorePublished(p)}>Restore</button></div>)}</div>}
      </details>{saved && <p className="copy-help" role="status">{saved}</p>}
    </form>
    <aside className="launch-summary"><div className="launch-coin-preview">{image ? <img src={image.url} alt=""/> : <div className="launch-empty-image"/>}<div><h2>{draft.name.trim() || "Your coin"}</h2><p>{draft.ticker || "TICKER"}</p></div></div><p className="launch-summary-label">CREATOR FEE SPLIT</p><div className="launch-split-bar"><span/><span/></div><div className="launch-allocation"><div><strong>80<span>%</span></strong><p>{lookup && confirmed ? `@${lookup.handle}` : "Fomo recipient"}</p></div><div><strong>20<span>%</span></strong><p>Fub treasury</p></div></div><p className="copy-help">The treasury receives fees before the official Fub token launches. Buybacks begin after its mint is configured. The split applies to creator fees, not the initial buy or all trading fees. The payout worker checks fee vaults every minute and distributes when at least 0.003 SOL is available.</p><div className="launch-facts"><p><Check size={15}/> Same split for every launch</p><p><Check size={15}/> Recipient keeps their Fomo wallet</p><p><Check size={15}/> Recipient does not need to sign up</p></div><p className="launch-readiness">Confirm the recipient and approve the launch in your wallet.</p><a className="word-link" href="https://pump.fun" target="_blank" rel="noreferrer">Pump.fun · Solana <ArrowUpRight size={14}/></a></aside>
    {launching&&image&&lookup&&<LaunchFlow draft={launchDraft(draft)} image={image.file} recipient={lookup.address!} publication={publication} connection={connection} onPublished={setPublication} onComplete={()=>{setDraft({...emptyLaunch});setImage(null);setLookup(null);setConfirmed(false);setReview(null);setPublication(null);setError('');setSaved('Launch completed. Your coin is listed in Tokens.');try{localStorage.removeItem(LAUNCH_DRAFT_KEY);}catch{/* Confirmation remains valid if local storage is unavailable. */}window.dispatchEvent(new Event('fub-launch-confirmed'));finishTask({message:'Launch completed. Your coin is listed in Tokens.',destination:'#launch'});}} close={()=>setLaunching(false)}/>}
    <LaunchHistory connection={connection} onConnect={onConnect} />
    {review && <Modal title="Review your launch." close={() => setReview(null)}><div className="launch-review"><h3>{draft.name} <span>{draft.ticker}</span></h3><p>80% of creator fees to @{review.handle}</p><p className="launch-address">{review.recipient}</p><p>20% to the Fub treasury for buying and burning Fub</p>{review.split && <p className="launch-address">{review.split[1].address}</p>}<p className="copy-help">A fresh server lookup matched the recipient. No coin has been created and no funds have moved.</p>{review.metadataUrl && <p><a className="word-link" href={review.metadataUrl} target="_blank" rel="noreferrer">Verified published metadata <ArrowUpRight size={13}/></a></p>}{review.blockers.length>0&&<div className="launch-blockers"><h4>Before this launch can go live</h4><ul>{review.blockers.map(text => <li key={text}>{text}</li>)}</ul></div>}{review.executable&&publication&&review.split?.length===2&&<LaunchExecutionPanel publication={publication} buybackWallet={review.split[1].address} connection={connection}/>}<button className="button secondary full" onClick={() => setReview(null)}>Back to coin</button></div></Modal>}
  </section>;
}
