import { useEffect, useRef, useState } from "react";
import {
  ArrowDownLeft,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  Copy,
  CreditCard,
  Download,
  Eye,
  EyeOff,
  Gift as GiftIcon,
  HelpCircle,
  LockKeyhole,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Snowflake,
  Users,
  Wallet,
  X,
} from "lucide-react";
import type { Action, LinkData, Transaction } from "./model";
import {
  balance,
  decodeLink,
  loadAccount,
  money,
  spent,
  update,
} from "./model";
import {
  AmountForm,
  CheckoutForm,
  GiftForm,
  SharePanel,
  SplitForm,
} from "./forms";
import {
  ArrowLink,
  Avatar,
  Card,
  Empty,
  Modal,
  MerchantLogo,
  Wordmark,
} from "./ui";

type Page = "Overview" | "Card" | "Split" | "Treat" | "Activity";
type Dialog =
  | "deposit"
  | "split"
  | "gift"
  | "checkout"
  | "limit"
  | "help"
  | "settings"
  | "share"
  | null;
const pages: Page[] = ["Overview", "Card", "Split", "Treat", "Activity"];
function pageFromHash(): Page {
  return (
    pages.find((p) => location.hash === "#pay/preview/" + p.toLowerCase()) || "Overview"
  );
}
function iconClass(t: Transaction) {
  if (t.kind === "deposit" || t.kind === "refund") return "deposit";
  if (t.kind === "gift") return "gift";
  if (t.kind === "reimbursement") return "reimburse";
  if (t.merchant === "McDonald’s") return "mcd";
  if (t.merchant === "Uber Eats") return "uber";
  if (t.merchant === "Spotify") return "spotify";
  if (t.merchant === "Amazon") return "amazon";
  return "nike";
}
function TxIcon({ tx }: { tx: Transaction }) {
  return (
    <span className={`merchant-icon ${iconClass(tx)}`}>
      {tx.kind === "deposit" || tx.kind === "refund" ? (
        <ArrowDownLeft size={21} />
      ) : tx.kind === "gift" ? (
        <GiftIcon size={20} />
      ) : tx.kind === "reimbursement" ? (
        <Users size={20} />
      ) : (
        <MerchantLogo name={tx.merchant} />
      )}
    </span>
  );
}
function dateLabel(at: string) {
  const d = new Date(at);
  return d.toDateString() === new Date().toDateString()
    ? "Today"
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function PayWorkspace() {
  const [account, setAccount] = useState(loadAccount);
  const accountRef = useRef(account);
  const [page, setPage] = useState<Page>(pageFromHash);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [toast, setToast] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [share, setShare] = useState<LinkData | null>(null);
  const [transaction, setTransaction] = useState<Transaction | undefined>();
  const [reveal, setReveal] = useState(false);
  const [hideBalance, setHideBalance] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("All");
  const [preview, setPreview] = useState(() => decodeLink(location.hash));
  const [previewDone, setPreviewDone] = useState(false);
  const [previewPerson, setPreviewPerson] = useState(1);
  const [invalidLink, setInvalidLink] = useState(
    () => location.hash.startsWith("#preview=") && !decodeLink(location.hash),
  );
  const [storageError, setStorageError] = useState(false);
  const available = balance(account);
  const monthSpent = spent(account);

  function notify(message: string) {
    setToast(message);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(""), 3800);
  }
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    try {
      localStorage.setItem("fomo-pay.demo.v1", JSON.stringify(account));
    } catch {
      setStorageError(true);
    }
  }, [account]);
  useEffect(() => {
    const change = () => {
      const d = decodeLink(location.hash);
      setPage(pageFromHash());
      setDialog(null);
      setPreview(d);
      setPreviewDone(false);
      setPreviewPerson(1);
      setInvalidLink(location.hash.startsWith("#preview=") && !d);
    };
    window.addEventListener("hashchange", change);
    window.addEventListener("popstate", change);
    return () => {
      window.removeEventListener("hashchange", change);
      window.removeEventListener("popstate", change);
    };
  }, []);
  function submit(action: Action) {
    try {
      const next = update(accountRef.current, action);
      accountRef.current = next;
      setAccount(next);
      return true;
    } catch (e) {
      notify(e instanceof Error ? e.message : "Something went wrong.");
      return false;
    }
  }
  function open(name: Dialog) {
    setTransaction(undefined);
    setDialog(name);
  }
  function go(next: Page) {
    const hash = next === "Overview" ? "#pay/preview" : "#pay/preview/" + next.toLowerCase();
    if (location.hash !== hash) {
      history.pushState(null, "", hash);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    }
    setPreview(null);
    setInvalidLink(false);
    setPage(next);
    setFilter("All");
    setSearch("");
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function showShare(data: LinkData) {
    setShare(data);
    setDialog("share");
  }
  function receipt(t: Transaction) {
    showShare({
      version: 1,
      demo: true,
      kind: "receipt",
      id: t.id,
      title: t.merchant,
      cents: Math.abs(t.cents),
      message: t.note,
    });
  }
  function reset() {
    submit({ type: "reset" });
    setDialog(null);
    setReveal(false);
    notify("Demo account reset");
  }
  function exitPreview() {
    history.pushState(null, "", "#pay/preview");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    setPage("Overview");
    setPreview(null);
    setInvalidLink(false);
    setPreviewDone(false);
  }
  function downloadActivity() {
    const cell = (v: string) =>
      '"' + (/^[=+@-]/.test(v) ? "'" : "") + v.replaceAll('"', '""') + '"';
    const csv = [
      "Date,Description,Amount USD,Type,Mode",
      ...account.transactions.map((t) =>
        [t.at, t.merchant, (t.cents / 100).toFixed(2), t.kind, "DEMO"]
          .map(cell)
          .join(","),
      ),
    ].join("\r\n");
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8;" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "fomo-pay-demo-activity.csv";
    a.click();
    URL.revokeObjectURL(url);
    notify("Activity exported");
  }
  const outgoingShares = account.splits.reduce(
    (sum, s) =>
      sum +
      s.shares
        .slice(1)
        .filter((p) => !p.paid)
        .reduce((n, p) => n + p.cents, 0),
    0,
  );
  const visibleTransactions = account.transactions.filter(
    (t) =>
      (filter === "All" ||
        (filter === "Spending"
          ? t.kind === "purchase"
          : filter === "Received"
            ? t.cents > 0
            : t.kind === "gift")) &&
      `${t.merchant} ${t.note || ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const rows = (list: Transaction[]) => (
    <div className="transaction-list">
      {list.map((t) => (
        <button className="transaction" key={t.id} onClick={() => receipt(t)}>
          <TxIcon tx={t} />
          <span className="transaction-name">
            <b>{t.merchant}</b>
            <span>{t.note || t.kind}</span>
          </span>
          <span className="transaction-date">
            {dateLabel(t.at)}
            <span>Demo</span>
          </span>
          <span
            className={`transaction-amount ${t.cents > 0 ? "positive" : ""}`}
          >
            {t.cents > 0 ? "+" : "−"}
            {money(Math.abs(t.cents))}
            <span>
              {t.kind === "purchase"
                ? "Completed"
                : t.kind === "gift"
                  ? "Reserved"
                  : "Received"}
            </span>
          </span>
          <ChevronRight size={15} className="row-chevron" />
        </button>
      ))}
    </div>
  );

  return (
    <div className="pay-app">
      <div className="pay-navigation">
        <a className="word-link" href="#pay">Back to Pay</a>
        <nav aria-label="Fomo Pay navigation">
          {pages.map((p) => (
            <button
              className={`nav-link ${!preview && !invalidLink && page === p ? "active" : ""}`}
              aria-current={
                !preview && !invalidLink && page === p ? "page" : undefined
              }
              key={p}
              onClick={() => go(p)}
            >
              {p}
            </button>
          ))}
          <a className="nav-link" href="#pay/gift-cards">Gift cards</a>
        </nav>
        <a className="word-link" href="#pay-request">
          USDC requests <ArrowUpRight size={14} />
        </a>
      </div>
      <div className="main">
        {storageError && (
          <div className="storage-notice">
            Browser storage is unavailable. Your demo changes will reset when
            you reload.
          </div>
        )}
        {invalidLink ? (
          <Empty
            icon={<LockKeyhole />}
            title="This preview link isn’t valid"
            text="Ask the sender for a new link."
            action={
              <button className="button primary" onClick={exitPreview}>
                Back to Fomo Pay
              </button>
            }
          />
        ) : preview ? (
          <div className="claim-page">
            <div className="claim-label">
              <span className="pill">RECIPIENT PREVIEW</span>
            </div>
            <div className="claim-content">
              <div className="claim-icon">
                {preview.kind === "gift" ? (
                  <GiftIcon size={35} />
                ) : preview.kind === "split" ? (
                  <Users size={35} />
                ) : (
                  <Check size={35} />
                )}
              </div>
              <p className="eyebrow">
                {preview.kind === "gift"
                  ? `HEY ${preview.title.toUpperCase()}`
                  : preview.kind === "split"
                    ? "YOUR PART OF THE BILL"
                    : "SAMPLE RECEIPT"}
              </p>
              <h1>
                {previewDone
                  ? "All set."
                  : preview.kind === "gift"
                    ? "Someone’s got you."
                    : preview.kind === "split"
                      ? "Good food. Fair split."
                      : preview.title}
              </h1>
              <div className="claim-amount">
                {money(
                  preview.kind === "split"
                    ? preview.shares?.[previewPerson]?.cents || preview.cents
                    : preview.cents,
                )}
              </div>
              <p className="claim-message">
                {previewDone
                  ? "Preview complete. No funds moved."
                  : preview.kind === "gift"
                    ? preview.message
                    : preview.kind === "split"
                      ? preview.title
                      : "Demo transaction · not a merchant receipt"}
              </p>
              {preview.kind === "split" && !previewDone && (
                <label className="field">
                  Which share is yours?
                  <select
                    value={previewPerson}
                    onChange={(e) => setPreviewPerson(Number(e.target.value))}
                  >
                    {preview.shares?.slice(1).map((s, i) => (
                      <option key={i} value={i + 1}>
                        {s.name} · {money(s.cents)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {preview.kind !== "receipt" && (
                <button
                  className="button primary full"
                  disabled={
                    previewDone ||
                    (preview.kind === "gift" &&
                      (account.claimed.includes(preview.id) ||
                        account.gifts.some(
                          (g) =>
                            g.id === preview.id && g.status === "cancelled",
                        )))
                  }
                  onClick={() => {
                    if (preview.kind === "gift")
                      submit({ type: "claimGift", id: preview.id });
                    else
                      submit({
                        type: "settle",
                        id: preview.id,
                        index: previewPerson,
                      });
                    setPreviewDone(true);
                  }}
                >
                  {previewDone || account.claimed.includes(preview.id)
                    ? "Preview completed"
                    : preview.kind === "gift" &&
                        account.gifts.some(
                          (g) =>
                            g.id === preview.id && g.status === "cancelled",
                        )
                      ? "Treat cancelled"
                      : preview.kind === "gift"
                        ? "Preview claiming this treat"
                        : "Preview reimbursement"}
                  <ArrowRight size={17} />
                </button>
              )}
              <p className="fine-print">
                This is a demo link, not a funded gift or payment request.
                Changes stay on this device and do not sync to the sender.
              </p>
              <button className="word-link centered" onClick={exitPreview}>
                Explore Fomo Pay <ArrowRight size={15} />
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="page-heading">
              <div>
                <p className="eyebrow">YOUR EVERYDAY, ON FOMO</p>
                <h1>
                  {page === "Overview"
                    ? "Good to see you."
                    : page === "Card"
                      ? "Your card. Your call."
                      : page === "Split"
                        ? "Keep the bill fair."
                        : page === "Treat"
                          ? "A little goes a long way."
                          : "Every little thing."}
                </h1>
              </div>
              <button
                className="icon-button settings-button"
                aria-label="Demo settings"
                onClick={() => open("settings")}
              >
                <Settings2 size={19} />
              </button>
            </div>
            {(page === "Overview" || page === "Card") && (
              <section className="balance-section">
                <div className="balance-panel">
                  <div className="balance-label">
                    Available demo balance{" "}
                    <button
                      aria-label={hideBalance ? "Show balance" : "Hide balance"}
                      className="icon-button small"
                      onClick={() => setHideBalance(!hideBalance)}
                    >
                      {hideBalance ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  <div className="balance-value">
                    {hideBalance ? (
                      "••••"
                    ) : (
                      <>
                        {money(available).split(".")[0]}
                        <span>.{money(available).split(".")[1]}</span>
                      </>
                    )}
                  </div>
                  <div className="balance-unit">
                    <span className="usdc-icon">$</span> USDC{" "}
                    <span className="dot-separator">·</span> Solana{" "}
                    <span className="sample-label">Sample funds</span>
                  </div>
                  <div className="balance-actions">
                    <button
                      className="button primary"
                      onClick={() => open("deposit")}
                    >
                      <Plus size={18} />
                      Add balance
                    </button>
                    <button
                      className="button secondary"
                      onClick={() => open("checkout")}
                    >
                      <ArrowUpRight size={18} />
                      Try checkout
                    </button>
                  </div>
                  <div className="balance-foot">
                    <ShieldCheck size={14} />
                    <span>
                      Sample funds stay separate from your connected wallet.
                    </span>
                  </div>
                </div>
                <div className="card-panel">
                  <Card frozen={account.frozen} reveal={reveal} />
                  <div className="card-controls">
                    <button onClick={() => setReveal(!reveal)}>
                      {reveal ? <EyeOff size={16} /> : <Eye size={16} />}
                      <span>{reveal ? "Hide details" : "Card details"}</span>
                    </button>
                    <button
                      onClick={() => {
                        submit({ type: "freeze" });
                        notify(
                          account.frozen
                            ? "Demo card unfrozen"
                            : "Demo card frozen",
                        );
                      }}
                    >
                      <Snowflake size={16} />
                      <span>{account.frozen ? "Unfreeze" : "Freeze card"}</span>
                    </button>
                    <button onClick={() => open("limit")}>
                      <Settings2 size={16} />
                      <span>Set limit</span>
                    </button>
                  </div>
                </div>
              </section>
            )}
            {page === "Overview" && (
              <>
                <section className="social-grid" aria-label="Pay together">
                  <button
                    className="feature-card split-feature"
                    onClick={() => open("split")}
                  >
                    <div className="feature-copy">
                      <span className="feature-kicker">
                        <Users size={16} /> BETTER TOGETHER
                      </span>
                      <h2>Split the bill.</h2>
                      <p>You paid. They pay you back.</p>
                      <span className="feature-link">
                        Create a split <ArrowUpRight size={17} />
                      </span>
                    </div>
                    <div className="split-visual" aria-hidden="true">
                      <div className="mini-bill">
                        <span>McDonald’s</span>
                        <b>$36.00</b>
                      </div>
                      <div className="split-line" />
                      <div className="avatar-group">
                        <Avatar name="You" index={0} />
                        <Avatar name="Alex" index={1} />
                        <Avatar name="Sam" index={2} />
                      </div>
                      <div className="mini-shares">
                        <span>$12</span>
                        <span>$12</span>
                        <span>$12</span>
                      </div>
                    </div>
                  </button>
                  <button
                    className="feature-card gift-feature"
                    onClick={() => open("gift")}
                  >
                    <div className="feature-copy">
                      <span className="feature-kicker">
                        <GiftIcon size={16} /> JUST BECAUSE
                      </span>
                      <h2>Treat a friend.</h2>
                      <p>The next one’s on you.</p>
                      <span className="feature-link">
                        Send a treat <ArrowUpRight size={17} />
                      </span>
                    </div>
                    <div className="gift-visual" aria-hidden="true">
                      <div className="treat-card">
                        <div className="treat-card-top">
                          <Wordmark />
                          <ArrowUpRight size={15} />
                        </div>
                        <div className="treat-card-amount">
                          $15<span>.00</span>
                        </div>
                        <div className="treat-card-note">Lunch is on me.</div>
                        <div className="treat-card-bottom">
                          <span>FOR ALEX</span>
                          <GiftIcon size={13} />
                        </div>
                      </div>
                      <div className="treat-seal">
                        <Check size={12} /> A little something
                      </div>
                    </div>
                  </button>
                </section>
                <section className="activity-section">
                  <div className="section-heading">
                    <h2>
                      Recent activity <span>{account.transactions.length}</span>
                    </h2>
                    <ArrowLink onClick={() => go("Activity")}>
                      View all
                    </ArrowLink>
                  </div>
                  {rows(account.transactions.slice(0, 4))}
                </section>
                <div className="bottom-strip">
                  <span>Sample account</span>
                  <p>Try the whole flow. No real funds move.</p>
                  <button className="word-link" onClick={() => open("help")}>
                    What’s live? <ArrowUpRight size={14} />
                  </button>
                </div>
              </>
            )}
            {page === "Card" && (
              <>
                <div className="card-info-grid">
                  <section className="detail-panel">
                    <div className="section-heading">
                      <h2>Spending limit</h2>
                      <ArrowLink onClick={() => open("limit")}>Edit</ArrowLink>
                    </div>
                    <div className="spending-total">
                      {money(monthSpent)}
                      <span> / {money(account.limit)}</span>
                    </div>
                    <div className="progress-track">
                      <span
                        style={{
                          width:
                            Math.min(100, (monthSpent / account.limit) * 100) +
                            "%",
                        }}
                      />
                    </div>
                    <p className="muted">
                      {money(Math.max(0, account.limit - monthSpent))} left this
                      month
                    </p>
                  </section>
                  <section className="detail-panel">
                    <h2>Card controls</h2>
                    <div className="control-row">
                      <span>
                        <LockKeyhole size={17} />
                        Card status
                      </span>
                      <button
                        className={`pill clickable ${account.frozen ? "" : "green"}`}
                        onClick={() => submit({ type: "freeze" })}
                      >
                        {account.frozen ? "Frozen" : "Active in demo"}
                      </button>
                    </div>
                    <button
                      className="control-row control-button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(
                            "Fomo Pay DEMO card •••• 4242 — not a valid payment card",
                          );
                          notify("Demo card details copied");
                        } catch {
                          notify(
                            "Clipboard unavailable. Demo card ends in 4242.",
                          );
                        }
                      }}
                    >
                      <span>
                        <Copy size={17} />
                        Copy demo details
                      </span>
                      <ChevronRight size={16} />
                    </button>
                    <div className="control-row">
                      <span>
                        <Wallet size={17} />
                        Add to Apple / Google Wallet
                      </span>
                      <span className="muted tiny">Not available</span>
                    </div>
                  </section>
                </div>
                <div className="provider-note">
                  <CreditCard size={21} />
                  <div>
                    <b>Use your existing wallet.</b>
                    <p>
                      This card is a sample. Check the real USDC balance and card
                      allowance at your existing Fomo address.
                    </p>
                    <a className="word-link" href="#pay/wallet">Wallet funding <ArrowUpRight size={14} /></a>
                  </div>
                </div>
              </>
            )}
            {page === "Split" && (
              <>
                <div className="section-toolbar">
                  <div>
                    <span className="muted">Awaiting reimbursement</span>
                    <div className="section-number">
                      {money(outgoingShares)}
                    </div>
                  </div>
                  <button
                    className="button primary"
                    onClick={() => open("split")}
                  >
                    <Plus size={17} />
                    New split
                  </button>
                </div>
                {!account.splits.length ? (
                  <Empty
                    icon={<Users size={30} />}
                    title="One bill. Everyone’s share."
                    text="Pick a purchase, divide it, and send a link. Your friends can see exactly what they owe."
                    action={
                      <button
                        className="button secondary"
                        onClick={() => open("split")}
                      >
                        Split a purchase <ArrowRight size={16} />
                      </button>
                    }
                  />
                ) : (
                  <div className="split-list">
                    {account.splits.map((s) => (
                      <section className="detail-panel split-item" key={s.id}>
                        <div className="section-heading">
                          <div>
                            <h2>{s.title}</h2>
                            <p className="muted">
                              {s.shares.length} people ·{" "}
                              {money(s.shares.reduce((n, p) => n + p.cents, 0))}{" "}
                              total
                            </p>
                          </div>
                          <ArrowLink
                            onClick={() =>
                              showShare({
                                version: 1,
                                demo: true,
                                kind: "split",
                                id: s.id,
                                title: s.title,
                                cents: s.shares.reduce(
                                  (n, p) => n + p.cents,
                                  0,
                                ),
                                shares: s.shares,
                              })
                            }
                          >
                            Share link
                          </ArrowLink>
                        </div>
                        {s.shares.map((p, i) => (
                          <div className="split-person" key={i}>
                            <Avatar name={p.name} index={i} />
                            <b>{p.name}</b>
                            <span>{money(p.cents)}</span>
                            {p.paid ? (
                              <span className="paid-label">
                                <Check size={14} />
                                {i === 0 ? "Your share" : "Received"}
                              </span>
                            ) : (
                              <button
                                className="small-button"
                                onClick={() => {
                                  submit({
                                    type: "settle",
                                    id: s.id,
                                    index: i,
                                  });
                                  notify("Demo reimbursement recorded");
                                }}
                              >
                                Simulate payment
                              </button>
                            )}
                          </div>
                        ))}
                      </section>
                    ))}
                  </div>
                )}
                <p className="section-note">
                  Demo requests and reimbursements stay in this browser. No
                  funds move.
                </p>
              </>
            )}
            {page === "Treat" && (
              <>
                <div className="section-toolbar">
                  <div>
                    <span className="muted">Reserved for friends</span>
                    <div className="section-number">
                      {money(
                        account.gifts
                          .filter((g) => g.status === "sent")
                          .reduce((n, g) => n + g.cents, 0),
                      )}
                    </div>
                  </div>
                  <button
                    className="button primary"
                    onClick={() => open("gift")}
                  >
                    <GiftIcon size={17} />
                    Send a treat
                  </button>
                </div>
                {!account.gifts.length ? (
                  <Empty
                    icon={<GiftIcon size={30} />}
                    title="Coffee. Lunch. A little thank you."
                    text="Pick an amount, leave a note, and send a claim link. You can cancel before it’s claimed."
                    action={
                      <button
                        className="button secondary"
                        onClick={() => open("gift")}
                      >
                        Treat someone <ArrowRight size={16} />
                      </button>
                    }
                  />
                ) : (
                  <div className="gift-list">
                    {account.gifts.map((g) => (
                      <section
                        className={`gift-item ${g.status === "cancelled" ? "cancelled" : ""}`}
                        key={g.id}
                      >
                        <div className="gift-item-top">
                          <GiftIcon size={25} />
                          <span
                            className={`pill ${g.status === "claimed" ? "green" : ""}`}
                          >
                            {g.status === "sent"
                              ? "Unclaimed"
                              : g.status === "claimed"
                                ? "Claimed in demo"
                                : "Cancelled"}
                          </span>
                        </div>
                        <span className="muted">For {g.to}</span>
                        <h2>{money(g.cents)}</h2>
                        <p>{g.message || "A little something for you."}</p>
                        <div className="gift-item-actions">
                          {g.status === "sent" ? (
                            <>
                              <ArrowLink
                                onClick={() =>
                                  showShare({
                                    version: 1,
                                    demo: true,
                                    kind: "gift",
                                    id: g.id,
                                    title: g.to,
                                    cents: g.cents,
                                    message: g.message,
                                  })
                                }
                              >
                                Share treat
                              </ArrowLink>
                              <button
                                className="text-button muted"
                                onClick={() => {
                                  submit({ type: "cancelGift", id: g.id });
                                  notify(
                                    "Treat cancelled. Demo balance returned.",
                                  );
                                }}
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <span className="muted tiny">
                              {g.status === "claimed"
                                ? "Claimed does not mean spent."
                                : "Demo funds returned to your balance."}
                            </span>
                          )}
                        </div>
                      </section>
                    ))}
                  </div>
                )}
                <p className="section-note">
                  Treat links are previews. Gift balances and claims do not sync
                  across devices yet.
                </p>
              </>
            )}
            {page === "Activity" && (
              <>
                <div className="activity-toolbar">
                  <div className="segmented activity-tabs">
                    {["All", "Spending", "Received", "Treats"].map((f) => (
                      <button
                        key={f}
                        className={filter === f ? "selected" : ""}
                        onClick={() => setFilter(f)}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                  <button
                    className="button secondary compact"
                    onClick={downloadActivity}
                  >
                    <Download size={16} />
                    Export
                  </button>
                </div>
                <label className="search-field">
                  <Search size={18} />
                  <input
                    aria-label="Search activity"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search your activity"
                  />
                  {search && (
                    <button
                      className="icon-button small"
                      onClick={() => setSearch("")}
                      aria-label="Clear search"
                    >
                      <X size={15} />
                    </button>
                  )}
                </label>
                {visibleTransactions.length ? (
                  rows(visibleTransactions)
                ) : (
                  <Empty
                    icon={<Search size={28} />}
                    title="Nothing here yet"
                    text="Try a different search or make a demo purchase."
                  />
                )}
                <p className="section-note">
                  All transactions shown are sample data.
                </p>
              </>
            )}
          </>
        )}
      </div>
      <footer className="footer">
        <span>
          <Wordmark /><span className="footer-slash"> / </span>spend. split. treat.
        </span>
        <div>
          <button className="text-button" onClick={() => open("help")}>
            About this preview
          </button>
          <span className="footer-network">spend. split. treat.</span>
        </div>
      </footer>
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          <span>{toast}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {dialog && (
        <Modal
          title={
            dialog === "split"
              ? "Split the bill."
              : dialog === "gift"
                ? "Treat a friend."
                : dialog === "deposit"
                  ? "Add balance."
                  : dialog === "checkout"
                    ? "Try a checkout."
                    : dialog === "limit"
                      ? "Set your limit."
                      : dialog === "share"
                        ? share?.kind === "gift"
                          ? "A treat, ready to share."
                          : share?.kind === "split"
                            ? "Your split is ready."
                            : "Your receipt."
                        : dialog === "settings"
                          ? "Your demo account."
                          : "What’s live?"
          }
          description={
            dialog === "split"
              ? "Choose a purchase. Everyone gets their own share."
              : dialog === "gift"
                ? "A small gesture. A good day."
                : dialog === "checkout"
                  ? "Explore the payment flow with sample funds."
                  : undefined
          }
          close={() => setDialog(null)}
        >
          {dialog === "deposit" && (
            <AmountForm
              kind="deposit"
              initial={10000}
              submit={(a) => {
                const ok = submit(a);
                if (ok) notify("Demo balance added");
                return ok;
              }}
              close={() => setDialog(null)}
            />
          )}
          {dialog === "limit" && (
            <AmountForm
              kind="limit"
              initial={account.limit}
              submit={(a) => {
                const ok = submit(a);
                if (ok) notify("Spending limit saved");
                return ok;
              }}
              close={() => setDialog(null)}
            />
          )}
          {dialog === "split" && (
            <SplitForm
              account={account}
              submit={submit}
              done={showShare}
              transaction={transaction}
            />
          )}
          {dialog === "gift" && <GiftForm submit={submit} done={showShare} />}
          {dialog === "checkout" && (
            <CheckoutForm
              submit={submit}
              done={() => {
                setDialog(null);
                notify("Demo purchase complete. It’s ready to split.");
              }}
            />
          )}
          {dialog === "share" && share && (
            <SharePanel data={share} notify={notify} />
          )}
          {dialog === "settings" && (
            <div className="settings-content">
              <div className="connection-note">
                <Wallet size={20} />
                <p>
                  This sample account lives in your browser. Your connected
                  wallet and its real funds stay separate.
                </p>
              </div>
              <button
                className="button secondary full"
                onClick={downloadActivity}
              >
                <ArrowDownToLine size={17} />
                Export sample transactions
              </button>
              <button className="button danger full" onClick={reset}>
                Reset demo account
              </button>
              <p className="fine-print">
                Reset removes this browser’s sample purchases, splits, and
                gifts.
              </p>
            </div>
          )}
          {dialog === "help" && (
            <div className="help-content">
              <div className="help-intro">
                <HelpCircle size={28} />
                <p>This is an interactive preview of Fomo Pay.</p>
              </div>
              <div className="availability">
                <b>Available now</b>
                <p>
                  Demo checkout, card controls, splits, treats, share links, and
                  receipts. The shared wallet connection is available in the top
                  navigation. Pay sample balances stay separate from your wallet
                  and Orders.
                </p>
              </div>
              <div className="availability">
                <b>Not live yet</b>
                <p>
                  Fomo account access, real card issuing, deposits, merchant
                  payments, and funded gifts. Shared previews do not sync
                  payment or claim status.
                </p>
              </div>
              <p className="fine-print">
                Independent product concept. No affiliation with Fomo, featured
                merchants, or payment networks is claimed.
              </p>
              <button
                className="button primary full"
                onClick={() => setDialog(null)}
              >
                Got it <ArrowRight size={17} />
              </button>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
