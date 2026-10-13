import { ADDRESSES, idFor, isMint, priceDecimals } from "./assets";
import type { DiscoveredToken } from "./assets";
// Legacy field name: a symbol key is a built-in alias or an exact mint, never a custom ticker.
export type Symbol = string;
export type Kind = "Bracket" | "Limit" | "Trailing";
export type Status = "Watching" | "Partially filled" | "Filled" | "Cancelled";
export type Token = {
  id: string;
  address: string;
  image?: string;
  symbol: Symbol;
  name: string;
  price: number;
  quantity: number;
  change: number;
  decimals: number;
};
export const TOKENS: Token[] = [
  {
    id: "SOL",
    address: ADDRESSES.SOL,
    symbol: "SOL",
    name: "Solana",
    price: 148.72,
    quantity: 12.5,
    change: 4.82,
    decimals: 2,
  },
  {
    id: "JUP",
    address: ADDRESSES.JUP,
    symbol: "JUP",
    name: "Jupiter",
    price: 0.824,
    quantity: 800,
    change: 3.16,
    decimals: 4,
  },
  {
    id: "BONK",
    address: ADDRESSES.BONK,
    symbol: "BONK",
    name: "Bonk",
    price: 0.0000214,
    quantity: 18000000,
    change: -2.34,
    decimals: 8,
  },
];
export type Draft = {
  symbol: Symbol;
  kind: Kind;
  side: "Buy" | "Sell";
  quantity: number;
  target: number;
  stop: number;
  trail: number;
  days: number;
};
export type Order = Draft & {
  id: string;
  status: Status;
  filled: number;
  high: number;
  createdAt: string;
  expiresAt: string;
  triggeredLeg?: "target" | "stop";
};
export type Event = {
  id: string;
  orderId: string;
  at: string;
  title: string;
  detail: string;
};
export type Account = {
  version: 2;
  tokens: Token[];
  cash: number;
  holdings: Record<Symbol, number>;
  prices: Record<Symbol, number>;
  orders: Order[];
  events: Event[];
};
export const STORAGE_KEY = "fomo-orders.preview.v2";
export const usd = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    n,
  );
