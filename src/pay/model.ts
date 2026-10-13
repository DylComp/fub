export type Transaction = {
  id: string;
  merchant: string;
  cents: number;
  kind: "purchase" | "deposit" | "gift" | "refund" | "reimbursement";
  at: string;
  note?: string;
};
export type Share = { name: string; cents: number; paid: boolean };
export type Split = {
  id: string;
  transactionId: string;
  title: string;
  shares: Share[];
  at: string;
};
export type Gift = {
  id: string;
  cents: number;
  to: string;
  message: string;
  status: "sent" | "claimed" | "cancelled";
  at: string;
};
export type Account = {
  version: 1;
  transactions: Transaction[];
  splits: Split[];
  gifts: Gift[];
  frozen: boolean;
  limit: number;
  claimed: string[];
};
export type LinkData = {
  version: 1;
  demo: true;
  kind: "split" | "gift" | "receipt";
  id: string;
  title: string;
  cents: number;
  message?: string;
  shares?: Share[];
};
export const uid = () => crypto.randomUUID();
export const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );
export function parseMoney(value: string): number {
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(value.trim())) return 0;
  return Math.round(Number(value) * 100);
}
export function divide(cents: number, people: number): number[] {
  if (
    !Number.isSafeInteger(cents) ||
    cents < 1 ||
    people < 2 ||
    people > 8 ||
    !Number.isInteger(people)
  )
    throw new Error("Choose 2–8 people and a valid amount.");
  return Array.from(
    { length: people },
    (_, i) => Math.floor(cents / people) + (i < cents % people ? 1 : 0),
  );
}
export const balance = (a: Account) =>
  a.transactions.reduce((sum, t) => sum + t.cents, 0);
export const spent = (a: Account) =>
  -a.transactions
    .filter(
      (t) =>
        t.kind === "purchase" &&
        t.at.slice(0, 7) === new Date().toISOString().slice(0, 7),
    )
    .reduce((s, t) => s + t.cents, 0);
export function initialAccount(): Account {
  const now = Date.now();
  return {
    version: 1,
    frozen: false,
    limit: 100000,
    splits: [],
    gifts: [],
    claimed: [],
    transactions: [
      {
        id: "sample-mcd",
        merchant: "McDonald’s",
        cents: -1247,
        kind: "purchase",
        at: new Date(now - 3600000).toISOString(),
        note: "Big Mac meal",
      },
      {
        id: "sample-uber",
        merchant: "Uber Eats",
        cents: -1842,
        kind: "purchase",
        at: new Date(now - 86400000).toISOString(),
        note: "Dinner delivery",
      },
      {
        id: "sample-spotify",
        merchant: "Spotify",
        cents: -1199,
        kind: "purchase",
        at: new Date(now - 172800000).toISOString(),
        note: "Premium subscription",
      },
      {
        id: "sample-deposit",
        merchant: "Balance added",
        cents: 252604,
        kind: "deposit",
        at: new Date(now - 259200000).toISOString(),
        note: "Sample USDC deposit",
      },
    ],
  };
}
export type Action =
  | { type: "purchase"; merchant: string; cents: number }
  | { type: "deposit"; cents: number }
  | { type: "freeze" }
  | { type: "limit"; cents: number }
  | { type: "split"; split: Split }
  | { type: "settle"; id: string; index: number }
  | { type: "gift"; gift: Gift }
  | { type: "cancelGift"; id: string }
  | { type: "claimGift"; id: string }
  | { type: "reset" };
