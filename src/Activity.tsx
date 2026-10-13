import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowUpRight,
  RefreshCw,
  Search,
  Wallet,
} from "lucide-react";
import type { WalletConnection } from "./useWallet";
import type { Page } from "./navigation";
import { activityStates, activityUnits, validActivity } from "./activity-model";
import type { ActivityRecord, ActivityReport } from "./activity-model";
import { directorySol } from "./token-directory-model";
import { launchRecoveryAuthorization } from "./launch-recovery";
import { loadSavedRequests } from "./pay-request-storage";
import { payAmount, payLink } from "./pay-model";
import { shortAddress } from "./assets";
import { tokenPagePath } from "./token-links";
import { fomoProfileUrl } from "./fomo-identity";
import "./activity.css";
function Group({
  title,
  note,
  action,
  children,
}: {
  title: string;
  note: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="hub-activity-group" aria-label={title}>
      <header>
        <div>
          <h2>{title}</h2>
          <p>{note}</p>
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}
function Receipt({ signature }: { signature: string }) {
  return (
    <a
      className="word-link activity-receipt"
      href={`https://solscan.io/tx/${signature}`}
      target="_blank"
      rel="noreferrer"
    >
      Receipt <ArrowUpRight size={13} />
    </a>
  );
}
function ActivityAvatar({ src, label, coin = false }: { src?: string | null; label: string; coin?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return <span className={`activity-avatar ${coin ? 'activity-avatar-coin' : ''}`}>
    {src && !failed ? <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <span aria-hidden="true">{label.slice(0, 1).toUpperCase()}</span>}
  </span>;
}
function RecordRow({ row }: { row: ActivityRecord }) {
  if (row.kind === "launch") return <article className="hub-activity-row hub-activity-launch">
    <div className="activity-launch-coin">
      <ActivityAvatar src={row.imageUrl} label={row.title} coin />
      <div className="hub-activity-name">
        {row.mint && row.state === 'confirmed' ? <a href={tokenPagePath(row.mint)}><strong>{row.title}</strong></a> : <strong>{row.title}</strong>}
        {row.state !== 'confirmed' && <span className="hub-activity-state">{activityStates[row.state]}</span>}
      </div>
    </div>
    {row.handle ? <a className="activity-launch-recipient" href={fomoProfileUrl(row.handle)} target="_blank" rel="noreferrer">
      <ActivityAvatar src={row.recipientAvatarUrl} label={row.handle} />
      <span><strong>@{row.handle}</strong><small>80% fee recipient</small></span>
    </a> : <span />}
    <time dateTime={row.at} title={new Date(row.at).toLocaleString()}>{new Date(row.at).toLocaleDateString(undefined, {month:'short', day:'numeric'})}<small>{new Date(row.at).toLocaleTimeString(undefined, {hour:'2-digit', minute:'2-digit'})}</small></time>
  </article>;
  return (
    <article className="hub-activity-row">
      <div className="hub-activity-name">
        <strong>{row.title}</strong>
        <span>
          {row.handle
            ? `@${row.handle}`
            : row.mint
              ? shortAddress(row.mint)
              : "Fub"}
          {row.kind === "fee"
            ? " · Creator fee payout"
            : row.kind === "burn"
              ? " · Official platform token"
              : ""}
        </span>
      </div>
      <div className="hub-activity-amount">
        {row.kind === "fee" ? (
          <>
            <strong>
              {directorySol(row.recipient!)} SOL <small>{row.feeSource==="official"?"to development":"to recipient"}</small>
            </strong>
            <span>{directorySol(row.treasury!)} SOL to buyback treasury</span>
          </>
        ) : row.kind === "burn" ? (
          <>
            <strong>
              {activityUnits(row.burned!, row.decimals!)}{" "}
              <small>tokens burned</small>
            </strong>
            <span>
              {directorySol(row.treasury!)} SOL spent, including costs
            </span>
          </>
        ) : (
          <span
            className={`hub-activity-state ${row.state === "confirmed" ? "is-confirmed" : ""}`}
          >
            {activityStates[row.state]}
          </span>
        )}
      </div>
      <time dateTime={row.at} title={new Date(row.at).toLocaleString()}>
        {new Date(row.at).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        })}
        <small>
          {new Date(row.at).toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </small>
      </time>
      {row.signature ? (
        <Receipt signature={row.signature} />
      ) : (
        <span className="hub-activity-no-receipt">No receipt</span>
      )}
    </article>
  );
}
export function Activity({
  connection,
  onConnect,
  onNavigate,
}: {
  connection: WalletConnection;
  onConnect: () => void;
  onNavigate: (page: Page) => void;
}) {
  const wallet = connection.session?.address;
  const [scope, setScope] = useState<"platform" | "wallet">("platform"),
    [category, setCategory] = useState("All"),
    [query, setQuery] = useState(""),
    [report, setReport] = useState<ActivityReport | null>(null),
    [privateReport, setPrivateReport] = useState<ActivityReport | null>(null),
    [busy, setBusy] = useState(false),
    [privateBusy, setPrivateBusy] = useState(false),
    [error, setError] = useState(""),
    [privateError, setPrivateError] = useState(""),
    [revision, setRevision] = useState(0),
    [requests, setRequests] = useState(loadSavedRequests);
  const privateRequest = useRef<AbortController | null>(null),
    currentWallet = useRef(wallet);
  currentWallet.current = wallet;
  useEffect(() => {
    privateRequest.current?.abort();
    setPrivateReport(null);
    setPrivateError("");
    setPrivateBusy(false);
    return () => {
      privateRequest.current?.abort();
    };
  }, [wallet]);
  useEffect(() => {
    const c = new AbortController();
    setBusy(true);
    setError("");
    void fetch("/api/activity", {
      signal: AbortSignal.any([c.signal, AbortSignal.timeout(15000)]),
    })
      .then(async (r) => {
        const d: unknown = await r.json();
        if (!r.ok || !validActivity(d, null))
          throw Error("Platform activity could not be loaded. Try again.");
        if (!c.signal.aborted) setReport(d);
      })
      .catch((e) => {
        if (!c.signal.aborted)
          setError(e instanceof Error ? e.message : "Activity unavailable.");
      })
      .finally(() => {
        if (!c.signal.aborted) setBusy(false);
      });
    return () => c.abort();
  }, [revision]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") setRevision((v) => v + 1);
    };
    const timer = window.setInterval(refresh, 30000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  useEffect(() => {
    const update = () => setRequests(loadSavedRequests());
    window.addEventListener("storage", update);
    return () => window.removeEventListener("storage", update);
  }, []);
  async function loadPrivate() {
    if (!wallet) {
      onConnect();
      return;
    }
    if (privateBusy) return;
    privateRequest.current?.abort();
    const c = new AbortController();
    privateRequest.current = c;
    setPrivateBusy(true);
    setPrivateError("");
    try {
      const payload = {},
        authorization = await launchRecoveryAuthorization(
          "activity",
          wallet,
          payload,
        ),
        signature = await connection.signLaunchRecovery(authorization);
      if (c.signal.aborted || currentWallet.current !== wallet) return;
      const r = await fetch("/api/activity", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Fomo-Request": "1" },
        body: JSON.stringify({ authorization, payload, signature }),
        signal: AbortSignal.any([c.signal, AbortSignal.timeout(15000)]),
      });
      const d: unknown = await r.json();
      if (!r.ok || !validActivity(d, wallet))
        throw Error(
          "Wallet activity could not be loaded. Sign a fresh request and try again.",
        );
      if (!c.signal.aborted && currentWallet.current === wallet)
        setPrivateReport(d);
    } catch (e) {
      if (!c.signal.aborted)
        setPrivateError(
          e instanceof Error ? e.message : "Wallet activity unavailable.",
        );
    } finally {
      if (!c.signal.aborted) setPrivateBusy(false);
    }
  }
  const current =
    scope === "platform"
      ? report
      : privateReport?.wallet === wallet
        ? privateReport
        : null;
  const matches = (text: string) =>
    text.toLowerCase().includes(query.trim().toLowerCase());
  const groups = [
    {
      kind: "launch",
      filter: "Launches",
      title: scope === "platform" ? "Coin launches" : "Your launches",
      note:
        scope === "platform"
          ? "Confirmed coins launched through Fub."
          : "Saved launch attempts and their confirmation status.",
      empty: "No launch records yet.",
      page: "Launch" as Page,
    },
    {
      kind: "fee",
      filter: "Creator fees",
      title: "Creator fee payouts",
      note:
        scope === "platform"
          ? "80% to the chosen Fomo recipient. 20% to the platform treasury."
          : "Payouts for coins you launched or fees sent to your wallet.",
      empty: "No confirmed creator-fee payouts yet.",
      page: "Tokens" as Page,
    },
    ...(scope === "platform"
      ? [
          {
            kind: "burn",
            filter: "Buy & burn",
            title: "Buybacks and burns",
            note: "Confirmed purchases and burns of the one official Fub token.",
            empty: "No confirmed buybacks and burns yet.",
            page: "Tokens" as Page,
          },
        ]
      : [
          {
            kind: "copy",
            filter: "Trading",
            title: "Copy trading",
            note: "Your copied buys, sells and recovery status.",
            empty: "No copy-trading attempts yet.",
            page: "Copy trading" as Page,
          },
        ]),
  ];
  const filters =
    scope === "platform"
      ? ["All", "Launches", "Creator fees", "Buy & burn"]
      : ["All", "Launches", "Creator fees", "Trading", "Pay"];
  return (
    <div className="hub-activity">
      <div className="hub-activity-toolbar">
        <div className="hub-activity-scope" aria-label="Activity scope">
          {(["platform", "wallet"] as const).map((s) => (
            <button
              key={s}
              aria-pressed={scope === s}
              onClick={() => {
                setScope(s);
                setCategory("All");
                setQuery("");
              }}
            >
              {s === "platform" ? "Platform" : "Your wallet"}
            </button>
          ))}
        </div>
        <button
          className="word-link"
          disabled={busy || privateBusy}
          onClick={() => {
            setRevision((v) => v + 1);
            setRequests(loadSavedRequests());
            if (scope === "wallet" && current) void loadPrivate();
          }}
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>
      <div className="hub-activity-filter">
        <div
          className="hub-activity-categories"
          aria-label="Activity categories"
        >
          {filters.map((f) => (
            <button
              key={f}
              aria-pressed={category === f}
              onClick={() => setCategory(f)}
            >
              {f}
            </button>
          ))}
        </div>
        <label className="search-field">
          <Search size={15} />
          <input
            aria-label="Search activity"
            placeholder="Search loaded activity"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      {scope === "wallet" && !current && (
        <div className="hub-activity-auth">
          <Wallet size={21} />
          <div>
            <strong>Your records, in one place.</strong>
            <p>
              {wallet
                ? "Sign a message to read your launches, fees and copy trades. No transaction or spending permission."
                : "Connect your wallet to load your launches, fees and copy trades."}
            </p>
          </div>
          <button
            className="button secondary compact"
            disabled={privateBusy}
            onClick={() => void loadPrivate()}
          >
            {privateBusy
              ? "Waiting for wallet…"
              : wallet
                ? "Load wallet history"
                : "Connect wallet"}
          </button>
        </div>
      )}
      {(scope === "platform" ? error : privateError) && (
        <p className="hub-activity-error" role="alert">
          {scope === "platform" ? error : privateError}
          {current ? " Previously loaded records are shown." : ""}
        </p>
      )}
      {((scope === "platform" && busy) || privateBusy) && (
        <p className="copy-help" role="status">
          Loading activity…
        </p>
      )}
      <div className="hub-activity-groups">
        {groups
          .filter((g) => category === "All" || category === g.filter)
          .map((g) => {
            const rows =
              current?.records.filter(
                (r) =>
                  r.kind === g.kind &&
                  matches(
                    `${r.title} ${r.handle || ""} ${r.mint || ""} ${activityStates[r.state]}`,
                  ),
              ) || [];
            return (
              <Group
                key={g.kind}
                title={g.title}
                note={g.note}
                action={
                  <button
                    className="word-link"
                    onClick={() => onNavigate(g.page)}
                  >
                    {g.kind === "launch"
                      ? "Launch a coin"
                      : g.kind === "copy"
                        ? "Manage copying"
                        : "View tokens"}
                    <ArrowUpRight size={13} />
                  </button>
                }
              >
                {g.kind === "burn" && current?.burnTotals?.map(total => (
                  <div className="hub-burn-totals" key={total.mint} aria-label="All-time buyback totals">
                    <div><span>Total bought &amp; burned</span><strong>{activityUnits(total.tokens, total.decimals)} <small>FUB</small></strong></div>
                    <div><span>Total SOL spent</span><strong>{activityUnits(total.spent, 9)} <small>SOL</small></strong><small>Includes transaction fees and account costs</small></div>
                    <p>{total.count.toLocaleString()} confirmed burns · All time</p>
                  </div>
                ))}
                {rows.map((r) => (
                  <RecordRow key={r.id} row={r} />
                ))}
                {!rows.length && (
                  <p className="hub-activity-empty">
                    {!current
                      ? scope === "wallet"
                        ? "Load your wallet history to see these records."
                        : busy
                          ? "Loading records…"
                          : error
                            ? "Records unavailable."
                            : g.empty
                      : query
                        ? "No matching records."
                        : g.empty}
                  </p>
                )}
                {current?.more.includes(g.kind as ActivityRecord["kind"]) && (
                  <p className="hub-activity-footnote">
                    Showing the latest 25 records in this section.
                  </p>
                )}
              </Group>
            );
          })}
        {scope === "wallet" && (category === "All" || category === "Pay") && (
          <Group
            title="Pay requests"
            note="Saved on this device. Open a request to check its payment receipt."
            action={
              <button className="word-link" onClick={() => onNavigate("Pay")}>
                Open Pay
                <ArrowUpRight size={13} />
              </button>
            }
          >
            {requests
              .filter((r) => matches(`${r.title} ${r.kind} ${r.recipient}`))
              .map((r) => (
                <article
                  className="hub-activity-row"
                  key={r.id + JSON.stringify(r)}
                >
                  <div className="hub-activity-name">
                    <strong>{r.title}</strong>
                    <span>
                      {r.kind === "split" ? "Split" : "Treat"} ·{" "}
                      {shortAddress(r.recipient)}
                    </span>
                  </div>
                  <div className="hub-activity-amount">
                    <strong>{payAmount(r.cents)} USDC</strong>
                    <span>Payment not checked here</span>
                  </div>
                  <a
                    className="word-link"
                    href={payLink(r, window.location.origin)}
                  >
                    Open request
                    <ArrowUpRight size={13} />
                  </a>
                </article>
              ))}
            {!requests.filter((r) =>
              matches(`${r.title} ${r.kind} ${r.recipient}`),
            ).length && (
              <p className="hub-activity-empty">
                {query
                  ? "No matching requests."
                  : "No saved Pay requests on this device."}
              </p>
            )}
          </Group>
        )}
      </div>

    </div>
  );
}
