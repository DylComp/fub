import { isMint } from "./assets";
import { displayUnits, units, USDC, WSOL } from "./funding-model";
import type { Holding } from "./portfolio-data";
export const DRAFT_KEY = "fomo-orders.live-drafts.v1";
export const INTENT_KEY = "fomo-orders.order-intent.v1";
export type OrderIntent = {
  id: string;
  wallet: string;
  mint: string;
  amount: string;
  decimals: number;
  observedAt: number;
  symbol: string;
};
export type LiveDraft = {
  kind: string;
  side: string;
  mint: string;
  amount: string;
  target: string;
  stop: string;
  trail: string;
  slippage: string;
  expiry: string;
};
export const blankLiveDraft = (): LiveDraft => ({
  kind: "oco",
  side: "sell",
  mint: "",
  amount: "",
  target: "",
  stop: "",
  trail: "10",
  slippage: "1",
  expiry: "7",
});
export function holdingIntent(
  wallet: string,
  holding: Holding,
  observedAt: number,
): OrderIntent {
  if (
    !isMint(wallet) ||
    !isMint(holding.mint) ||
    holding.program !== "SPL" ||
    [USDC, WSOL].includes(holding.mint) ||
    !Number.isInteger(holding.decimals) ||
    holding.decimals < 0 ||
    holding.decimals > 18
  )
    throw new Error(
      "Live exits currently support standard SPL tokens paired with USDC.",
    );
  if (
    !/^(0|[1-9]\d{0,19})$/.test(holding.rawAmount) ||
    !/^(0|[1-9]\d{0,19})$/.test(holding.frozenRawAmount)
  )
    throw new Error("Invalid wallet amounts.");
  const total = BigInt(holding.rawAmount),
    frozen = BigInt(holding.frozenRawAmount);
  if (total > 18446744073709551615n || frozen > total || total === frozen)
    throw new Error("This holding has no unfrozen tokens to sell.");
  if (
    !Number.isSafeInteger(observedAt) ||
    observedAt > Date.now() + 1000 ||
    Date.now() - observedAt > 60000
  )
    throw new Error("Refresh this wallet before opening an order.");
  return {
    id: crypto.randomUUID(),
    wallet,
    mint: holding.mint,
    amount: displayUnits((total - frozen).toString(), holding.decimals),
    decimals: holding.decimals,
    observedAt,
    symbol: (holding.symbol || "").slice(0, 24),
  };
}
export function percentAmount(raw: string, decimals: number, percent: number) {
  if (
    !/^(0|[1-9]\d{0,19})$/.test(raw) ||
    BigInt(raw) > 18446744073709551615n ||
    ![25, 50, 75, 100].includes(percent) ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 18
  )
    throw new Error("Invalid balance sizing.");
  const amount = (BigInt(raw) * BigInt(percent)) / 100n;
  if (!amount)
    throw new Error("That percentage is below this token's smallest unit.");
  return displayUnits(amount.toString(), decimals);
}
export function validDraft(value: unknown): value is LiveDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as LiveDraft;
  const keys = Object.keys(blankLiveDraft());
  return (
    Object.keys(draft).length === keys.length &&
    keys.every(
      (key) =>
        typeof draft[key as keyof LiveDraft] === "string" &&
        draft[key as keyof LiveDraft].length <= 80,
    ) &&
    ["oco", "limit", "trailing"].includes(draft.kind) &&
    ["buy", "sell"].includes(draft.side) &&
    (draft.kind === "limit" || draft.side === "sell") &&
    ["1", "7", "30"].includes(draft.expiry)
  );
}
export function loadLiveDraft(wallet: string): {
  draft: LiveDraft;
  warning: string;
} {
  try {
    const saved = localStorage.getItem(DRAFT_KEY);
    if (!saved) return { draft: blankLiveDraft(), warning: "" };
    const rows = JSON.parse(saved);
    if (
      !Array.isArray(rows) ||
      rows.length > 5 ||
      rows.some((row) => !row || !isMint(row.wallet) || !validDraft(row.draft))
    )
      throw new Error();
    return {
      draft:
        rows.find((row) => row.wallet === wallet)?.draft || blankLiveDraft(),
      warning: "",
    };
  } catch {
    return {
      draft: blankLiveDraft(),
      warning: "Saved order drafts could not be read. No order was placed.",
    };
  }
}
export function saveLiveDraft(wallet: string, draft: LiveDraft) {
  if (!isMint(wallet) || !validDraft(draft))
    throw new Error("Invalid order draft.");
  const raw = localStorage.getItem(DRAFT_KEY);
  const rows = raw ? JSON.parse(raw) : [];
  if (
    !Array.isArray(rows) ||
    rows.some((row) => !row || !isMint(row.wallet) || !validDraft(row.draft))
  )
    throw new Error("Saved drafts could not be updated.");
  localStorage.setItem(
    DRAFT_KEY,
    JSON.stringify(
      [{ wallet, draft }, ...rows.filter((row) => row.wallet !== wallet)].slice(
        0,
        5,
      ),
    ),
  );
}
export function loadIntent(): OrderIntent | null {
  try {
    const raw = sessionStorage.getItem(INTENT_KEY);
    if (!raw) return null;
    const row = JSON.parse(raw);
    if (
      !row ||
      !isMint(row.wallet) ||
      !isMint(row.mint) ||
      typeof row.amount !== "string" ||
      !/^\d{1,20}(\.\d{1,18})?$/.test(row.amount) ||
      !Number.isInteger(row.decimals) ||
      row.decimals < 0 ||
      row.decimals > 18 ||
      typeof row.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        row.id,
      ) ||
      typeof row.symbol !== "string" ||
      row.symbol.length > 24 ||
      !Number.isSafeInteger(row.observedAt)
    )
      throw new Error();
    if (
      [USDC, WSOL].includes(row.mint) ||
      Date.now() - row.observedAt > 86400000 ||
      row.observedAt > Date.now() + 1000
    )
      throw new Error();
    units(row.amount, row.decimals);
    return row;
  } catch {
    return null;
  }
}