export function update(a: Account, action: Action): Account {
  const at = new Date().toISOString();
  const add = (transaction: Omit<Transaction, "id" | "at">) => ({
    ...a,
    transactions: [{ ...transaction, id: uid(), at }, ...a.transactions],
  });
  const valid = (c: number) =>
    Number.isSafeInteger(c) && c > 0 && c <= 100000000;
  switch (action.type) {
    case "purchase":
      if (!valid(action.cents)) throw new Error("Enter a valid amount.");
      if (a.frozen) throw new Error("Unfreeze your demo card first.");
      if (action.cents > balance(a))
        throw new Error("Not enough demo balance.");
      if (spent(a) + action.cents > a.limit)
        throw new Error("This exceeds your monthly spending limit.");
      return add({
        merchant: action.merchant,
        cents: -action.cents,
        kind: "purchase",
        note: "Demo checkout",
      });
    case "deposit":
      if (!valid(action.cents)) throw new Error("Enter a valid amount.");
      return add({
        merchant: "Balance added",
        cents: action.cents,
        kind: "deposit",
        note: "Demo top-up",
      });
    case "freeze":
      return { ...a, frozen: !a.frozen };
    case "limit":
      if (!valid(action.cents) || action.cents < spent(a))
        throw new Error("Your limit must cover this month’s spending.");
      return { ...a, limit: action.cents };
    case "split": {
      const tx = a.transactions.find(
        (t) => t.id === action.split.transactionId && t.kind === "purchase",
      );
      if (!tx || a.splits.some((s) => s.transactionId === tx.id))
        throw new Error(
          "This purchase already has a split, or is unavailable.",
        );
      if (
        action.split.shares.length < 2 ||
        action.split.shares.length > 8 ||
        action.split.shares.some((s) => !s.name.trim() || !valid(s.cents)) ||
        action.split.shares.reduce((s, p) => s + p.cents, 0) !== -tx.cents
      )
        throw new Error("Shares must add up to the exact bill total.");
      return { ...a, splits: [action.split, ...a.splits] };
    }
    case "settle": {
      const split = a.splits.find((s) => s.id === action.id);
      const share = split?.shares[action.index];
      if (!share || share.paid || action.index === 0) return a;
      return {
        ...add({
          merchant: share.name,
          cents: share.cents,
          kind: "reimbursement",
          note: split!.title,
        }),
        splits: a.splits.map((s) =>
          s.id === action.id
            ? {
                ...s,
                shares: s.shares.map((p, i) =>
                  i === action.index ? { ...p, paid: true } : p,
                ),
              }
            : s,
        ),
      };
    }
    case "gift":
      if (!valid(action.gift.cents) || action.gift.cents > balance(a))
        throw new Error("Choose an amount within your demo balance.");
      if (!action.gift.to.trim()) throw new Error("Add a recipient name.");
      return {
        ...add({
          merchant: "Treat for " + action.gift.to,
          cents: -action.gift.cents,
          kind: "gift",
          note: action.gift.message,
        }),
        gifts: [action.gift, ...a.gifts],
      };
    case "cancelGift": {
      const gift = a.gifts.find((g) => g.id === action.id);
      if (!gift || gift.status !== "sent") return a;
      return {
        ...add({
          merchant: "Treat cancelled",
          cents: gift.cents,
          kind: "refund",
          note: gift.to,
        }),
        gifts: a.gifts.map((g) =>
          g.id === gift.id ? { ...g, status: "cancelled" } : g,
        ),
      };
    }
    case "claimGift": {
      const gift = a.gifts.find((g) => g.id === action.id);
      if (a.claimed.includes(action.id) || gift?.status === "cancelled")
        return a;
      return {
        ...a,
        claimed: [...a.claimed, action.id],
        gifts: a.gifts.map((g) =>
          g.id === action.id ? { ...g, status: "claimed" } : g,
        ),
      };
    }
    case "reset":
      return initialAccount();
  }
}
export function encodeLink(data: LinkData): string {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  const encoded = btoa(
    Array.from(bytes, (b) => String.fromCharCode(b)).join(""),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${location.origin}/#preview=${encoded}`;
}
export function decodeLink(hash: string): LinkData | null {
  if (!hash.startsWith("#preview=") || hash.length > 12000) return null;
  try {
    const bytes = Uint8Array.from(
      atob(hash.slice(9).replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0),
    );
    const d = JSON.parse(new TextDecoder().decode(bytes));
    if (
      d.version !== 1 ||
      d.demo !== true ||
      !["split", "gift", "receipt"].includes(d.kind) ||
      typeof d.id !== "string" ||
      typeof d.title !== "string" ||
      d.title.length > 100 ||
      !Number.isSafeInteger(d.cents) ||
      d.cents <= 0 ||
      d.cents > 100000000 ||
      (d.message !== undefined &&
        (typeof d.message !== "string" || d.message.length > 200))
    )
      return null;
    if (
      d.kind === "split" &&
      (!Array.isArray(d.shares) ||
        d.shares.length < 2 ||
        d.shares.length > 8 ||
        d.shares.some(
          (s: Share) =>
            typeof s.name !== "string" ||
            s.name.length > 40 ||
            !Number.isSafeInteger(s.cents) ||
            s.cents <= 0 ||
            typeof s.paid !== "boolean",
        ) ||
        d.shares.reduce((sum: number, s: Share) => sum + s.cents, 0) !==
          d.cents)
    )
      return null;
    return d;
  } catch {
    return null;
  }
}
// Old Pay accounts are local sample data. Validate nested records before rendering
// so a partial/corrupt saved account cannot crash the restored workspace.
export function loadAccount(): Account {
  try {
    const a = JSON.parse(localStorage.getItem("fomo-pay.demo.v1") || "null");
    const text = (v: unknown): v is string => typeof v === "string";
    const positive = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
    const share = (s: Share) =>
      s && text(s.name) && positive(s.cents) && typeof s.paid === "boolean";
    if (
      a?.version === 1 &&
      typeof a.frozen === "boolean" &&
      positive(a.limit) &&
      Array.isArray(a.transactions) &&
      a.transactions.every(
        (t: Transaction) =>
          t &&
          text(t.id) &&
          Number.isSafeInteger(t.cents) &&
          text(t.at) &&
          Number.isFinite(Date.parse(t.at)) &&
          text(t.merchant) &&
          ["purchase", "deposit", "gift", "refund", "reimbursement"].includes(
            t.kind,
          ) &&
          (t.note === undefined || text(t.note)),
      ) &&
      Array.isArray(a.splits) &&
      a.splits.every(
        (s: Split) =>
          s &&
          text(s.id) &&
          text(s.transactionId) &&
          text(s.title) &&
          text(s.at) &&
          Array.isArray(s.shares) &&
          s.shares.length >= 2 &&
          s.shares.length <= 8 &&
          s.shares.every(share),
      ) &&
      Array.isArray(a.gifts) &&
      a.gifts.every(
        (g: Gift) =>
          g &&
          text(g.id) &&
          positive(g.cents) &&
          text(g.to) &&
          text(g.message) &&
          text(g.at) &&
          ["sent", "claimed", "cancelled"].includes(g.status),
      ) &&
      Array.isArray(a.claimed) &&
      a.claimed.every(text)
    )
      return a;
  } catch {
    /* A clean sample account remains usable when storage is unavailable. */
  }
  return initialAccount();
}
