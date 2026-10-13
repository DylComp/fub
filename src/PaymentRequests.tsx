import { useEffect, useRef, useState } from "react";
import { ArrowRight, Copy } from "lucide-react";
import { PayTransfer } from "./PayTransfer";
import { Wordmark } from "./ui";
import {
  payAmount,
  payCents,
  payLink,
  payShares,
  readPayLink,
} from "./pay-model";
import type { PayRequest } from "./pay-model";
import {
  loadSavedRequests,
  saveRequest,
  removeSavedRequest,
  requestKey,
  PAY_REQUESTS_KEY,
} from "./pay-request-storage";
import {useWalletSetup} from './WalletSetup';
import {FomoLeaderPicker} from './FomoLeaderPicker';
import type {FomoIdentity} from './fomo-identity';
import {readPurchaseSplit,PURCHASE_SPLIT_KEY} from './pay-purchase-split';
import { USDC } from "./funding-model";

export function PaymentRequests({initialMode='split'}:{initialMode?:'split'|'treat'}={}) {
  const {connection}=useWalletSetup();
  const owner=connection.session?.address;
  const recipientInput=useRef<HTMLInputElement>(null);
  const [recipientIdentity,setRecipientIdentity]=useState<FomoIdentity>();
  const [saved, setSaved] = useState(loadSavedRequests);
  useEffect(() => {
    const refresh = (e: StorageEvent) => {
      if (e.key === PAY_REQUESTS_KEY || e.key === null)
        setSaved(loadSavedRequests());
    };
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, []);
  function save(r: PayRequest) {
    try {
      setSaved(saveRequest(r));
      setNotice("Request saved on this device.");
    } catch {
      setNotice(
        "This browser could not save the request. Copy its link before leaving.",
      );
    }
  }
  const composer = useRef<HTMLFormElement>(null);
  const [mode, setMode] = useState<"split" | "treat">(initialMode);
  const [title, setTitle] = useState(""),
    [amount, setAmount] = useState(""),
    [recipient, setRecipient] = useState("");
  useEffect(()=>{
    if(initialMode==='split'&&owner){
      let draft=null;try{draft=readPurchaseSplit(sessionStorage.getItem(PURCHASE_SPLIT_KEY),owner);if(draft)sessionStorage.removeItem(PURCHASE_SPLIT_KEY);}catch{}
      if(draft){setTitle(draft.title);setAmount(draft.amount);setRecipient(draft.wallet);}
      else setRecipient(current=>current||owner);
    }
  },[owner,initialMode]);
  const [names, setNames] = useState(initialMode === "treat" ? [""] : ["You", ""]),
    [message, setMessage] = useState("");
  const [request, setRequest] = useState(() => readPayLink(location.hash));
  const [invalid, setInvalid] = useState(
    () => location.hash.startsWith("#pay=") && !readPayLink(location.hash),
  );
  const [selected, setSelected] = useState(1),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  useEffect(() => {
    const restore = () => {
      const next = readPayLink(location.hash);
      setRequest(next);
      setSelected(next?.kind === "treat" ? 0 : 1);
      setInvalid(location.hash.startsWith("#pay=") && !next);
      setNotice("");
    };
    restore();
    window.addEventListener("hashchange", restore);
    window.addEventListener("popstate", restore);
    return () => {
      window.removeEventListener("hashchange", restore);
      window.removeEventListener("popstate", restore);
    };
  }, []);
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Copied.");
    } catch {
      setNotice("Copy failed. Select and copy the text manually.");
    }
  }
  function create(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setNotice("");
    try {
      const next: PayRequest = {
        version: 2,
        id: crypto.randomUUID(),
        kind: mode,
        title:
          title.trim() || (mode === "split" ? "Our order" : "Lunch is on me."),
        recipient: recipient.trim(),
        cents: payCents(amount),
        names: names.map((n) => n.trim()),
        message: message.trim(),
      };
      const link = payLink(next, location.origin);
      history.pushState(null, "", link);
      setRequest(next);
      setSelected(mode === "split" ? 1 : 0);
      setInvalid(false);
      save(next);
      window.scrollTo({ top: 0, behavior: "instant" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Check the payment details.");
    }
  }
  function fresh() {
    history.pushState(null, "", "#pay-request");
    window.scrollTo({ top: 0, behavior: "instant" });
    setRequest(null);
    setInvalid(false);
    setNotice("");
    setError("");
  }
  function changeMode(next: "split" | "treat") {
    setMode(next);
    setRecipient(next==="split"?owner||"":"");setRecipientIdentity(undefined);
    setNames(next === "split" ? ["You", ""] : [""]);
    setError("");
  }
  if (invalid)
    return (
      <section className="pay-request">
        <h1>This link cannot be read.</h1>
        <p>Ask the sender for a new link. No payment has been requested.</p>
        <button className="button secondary" onClick={fresh}>
          Open Fomo Pay
        </button>
      </section>
    );
  if (request) {
    const shares = payShares(request.cents, request.names.length);
    return (
      <section className="pay-request" aria-label="Payment request">
        <div className="pay-request-top">
          <span className="pay-label">
            {request.kind === "split" ? "SPLIT WITH FOMO" : "TREAT A FRIEND"}
          </span>
          <button className="word-link" onClick={fresh}>
            Create another <ArrowRight size={15} />
          </button>
        </div>
        <h1>{request.title}</h1>
        <p className="pay-big-amount">
          {payAmount(request.cents)} <span>USDC</span>
        </p>
        {request.message && <p className="pay-message">{request.message}</p>}
        <div className="pay-shares">
          {request.names.map((name, i) => (
            <button
              key={i}
              className={selected === i ? "selected" : ""}
              disabled={request.kind === "split" && i === 0}
              onClick={() => {
                setSelected(i);
                setNotice("");
              }}
            >
              <span>
                {name}
                {request.kind === "split" && i === 0 ? " · organizer" : ""}
              </span>
              <b>{payAmount(shares[i])} USDC</b>
            </button>
          ))}
        </div>
        <dl className="pay-details">
          <div>
            <dt>Receiving Solana wallet</dt>
            <dd>{request.recipient}</dd>
          </div>
          <div>
            <dt>Token</dt>
            <dd>
              USDC on Solana <span>{USDC}</span>
            </dd>
          </div>
          <div>
            <dt>Amount to send</dt>
            <dd>{payAmount(shares[selected] ?? shares[0])} USDC</dd>
          </div>
        </dl>
        <p className="pay-note">
          Check the receiving address with the sender. This link contains
          user-supplied details and does not verify a Fomo identity. Opening a
          wallet does not mark a share as paid.
        </p>
        {request.kind === "treat" && (
          <p className="pay-note">
            This is a payment instruction for the person giving the treat. It is
            not a funded gift or a claim link.
          </p>
        )}
        <PayTransfer
          key={`${request.id}:${selected}:${request.recipient}:${request.cents}:${request.names.length}:${request.version}`}
          request={request}
          index={request.kind === "treat" ? 0 : selected}
          copy={copy}
        />
        <label className="field">
          Share link
          <input
            readOnly
            value={payLink(request, location.origin)}
            onFocus={(e) => e.currentTarget.select()}
          />
        </label>
        <button
          className="word-link"
          onClick={() => copy(payLink(request, location.origin))}
        >
          <Copy size={14} /> Copy link
        </button>
        <button className="word-link pay-save" onClick={() => save(request)}>
          {saved.some((r) => requestKey(r) === requestKey(request))
            ? "Saved on this device"
            : "Save link on this device"}
        </button>
        <p role="status" className="pay-note">
          {notice}
        </p>
      </section>
    );
  }
  return (
    <div className="pay-workspace">
      {saved.length > 0 && (
        <section className="pay-saved" aria-label="Saved payment requests">
          <h2>Saved requests</h2>
          <p className="pay-note">
            Your latest 30 links on this device. Open a request to check its
            payment status on Solana. Removing a saved link does not cancel it.
          </p>
          <div>
            {saved.map((r) => (
              <div className="pay-saved-row" key={requestKey(r)}>
                <a href={payLink(r, location.origin)}>
                  <b>{r.title}</b>
                  <span>
                    {r.kind === "split"
                      ? `${r.names.length} people`
                      : `For ${r.names[0]}`}{" "}
                    · {payAmount(r.cents)} USDC
                  </span>
                </a>
                <button
                  className="word-link"
                  aria-label={`Remove saved link: ${r.title}`}
                  onClick={() => {
                    try {
                      setSaved(removeSavedRequest(r));
                      setNotice("Saved link removed from this device.");
                    } catch {
                      setNotice(
                        "This browser could not remove the saved link.",
                      );
                    }
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
      {notice && (
        <p className="pay-note" role="status">
          {notice}
        </p>
      )}
      <section className="pay-intro-grid">
        <div className="pay-intro">
          <span className="pay-label">FOMO PAY</span>
          <h1>
            Good trades.
            <br />
            Real life.
          </h1>
          <p>
            Split the food order. Pick up a friend’s lunch. Keep the money part
            simple.
          </p>
          <div
            className="pay-friends"
            aria-label="Illustrative friend portraits"
          >
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                style={{ backgroundPosition: `${i * 50}% center` }}
              />
            ))}
            <small>Better together.</small>
          </div>
          <button
            className="button primary pay-start"
            onClick={() => {
              composer.current?.scrollIntoView({
                behavior: "smooth",
                block: "start",
              });
              composer.current
                ?.querySelector<HTMLInputElement>("input")
                ?.focus({ preventScroll: true });
            }}
          >
            Make a split or treat <ArrowRight size={16} />
          </button>
        </div>
        <div className="pay-card-wrap">
          <div className="pay-card" aria-label="Fomo Pay card design">
            <div>
              <Wordmark />
              <b>pay</b>
            </div>
            <span className="pay-card-rule" />
            <p>
              For life
              <br />
              after the trade.
            </p>
          </div>
        </div>
      </section>
      <section className="pay-main-grid">
        <div className="pay-stories">
          <h2>One bill. Everyone’s share.</h2>
          <p>
            Pay for the group, then send a link with the exact amount each
            friend owes. No account needed to create it.
          </p>
          <div className="pay-story-line">
            <span>01</span>
            <div>
              <h3>Split with Fomo</h3>
              <p>
                The total stays exact, including the last cent. Your own share
                stays out of the payment requests.
              </p>
            </div>
          </div>
          <div className="pay-story-line">
            <span>02</span>
            <div>
              <h3>Treat a friend</h3>
              <p>
                Choose an amount, add a message, and review a transfer to their
                Solana wallet.
              </p>
            </div>
          </div>
          <div className="pay-gift-art" aria-hidden="true">
            <span>FOR SOMEONE GOOD.</span>
            <div>
              Lunch is
              <br />
              on me.
            </div>
            <Wordmark />
          </div>
        </div>
        <form ref={composer} className="pay-compose" onSubmit={create}>
          <div className="pay-mode" aria-label="Payment type">
            {(["split", "treat"] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={mode === m ? "selected" : ""}
                aria-pressed={mode === m}
                onClick={() => changeMode(m)}
              >
                {m === "split" ? "Split a bill" : "Treat a friend"}
              </button>
            ))}
          </div>
          <label className="field">
            {mode === "split" ? "What did you split?" : "Title"}
            <input
              value={title}
              maxLength={80}
              placeholder={
                mode === "split" ? "Dinner with friends" : "Lunch is on me."
              }
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="field">
            Amount in USDC
            <input
              required
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <FomoLeaderPicker address={recipient} identity={recipientIdentity} active={true} inputRef={recipientInput} purpose={mode==='split'?'owner':'recipient'} onChange={(address,identity)=>{setRecipient(address);setRecipientIdentity(identity);}} />
          {mode==='split'&&owner&&recipient!==owner&&<button className="word-link" type="button" onClick={()=>{setRecipient(owner);setRecipientIdentity(undefined);}}>Use connected wallet</button>}
          {mode === "split" && (
            <label className="field">
              People, including you
              <select
                value={names.length}
                onChange={(e) =>
                  setNames(
                    Array.from(
                      { length: Number(e.target.value) },
                      (_, i) => names[i] ?? "",
                    ),
                  )
                }
              >
                {[2, 3, 4, 5, 6, 7, 8].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
          )}
          <div className="pay-names">
            {names.map((name, i) => (
              <label className="field" key={i}>
                {mode === "treat"
                  ? "Friend’s name"
                  : i === 0
                    ? "Your name"
                    : `Friend ${i}`}
                <input
                  required
                  maxLength={40}
                  value={name}
                  onChange={(e) =>
                    setNames((prev) =>
                      prev.map((n, j) => (j === i ? e.target.value : n)),
                    )
                  }
                />
              </label>
            ))}
          </div>
          <label className="field">
            Message <span>(optional)</span>
            <textarea
              rows={2}
              maxLength={200}
              value={message}
              placeholder="Thanks for a good night."
              onChange={(e) => setMessage(e.target.value)}
            />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="button primary full" type="submit">
            {mode === "split" ? "Create split link" : "Review treat"}{" "}
            <ArrowRight size={16} />
          </button>
          <p className="pay-note">
            Names, amounts, message and receiving address are visible to anyone
            with the link. Creating it does not move money.
          </p>
        </form>
      </section>
      <section className="pay-spend">
        <div>
          <span className="pay-label">EVERYDAY SPENDING</span>
          <h2>Put your USDC to use.</h2>
          <p>
            Buy merchant gift cards with USDC, split a bill, or send a direct
            treat from your connected Fomo wallet.
          </p>
        </div>
        <div
          className="pay-merchants"
          aria-label="Illustrative merchants, no partnership claimed"
        >
          {["mcdonalds", "ubereats", "spotify", "amazon"].map((name) => (
            <span key={name}>
              <img
                src={`/brands/${name}.svg`}
                alt={
                  name === "mcdonalds"
                    ? "McDonald’s"
                    : name === "ubereats"
                      ? "Uber Eats"
                      : name === "spotify"
                        ? "Spotify"
                        : "Amazon"
                }
              />
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}
