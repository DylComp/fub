import { useState } from "react";
import {
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  Gift as GiftIcon,
  Plus,
  Minus,
  Users,
  CreditCard,
} from "lucide-react";
import type {
  Account,
  Action,
  Gift,
  LinkData,
  Split,
  Transaction,
} from "./model";
import { divide, encodeLink, money, parseMoney, uid } from "./model";
import { MerchantLogo, Avatar } from "./ui";

type Submit = (action: Action) => boolean;
export function SplitForm({
  account,
  submit,
  done,
  transaction,
}: {
  account: Account;
  submit: Submit;
  done: (data: LinkData) => void;
  transaction?: Transaction;
}) {
  const available = account.transactions.filter(
    (t) =>
      t.kind === "purchase" &&
      !account.splits.some((s) => s.transactionId === t.id),
  );
  const [selected, setSelected] = useState(
    transaction?.id || available[0]?.id || "",
  );
  const [people, setPeople] = useState(3);
  const [custom, setCustom] = useState(false);
  const [names, setNames] = useState([
    "You",
    "Alex",
    "Sam",
    "Friend 3",
    "Friend 4",
    "Friend 5",
    "Friend 6",
    "Friend 7",
  ]);
  const [amounts, setAmounts] = useState<string[]>([]);
  const tx = available.find((t) => t.id === selected);
  const total = tx ? -tx.cents : 0;
  const equal = total ? divide(total, people) : [];
  const shares = Array.from({ length: people }, (_, i) => ({
    name: names[i].trim(),
    cents: custom ? parseMoney(amounts[i] || "") : equal[i],
    paid: i === 0,
  }));
  const sum = shares.reduce((s, p) => s + (p.cents || 0), 0);
  function changeCount(n: number) {
    setPeople(n);
    setAmounts(divide(total, n).map((c) => (c / 100).toFixed(2)));
  }
  if (!tx)
    return (
      <div className="empty-form">
        <Users size={32} />
        <h3>Start with a purchase</h3>
        <p>Try a demo checkout, then split that bill here.</p>
      </div>
    );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const split: Split = {
          id: uid(),
          transactionId: tx.id,
          title: tx.merchant,
          shares,
          at: new Date().toISOString(),
        };
        if (submit({ type: "split", split }))
          done({
            version: 1,
            demo: true,
            kind: "split",
            id: split.id,
            title: split.title,
            cents: total,
            shares,
          });
      }}
    >
      <label className="field">
        Choose a purchase
        <select
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value);
            setCustom(false);
          }}
          aria-label="Choose a purchase"
        >
          {available.map((t) => (
            <option key={t.id} value={t.id}>
              {t.merchant} · {money(-t.cents)}
            </option>
          ))}
        </select>
      </label>
      <div className="form-row">
        <label>People, including you</label>
        <div className="stepper">
          <button
            type="button"
            aria-label="Remove person"
            disabled={people <= 2}
            onClick={() => changeCount(people - 1)}
          >
            <Minus size={16} />
          </button>
          <b>{people}</b>
          <button
            type="button"
            aria-label="Add person"
            disabled={people >= 8}
            onClick={() => changeCount(people + 1)}
          >
            <Plus size={16} />
          </button>
        </div>
      </div>
      <div className="segmented">
        <button
          type="button"
          className={!custom ? "selected" : ""}
          onClick={() => setCustom(false)}
        >
          Split equally
        </button>
        <button
          type="button"
          className={custom ? "selected" : ""}
          onClick={() => {
            setCustom(true);
            setAmounts(equal.map((c) => (c / 100).toFixed(2)));
          }}
        >
          Custom amounts
        </button>
      </div>
      <div className="share-rows">
        {shares.map((s, i) => (
          <div className="share-row" key={i}>
            <Avatar name={names[i]} index={i} />
            <input
              aria-label={`Person ${i + 1} name`}
              maxLength={40}
              value={names[i]}
              disabled={i === 0}
              onChange={(e) =>
                setNames(names.map((n, j) => (i === j ? e.target.value : n)))
              }
            />
            {custom ? (
              <div className="amount-input">
                <span>$</span>
                <input
                  aria-label={`Person ${i + 1} amount`}
                  inputMode="decimal"
                  value={amounts[i] || ""}
                  onChange={(e) =>
                    setAmounts(
                      amounts.map((a, j) => (j === i ? e.target.value : a)),
                    )
                  }
                />
              </div>
            ) : (
              <b>{money(s.cents)}</b>
            )}
          </div>
        ))}
      </div>
      <div className="total-line">
        <span>Bill total</span>
        <b>{money(total)}</b>
      </div>
      {sum !== total && (
        <p className="form-error">
          Shares must total {money(total)}. Currently {money(sum)}.
        </p>
      )}
      <button
        className="button primary full"
        disabled={sum !== total || shares.some((s) => !s.name || s.cents <= 0)}
        type="submit"
      >
        Create split link <ArrowRight size={17} />
      </button>
      <p className="fine-print">
        Demo link. No money requested or transferred.
      </p>
    </form>
  );
}

