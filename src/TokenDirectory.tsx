import {TokenPage} from "./TokenPage";
import {tokenKeyFromHash,tokenPagePath} from "./token-links";
import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  Search,
  UserRound,
  ArrowLeft,
  RefreshCw,
} from "lucide-react";
import { TokenEconomy } from "./TokenEconomy";
import { fomoProfileUrl } from "./fomo-identity";
import { directorySol, directoryUnits, validDirectory } from "./token-directory-model";
import type {
  DirectoryProfile,
  DirectoryAssetFees,
  DirectoryFees,
  DirectoryResult,
  DirectoryView,
} from "./token-directory-model";
import "./token-directory.css";
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
export function Avatar({ profile }: { profile: DirectoryProfile }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [profile.avatarUrl]);
  return (
    <span className="directory-avatar">
      {profile.avatarUrl && !broken ? (
        <img
          src={profile.avatarUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
        />
      ) : (
        <UserRound size={22} />
      )}
    </span>
  );
}
function AssetLabel({mint}:{mint:string}) {
 return mint==='So11111111111111111111111111111111111111112'?<small>SOL</small>:<a href={`https://solscan.io/token/${mint}`} target="_blank" rel="noreferrer" title={mint}><small>{short(mint)}</small></a>;
}
function AssetAmount({assets,field,fallback}:{assets?:DirectoryAssetFees[];field:'recipientSent'|'buybackSent'|'paid';fallback:string}) {
 return assets?.length?<>{assets.map(a=><span className="directory-asset-amount" key={a.mint}>{directoryUnits(a[field],a.decimals)} <AssetLabel mint={a.mint}/></span>)}</>:<>{directorySol(fallback)} <small>SOL</small></>;
}
export function Money({
  fees,
  profile = false,
}: {
  fees: DirectoryFees;
  profile?: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);
  const assets=fees.assets?.length?fees.assets:[{...fees,mint:"So11111111111111111111111111111111111111112",tokenProgram:"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",decimals:9}];
  return (
    <dl className="directory-money">
      <div>
        <dt>{profile ? "Received by profile" : "Sent to recipient"}</dt>
        <dd>
          <AssetAmount assets={fees.assets} field="recipientSent" fallback={fees.recipientSent}/>
        </dd>
      </div>
      <div>
        <dt>{"Total fees paid"}</dt>
        <dd>
          <AssetAmount assets={fees.assets} field="paid" fallback={fees.paid}/>
        </dd>
      </div>
      <div>
        <dt>Unclaimed creator fees</dt>
        <dd>
          {assets.map(a=><span className="directory-asset-amount" key={a.mint}>{a.pending===null||a.checkedAt===null||now-a.checkedAt>=120000?<><span className="directory-unknown">Not checked</span>{assets.length>1&&<> <AssetLabel mint={a.mint}/></>}</>:<>{directoryUnits(a.pending,a.decimals)} <AssetLabel mint={a.mint}/></>}</span>)}
        </dd>
      </div>
    </dl>
  );
}
export function TokenDirectory({ onLaunch }: { onLaunch: () => void }) {
  const [tokenKey,setTokenKey]=useState(()=>tokenKeyFromHash(location.hash));
  useEffect(()=>{const read=()=>setTokenKey(tokenKeyFromHash(location.hash));window.addEventListener('hashchange',read);return()=>window.removeEventListener('hashchange',read);},[]);
  const [view, setView] = useState<DirectoryView>("tokens"),
    [input, setInput] = useState(""),
    [q, setQ] = useState(""),
    [recipient, setRecipient] = useState<DirectoryProfile | null>(null),
    [cursor, setCursor] = useState<string | null>(null),
    [data, setData] = useState<DirectoryResult | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (input.trim() === q) return;
    const t = setTimeout(() => {
      setQ(input.trim());
      setCursor(null);
      setData(null);
    }, 250);
    return () => clearTimeout(t);
  }, [input, q]);
  useEffect(() => {
    if(tokenKey)return;
    const abort = new AbortController();
    setBusy(true);
    setError("");
    const params = new URLSearchParams({ view, q });
    if (recipient) params.set("recipient", recipient.wallet);
    if (cursor) params.set("cursor", cursor);
    void (async () => {
      try {
        const r = await fetch(`/api/token-directory?${params}`, {
          signal: abort.signal,
        });
        const d: unknown = await r.json();
        if (!r.ok || !validDirectory(d, view))
          throw Error("Token records are unavailable. Try again shortly.");
        if (!abort.signal.aborted)
          setData((previous) =>
            cursor && previous
              ? {
                  ...d,
                  tokens: [
                    ...previous.tokens,
                    ...d.tokens.filter(
                      (t) => !previous.tokens.some((p) => p.mint === t.mint),
                    ),
                  ],
                  profiles: [
                    ...previous.profiles,
                    ...d.profiles.filter(
                      (t) =>
                        !previous.profiles.some(
                          (p) => p.profile.wallet === t.profile.wallet,
                        ),
                    ),
                  ],
                }
              : d,
          );
      } catch (e) {
        if (!abort.signal.aborted)
          setError(
            e instanceof Error ? e.message : "Could not load token records.",
          );
      } finally {
        if (!abort.signal.aborted) setBusy(false);
      }
    })();
    return () => abort.abort();
  }, [view, q, recipient, cursor, refresh,tokenKey]);
  useEffect(()=>{const t=setInterval(()=>{if(document.visibilityState==='visible'&&!cursor)setRefresh(n=>n+1);},15000);const update=()=>{setCursor(null);setRefresh(n=>n+1);};window.addEventListener('fub-launch-confirmed',update);return()=>{clearInterval(t);window.removeEventListener('fub-launch-confirmed',update);};},[cursor]);
  function changeView(next: DirectoryView) {
    setRefresh(n => n + 1);
    setView(next);
    setRecipient(null);
    setInput("");
    setQ("");
    setCursor(null);
    setData(null);
  }
  function showCoins(profile: DirectoryProfile) {
    setRefresh(n => n + 1);
    setRecipient(profile);
    setView("tokens");
    setInput("");
    setQ("");
    setCursor(null);
    setData(null);
  }
  if(tokenKey)return <TokenPage tokenKey={tokenKey}/>;
  return (
    <section className="token-directory" aria-label="Fub tokens and recipients">
      <div className="directory-toolbar">
        <div
          className="directory-tabs"
          role="tablist"
          aria-label="Browse launches"
        >
          {(["tokens", "profiles"] as const).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              aria-controls="directory-results"
              id={`directory-tab-${v}`}
              onClick={() => changeView(v)}
              onKeyDown={(e) => {
                if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
                  e.preventDefault();
                  const next = v === "tokens" ? "profiles" : "tokens";
                  changeView(next);
                  document.getElementById(`directory-tab-${next}`)?.focus();
                }
              }}
              tabIndex={view === v ? 0 : -1}
            >
              {v === "tokens" ? "Tokens" : "Profiles"}
            </button>
          ))}
        </div>
        <button className="button primary" onClick={onLaunch}>
          Launch a coin <ArrowUpRight size={16} />
        </button>
      </div>
      {recipient && (
        <div className="directory-filter">
          <button className="word-link" onClick={() => changeView("profiles")}>
            <ArrowLeft size={15} /> All profiles
          </button>
          <Avatar profile={recipient} />
          <span>
            Coins for <strong>@{recipient.handle}</strong>
          </span>
        </div>
      )}
      <div className="directory-summary" aria-label="Directory totals">
        <div>
          <span>{q ? "Matching coins" : "Coins launched"}</span>
          <strong>{data ? data.totals.tokens.toLocaleString() : "—"}</strong>
        </div>
        <div>
          <span>Fomo recipients</span>
          <strong>{data ? data.totals.profiles.toLocaleString() : "—"}</strong>
        </div>
        <div>
          <span>Sent to recipients</span>
          <strong>
            {data ? <AssetAmount assets={data.totals.assets} field="recipientSent" fallback={data.totals.recipientSent}/> : "—"}
          </strong>
        </div>
        <div>
          <span>Sent to buyback treasury</span>
          <strong>
            {data ? <AssetAmount assets={data.totals.assets} field="buybackSent" fallback={data.totals.buybackSent}/> : "—"}
          </strong>
        </div>
      </div>
      <div className="directory-search-row">
        <label className="directory-search">
          <Search size={18} />
          <input
            aria-label={
              view === "tokens" ? "Search tokens" : "Search Fomo profiles"
            }
            placeholder={
              view === "tokens"
                ? "Name, ticker, mint or Fomo username"
                : "Fomo username, name or wallet"
            }
            value={input}
            maxLength={81}
            onChange={(e) => setInput(e.target.value)}
          />
        </label>
        <button
          className="icon-button"
          aria-label="Refresh directory"
          disabled={busy}
          onClick={() => {
            setCursor(null);
            setData(null);
            setRefresh((n) => n + 1);
          }}
        >
          <RefreshCw size={17} />
        </button>
      </div>
      <div
        id="directory-results"
        role="tabpanel"
        aria-labelledby={`directory-tab-${view}`}
        aria-busy={busy}
      >
        {error && (
          <div className="directory-error" role="alert">
            <p>{error}</p>
            <button
              className="word-link"
              onClick={() => setRefresh((n) => n + 1)}
            >
              Try again
            </button>
          </div>
        )}
        {busy && !data && (
          <p role="status" className="directory-empty">
            Loading confirmed launches…
          </p>
        )}
        {data && !error && data.totals.tokens === 0 && (
          <div className="directory-empty">
            <h2>
              {q || recipient
                ? "No matching launches."
                : "The first launch starts here."}
            </h2>
            <p>
              {q || recipient
                ? "Try another username, wallet or token."
                : "Confirmed coins will appear here with their Fomo recipient and fee history."}
            </p>
            {!q && !recipient && (
              <button className="word-link" onClick={onLaunch}>
                Launch a coin <ArrowUpRight size={16} />
              </button>
            )}
          </div>
        )}
        <div className="directory-list">
          {view === "tokens"
            ? data?.tokens.map((t) => (
                <article className="directory-card directory-token-card" key={t.mint}>
                  <div className="directory-token">
                    <img
                      className="directory-coin"
                      src={t.imageUrl}
                      alt=""
                      loading="lazy"
                    />
                    <div>
                      <h2>
                        <a className="directory-token-link" aria-label={`View ${t.name} token`} href={tokenPagePath(t.publicationId||t.mint)}>{t.name} <span>${t.ticker}</span></a>
                      </h2>
                      <a
                        className="word-link"
                        href={`https://solscan.io/token/${t.mint}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {short(t.mint)} <ArrowUpRight size={13} />
                      </a>
                    </div>

                  </div>
                  <button
                    className="directory-person"
                    onClick={() => showCoins(t.profile)}
                  >
                    <Avatar profile={t.profile} />
                    <span>
                      <strong>{t.profile.name}</strong>
                      <small>@{t.profile.handle} · 80% recipient</small>
                    </span>
                    <ArrowUpRight size={15} />
                  </button>
                  <Money fees={t.fees} /><span className="directory-hover-hint" aria-hidden="true">Click coin to view <ArrowUpRight size={12}/></span>
                </article>
              ))
            : data?.profiles.map((p) => (
                <article className="directory-card" key={p.profile.wallet}>
                  <div className="directory-profile-heading">
                    <Avatar profile={p.profile} />
                    <div>
                      <h2>{p.profile.name}</h2>
                      <a
                        className="word-link"
                        href={fomoProfileUrl(p.profile.handle)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        @{p.profile.handle} <ArrowUpRight size={13} />
                      </a>
                    </div>
                    <span className="directory-count">
                      {p.tokenCount} {p.tokenCount === 1 ? "coin" : "coins"}
                    </span>
                  </div>
                  <Money fees={p.fees} profile />
                  <div className="directory-card-footer">
                    <a
                      className="word-link"
                      href={`https://solscan.io/account/${p.profile.wallet}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {short(p.profile.wallet)} <ArrowUpRight size={13} />
                    </a>
                    <button
                      className="word-link"
                      onClick={() => showCoins(p.profile)}
                    >
                      View coins <ArrowUpRight size={15} />
                    </button>
                  </div>
                </article>
              ))}
        </div>
        {data?.nextCursor && (
          <button
            className="button secondary directory-more"
            disabled={busy}
            onClick={() => setCursor(data.nextCursor)}
          >
            {busy ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
      <details className="directory-explainer">
        <summary>How totals work</summary>
        <p>
          Only confirmed Fub launches appear here. Sent totals come from
          confirmed payouts recorded by Fub. Claims made outside Fub are not
          indexed. These figures are creator fees, not token sales, trading
          volume or a complete lifetime revenue total.
        </p>
        <p>
          Each recipient gets 80%. The other 20% goes to the treasury for buying
          and burning the one main Fub token. A treasury transfer is not proof
          of a completed buy or burn. Profiles combine every coin routed to the
          same confirmed wallet, including coins launched under earlier
          usernames.
        </p>
        <p>
          Unclaimed fees are finalized vault balances checked within the last
          two minutes. Unavailable or older checks show “Not checked.” Profile
          pictures and names use the last resolved Fomo profile; a recipient
          match does not imply endorsement.
        </p>
      </details>
      <details className="directory-platform">
        <summary>The Fub token and the 80/20 split</summary>
        <TokenEconomy />
      </details>
    </section>
  );
}