export const quantityLabel = (n: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(n);
export const priceLabel = (symbol: Symbol, n: number) =>
  "$" +
  n.toFixed(TOKENS.find((t) => t.id === symbol)?.decimals ?? priceDecimals(n));
export const active = (o: Order) =>
  o.status === "Watching" || o.status === "Partially filled";
export function available(a: Account, symbol: Symbol) {
  return Math.max(
    0,
    a.holdings[symbol] -
      a.orders
        .filter((o) => active(o) && o.side === "Sell" && o.symbol === symbol)
        .reduce((sum, o) => sum + o.quantity - o.filled, 0),
  );
}
export function availableCash(a: Account) {
  return Math.max(
    0,
    a.cash -
      a.orders
        .filter((o) => active(o) && o.side === "Buy")
        .reduce((sum, o) => sum + (o.quantity - o.filled) * o.target, 0),
  );
}
export function defaultDraft(
  a: Account,
  symbol: Symbol,
  kind: Kind = "Limit",
): Draft {
  const p = a.prices[symbol];
  const precision =
    10 ** (TOKENS.find((t) => t.id === symbol)?.decimals ?? priceDecimals(p));
  const buying = kind === "Limit" && available(a, symbol) === 0;
  return {
    symbol,
    kind,
    side: buying ? "Buy" : "Sell",
    quantity: buying
      ? Math.floor((Math.min(100, availableCash(a)) / p) * 1e6) / 1e6
      : Math.floor(available(a, symbol) * 0.25 * 1e6) / 1e6,
    target: Math.round(p * (buying ? 0.9 : 1.15) * precision) / precision,
    stop: Math.round(p * 0.9 * precision) / precision,
    trail: 10,
    days: 7,
  };
}
export function validate(a: Account, d: Draft): string | null {
  if (
    !a.tokens.some((t) => t.id === d.symbol) ||
    !["Bracket", "Limit", "Trailing"].includes(d.kind) ||
    !["Buy", "Sell"].includes(d.side)
  )
    return "Choose a valid order type.";
  if (
    !Number.isFinite(d.quantity) ||
    d.quantity <= 0 ||
    !Number.isFinite(d.quantity * a.prices[d.symbol])
  )
    return "Enter an amount greater than zero.";
  if (!Number.isInteger(d.days) || d.days < 1 || d.days > 30)
    return "Choose an expiry between 1 and 30 days.";
  if (d.kind !== "Limit" && d.side !== "Sell")
    return "Bracket and trailing orders close an existing position.";
  if (d.kind !== "Trailing" && (!Number.isFinite(d.target) || d.target <= 0))
    return "Enter a valid target price.";
  if (
    d.kind === "Bracket" &&
    (!Number.isFinite(d.stop) ||
      d.stop <= 0 ||
      d.stop >= a.prices[d.symbol] ||
      d.target <= a.prices[d.symbol])
  )
    return "Put the target above the reference price and the stop below it.";
  if (
    d.kind === "Limit" &&
    (d.side === "Buy"
      ? d.target >= a.prices[d.symbol]
      : d.target <= a.prices[d.symbol])
  )
    return d.side === "Buy"
      ? "Set a buy limit below the reference price."
      : "Set a sell limit above the reference price.";
  if (
    d.kind === "Trailing" &&
    (!Number.isFinite(d.trail) || d.trail < 1 || d.trail > 50)
  )
    return "Choose a trailing distance from 1% to 50%.";
  if (d.side === "Sell" && d.quantity > available(a, d.symbol) + 1e-8)
    return "This amount is already allocated or exceeds your sample position.";
  if (d.side === "Buy" && d.quantity * d.target > availableCash(a) + 1e-8)
    return "This exceeds your unallocated sample USDC.";
  return null;
}
function event(orderId: string, title: string, detail: string): Event {
  return {
    id: crypto.randomUUID(),
    orderId,
    title,
    detail,
    at: new Date().toISOString(),
  };
}
export function createOrder(a: Account, d: Draft): Account {
  const error = validate(a, d);
  if (error) throw new Error(error);
  const id = crypto.randomUUID();
  const now = Date.now();
  const order: Order = {
    ...d,
    id,
    status: "Watching",
    filled: 0,
    high: a.prices[d.symbol],
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + d.days * 86400000).toISOString(),
  };
  return {
    ...a,
    orders: [order, ...a.orders],
    events: [
      event(
        id,
        "Preview order created",
        `${d.side} ${quantityLabel(d.quantity)} ${tokenLabel(a, d.symbol)} · ${d.kind}`,
      ),
      ...a.events,
    ],
  };
}
export function cancelOrder(a: Account, id: string): Account {
  if (!a.orders.some((o) => o.id === id && active(o))) return a;
  return {
    ...a,
    orders: a.orders.map((o) =>
      o.id === id ? { ...o, status: "Cancelled" } : o,
    ),
    events: [
      event(
        id,
        "Preview order cancelled",
        "Unfilled allocation released. No real funds moved.",
      ),
      ...a.events,
    ],
  };
}
export function simulate(
  a: Account,
  symbol: Symbol,
  price: number,
  fraction = 1,
): Account {
  if (
    !a.tokens.some((t) => t.id === symbol) ||
    !Number.isFinite(price) ||
    price <= 0 ||
    ![0.5, 1].includes(fraction)
  )
    throw new Error("Enter a valid positive sample price.");
  const next: Account = {
    ...a,
    cash: a.cash,
    holdings: { ...a.holdings },
    prices: { ...a.prices, [symbol]: price },
    events: [...a.events],
    orders: [],
  };
  next.orders = a.orders.map((o) => {
    if (!active(o)) return o;
    if (Date.parse(o.expiresAt) <= Date.now()) {
      next.events.unshift(
        event(o.id, "Preview order expired", "Unfilled allocation released."),
      );
      return { ...o, status: "Cancelled" };
    }
    if (o.symbol !== symbol) return o;
    const high = Math.max(o.high, price);
    const triggered =
      o.kind === "Trailing"
        ? price <= high * (1 - o.trail / 100)
        : o.kind === "Bracket"
          ? o.triggeredLeg === "target"
            ? price >= o.target
            : o.triggeredLeg === "stop"
              ? price <= o.stop
              : price >= o.target || price <= o.stop
          : o.side === "Buy"
            ? price <= o.target
            : price >= o.target;
    if (!triggered) return { ...o, high };
    const amount = (o.quantity - o.filled) * fraction;
    next.cash += amount * price * (o.side === "Sell" ? 1 : -1);
    next.holdings[symbol] += amount * (o.side === "Buy" ? 1 : -1);
    const status: Status = fraction === 1 ? "Filled" : "Partially filled";
    next.events.unshift(
      event(
        o.id,
        `Preview ${status.toLowerCase()}`,
        `${o.side} ${quantityLabel(amount)} ${tokenLabel(a, symbol)} at ${priceLabel(symbol, price)} · simulated, fees excluded`,
      ),
    );
    return {
      ...o,
      high,
      filled: o.filled + amount,
      status,
      ...(o.kind === "Bracket"
        ? {
            triggeredLeg:
              o.triggeredLeg ||
              (price >= o.target ? ("target" as const) : ("stop" as const)),
          }
        : {}),
    };
  });
  return next;
}
export function initialAccount(): Account {
  let a: Account = {
    version: 2,
    tokens: TOKENS,
    cash: 1000,
    holdings: { SOL: 12.5, JUP: 800, BONK: 18000000 },
    prices: { SOL: 148.72, JUP: 0.824, BONK: 0.0000214 },
    orders: [],
    events: [],
  };
  a = createOrder(a, {
    ...defaultDraft(a, "SOL"),
    quantity: 2,
    target: 165,
    stop: 132,
  });
  return createOrder(a, {
    ...defaultDraft(a, "JUP", "Limit"),
    side: "Buy",
    quantity: 100,
    target: 0.72,
  });
}
export function loadAccount(): Account {
  try {
    const a = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    // Migrate existing preview accounts without changing their orders or balances.
    if (a?.version === 2 && a.tokens === undefined) a.tokens = TOKENS;
    const number = (n: unknown) =>
      typeof n === "number" && Number.isFinite(n) && n >= 0;
    if (
      a?.version === 2 &&
      number(a.cash) &&
      Array.isArray(a.tokens) &&
      a.tokens.length >= 3 &&
      a.tokens.length <= 100 &&
      a.tokens.every(
        (t: Token) =>
          t &&
          typeof t.id === "string" &&
          typeof t.address === "string" &&
          isMint(t.address) &&
          idFor(t.address) === t.id &&
          typeof t.symbol === "string" &&
          t.symbol.length > 0 &&
          t.symbol.length <= 24 &&
          typeof t.name === "string" &&
          t.name.length <= 80 &&
          number(t.price) &&
          t.price > 0 &&
          Number.isInteger(t.decimals) &&
          t.decimals >= 2 &&
          t.decimals <= 16 &&
          (t.image === undefined ||
            (typeof t.image === "string" &&
              t.image.startsWith("https://cdn.dexscreener.com/"))),
      ) &&
      new Set(a.tokens.map((t: Token) => t.id)).size === a.tokens.length &&
      TOKENS.every((t) =>
        a.tokens.some(
          (item: Token) =>
            item.id === t.id &&
            item.address === t.address &&
            item.symbol === t.symbol,
        ),
      ) &&
      a.tokens.every(
        (t: Token) =>
          number(a.holdings?.[t.id]) &&
          number(a.prices?.[t.id]) &&
          a.prices[t.id] > 0,
      ) &&
      Array.isArray(a.orders) &&
      a.orders.every(
        (o: Order) =>
          typeof o.id === "string" &&
          a.tokens.some((t: Token) => t.id === o.symbol) &&
          ["Bracket", "Limit", "Trailing"].includes(o.kind) &&
          ["Buy", "Sell"].includes(o.side) &&
          ["Watching", "Partially filled", "Filled", "Cancelled"].includes(
            o.status,
          ) &&
          [
            o.quantity,
            o.filled,
            o.target,
            o.stop,
            o.trail,
            o.high,
            o.days,
          ].every(number) &&
          o.filled <= o.quantity &&
          Number.isFinite(Date.parse(o.expiresAt)),
      ) &&
      Array.isArray(a.events) &&
      a.events.every(
        (e: Event) =>
          typeof e.id === "string" &&
          typeof e.title === "string" &&
          typeof e.detail === "string" &&
          Number.isFinite(Date.parse(e.at)),
      )
    )
      return a;
  } catch {
    /* Storage is optional; a fresh preview remains usable. */
  }
  return initialAccount();
}