export function GiftForm({
  submit,
  done,
}: {
  submit: Submit;
  done: (data: LinkData) => void;
}) {
  const [amount, setAmount] = useState("15");
  const [to, setTo] = useState("");
  const [message, setMessage] = useState("Lunch is on me.");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const gift: Gift = {
          id: uid(),
          cents: parseMoney(amount),
          to: to.trim(),
          message: message.trim(),
          status: "sent",
          at: new Date().toISOString(),
        };
        if (submit({ type: "gift", gift }))
          done({
            version: 1,
            demo: true,
            kind: "gift",
            id: gift.id,
            title: gift.to,
            cents: gift.cents,
            message: gift.message,
          });
      }}
    >
      <div className="gift-preview">
        <GiftIcon size={34} strokeWidth={1.5} />
        <span>A little something for</span>
        <strong>{to || "someone good"}</strong>
        <div>{money(parseMoney(amount))}</div>
      </div>
      <label className="field">
        Their name
        <input
          value={to}
          maxLength={40}
          placeholder="e.g. Alex"
          onChange={(e) => setTo(e.target.value)}
          required
        />
      </label>
      <label className="field">
        Amount in USD
        <div className="input-prefix">
          <span>$</span>
          <input
            aria-label="Gift amount"
            value={amount}
            inputMode="decimal"
            onChange={(e) => setAmount(e.target.value)}
            required
          />
        </div>
      </label>
      <div className="amount-options">
        {[10, 15, 25, 50].map((n) => (
          <button
            key={n}
            type="button"
            className={amount === String(n) ? "selected" : ""}
            onClick={() => setAmount(String(n))}
          >
            ${n}
          </button>
        ))}
      </div>
      <label className="field">
        Add a note
        <textarea
          value={message}
          maxLength={160}
          onChange={(e) => setMessage(e.target.value)}
          rows={2}
        />
      </label>
      <button
        type="submit"
        className="button primary full"
        disabled={!to.trim() || !parseMoney(amount)}
      >
        Create treat link <ArrowRight size={17} />
      </button>
      <p className="fine-print">
        Reserves demo funds. Cancel an unclaimed treat to return them.
      </p>
    </form>
  );
}

export function AmountForm({
  kind,
  initial,
  submit,
  close,
}: {
  kind: "deposit" | "limit";
  initial: number;
  submit: Submit;
  close: () => void;
}) {
  const [value, setValue] = useState((initial / 100).toString());
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (submit({ type: kind, cents: parseMoney(value) })) close();
      }}
    >
      <label className="field">
        {kind === "deposit" ? "Add demo balance" : "Monthly card limit"}
        <div className="input-prefix large-input">
          <span>$</span>
          <input
            autoFocus
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label="Amount"
          />
        </div>
      </label>
      <div className="amount-options">
        {[25, 100, 250, 1000].map((n) => (
          <button type="button" key={n} onClick={() => setValue(String(n))}>
            ${n}
          </button>
        ))}
      </div>
      <button type="submit" className="button primary full">
        {kind === "deposit" ? "Add demo funds" : "Save limit"}
        <ArrowRight size={17} />
      </button>
      <p className="fine-print">
        {kind === "deposit"
          ? "Sample funds only. This does not deposit or move real crypto."
          : "Applies to purchases in this demo account."}
      </p>
    </form>
  );
}