export function tokenLabel(a: Account, id: string): string {
  return a.tokens.find((t) => t.id === id)?.symbol || id;
}
export function addToken(a: Account, token: DiscoveredToken): Account {
  if (token.chain && token.chain !== 'solana') throw new Error('This order planner requires a Solana token.');
  const id = idFor(token.address);
  if (a.tokens.some((t) => t.id === id)) return a;
  if (
    !isMint(token.address) ||
    !Number.isFinite(token.price) ||
    token.price <= 0
  )
    throw new Error("This token has no usable reference price.");
  if (a.tokens.length >= 100)
    throw new Error("This preview can save up to 100 tokens.");
  return {
    ...a,
    tokens: [
      ...a.tokens,
      {
        id,
        address: token.address,
        symbol: token.symbol,
        name: token.name,
        image: token.image,
        price: token.price,
        quantity: 0,
        change: 0,
        decimals: priceDecimals(token.price),
      },
    ],
    holdings: { ...a.holdings, [id]: 0 },
    prices: { ...a.prices, [id]: token.price },
  };
}
export function setSamplePosition(
  a: Account,
  id: string,
  quantity: number,
): Account {
  if (
    !a.tokens.some((t) => t.id === id) ||
    !Number.isFinite(quantity) ||
    quantity < 0 ||
    !Number.isFinite(quantity * a.prices[id])
  )
    throw new Error("Enter a valid sample token amount.");
  const reserved = a.orders
    .filter((o) => active(o) && o.side === "Sell" && o.symbol === id)
    .reduce((sum, o) => sum + o.quantity - o.filled, 0);
  if (quantity < reserved)
    throw new Error(
      "Cancel the open sell plans before reducing their allocated position.",
    );
  return { ...a, holdings: { ...a.holdings, [id]: quantity } };
}