const merchants = [
  {
    name: "McDonald’s",
    icon: "M",
    amount: 12.47,
    item: "Big Mac meal",
    color: "mcd",
  },
  {
    name: "Uber Eats",
    icon: "U",
    amount: 18.42,
    item: "Dinner delivery",
    color: "uber",
  },
  {
    name: "Amazon",
    icon: "a",
    amount: 48.99,
    item: "Online order",
    color: "amazon",
  },
  {
    name: "Nike",
    icon: "N",
    amount: 114.95,
    item: "Online order",
    color: "nike",
  },
];
export function CheckoutForm({
  submit,
  done,
}: {
  submit: Submit;
  done: () => void;
}) {
  const [selected, setSelected] = useState(0);
  const m = merchants[selected];
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (
          submit({
            type: "purchase",
            merchant: m.name,
            cents: Math.round(m.amount * 100),
          })
        )
          done();
      }}
    >
      <div className="merchant-options">
        {merchants.map((merchant, i) => (
          <button
            key={merchant.name}
            type="button"
            className={selected === i ? "selected" : ""}
            onClick={() => setSelected(i)}
          >
            <MerchantLogo name={merchant.name} />
            {merchant.name}
          </button>
        ))}
      </div>
      <div className="checkout-order">
        <MerchantLogo name={m.name} big />
        <div>
          <b>{m.name}</b>
          <span>{m.item}</span>
        </div>
        <b>{money(Math.round(m.amount * 100))}</b>
      </div>
      <div className="payment-source">
        <CreditCard size={19} />
        <span>Fomo Pay demo card</span>
        <span>•• 4242</span>
      </div>
      <div className="total-line">
        <span>Total</span>
        <strong>{money(Math.round(m.amount * 100))}</strong>
      </div>
      <button className="button primary full" type="submit">
        Simulate purchase <ArrowRight size={17} />
      </button>
      <p className="fine-print">
        Interactive checkout example. No merchant order is placed.
      </p>
    </form>
  );
}

export function SharePanel({
  data,
  notify,
}: {
  data: LinkData;
  notify: (s: string) => void;
}) {
  const url = encodeLink(data);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      notify("Link copied");
    } catch {
      notify("Select and copy the link below.");
    }
  };
  return (
    <div>
      <div className={`receipt ${data.kind}`}>
        <div className="receipt-top">
          <span>fomo pay</span>
          <span>DEMO</span>
        </div>
        <div className="receipt-symbol">
          {data.kind === "gift" ? (
            <GiftIcon />
          ) : data.kind === "split" ? (
            <Users />
          ) : (
            <Check />
          )}
        </div>
        <p>
          {data.kind === "gift"
            ? `A treat for ${data.title}`
            : data.kind === "split"
              ? "One bill. Shared."
              : data.title}
        </p>
        <strong>{money(data.cents)}</strong>
        <span>
          {data.kind === "gift"
            ? data.message
            : data.kind === "split"
              ? `${data.shares?.length} people · ${data.title}`
              : "Sample purchase receipt"}
        </span>
        <div className="receipt-bottom">
          spend. split. treat.<span>↗</span>
        </div>
      </div>
      <label className="field">
        Share preview link
        <input
          value={url}
          readOnly
          onFocus={(e) => e.target.select()}
          aria-label="Share preview link"
        />
      </label>
      <button className="button primary full" onClick={copy}>
        <Copy size={17} /> Copy link
      </button>
      <a
        className="button secondary full"
        href={url}
        target="_blank"
        rel="noreferrer"
      >
        Open recipient preview <ExternalLink size={16} />
      </a>
      <p className="fine-print">
        Demo links carry sample details, not funds. Preview changes stay on each
        device; sender and recipient do not sync yet.
      </p>
    </div>
  );
}
