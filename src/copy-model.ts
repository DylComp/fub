import { isMint } from "./assets.js";
import { validIdentity } from "./fomo-identity.js";
import type { FomoIdentity } from "./fomo-identity.js";

export const COPY_STORAGE_KEY = "fomo-orders.copy-plans.v1";
export type CopyDraft = {
  address: string;
  identity?: FomoIdentity;
  name: string;
  buyUsd: string;
  dailyUsd: string;
  slippage: string;
  copySells: boolean;
};
export type CopyPlan = {
  id: string;
  address: string;
  identity?: FomoIdentity;
  name: string;
  buyCents: number;
  dailyCents: number;
  slippageBps: number;
  copySells: boolean;
  status: "draft";
  createdAt: string;
  updatedAt: string;
};
export const emptyCopyDraft = (): CopyDraft => ({
  address: "",
  name: "",
  buyUsd: "25",
  dailyUsd: "250",
  slippage: "1",
  copySells: true,
});

// Store configuration as integer cents/basis points, never rounded floating-point money.
function hundredths(value: string): number | null {
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(value.trim());
  return match
    ? Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"))
    : null;
}
export function copyError(
  draft: CopyDraft,
  plans: CopyPlan[],
  editingId?: string,
): string | null {
  if (!isMint(draft.address.trim()))
    return "Enter a public Solana address. A Fomo username or profile link also needs a wallet address.";
  if (draft.identity !== undefined && !validIdentity(draft.identity, draft.address.trim()))
    return "The saved profile link belongs to a different wallet. Select the wallet again.";
  if (
    plans.some(
      (plan) => plan.address === draft.address.trim() && plan.id !== editingId,
    )
  )
    return "You already have a plan for this wallet. Edit it below.";
  if (draft.name.trim().length > 40)
    return "Keep the wallet label under 40 characters.";
  const buy = hundredths(draft.buyUsd),
    daily = hundredths(draft.dailyUsd),
    slippage = hundredths(draft.slippage);
  if (buy === null || buy < 100 || buy > 100000000)
    return "Enter a buy amount from $1 to $1,000,000, with at most two decimals.";
  if (daily === null || daily < buy || daily > 100000000)
    return "Set the daily buy cap at or above one buy, up to $1,000,000.";
  if (slippage === null || slippage < 10 || slippage > 500)
    return "Set slippage between 0.10% and 5.00%.";
  if (!editingId && plans.length >= 25)
    return "You can save up to 25 copy plans in this browser.";
  return null;
}
export function saveCopyPlan(
  plans: CopyPlan[],
  draft: CopyDraft,
  editingId?: string,
): CopyPlan[] {
  const error = copyError(draft, plans, editingId);
  if (error) throw new Error(error);
  const old = editingId
    ? plans.find((plan) => plan.id === editingId)
    : undefined;
  if (editingId && !old)
    throw new Error("This plan no longer exists. Create a new one.");
  const now = new Date().toISOString();
  const plan: CopyPlan = {
    id: old?.id || crypto.randomUUID(),
    address: draft.address.trim(),
    name: draft.name.trim(),
    ...(draft.identity ? { identity: { ...draft.identity } } : {}),
    buyCents: hundredths(draft.buyUsd)!,
    dailyCents: hundredths(draft.dailyUsd)!,
    slippageBps: hundredths(draft.slippage)!,
    copySells: draft.copySells,
    status: "draft",
    createdAt: old?.createdAt || now,
    updatedAt: now,
  };
  return old
    ? plans.map((p) => (p.id === old.id ? plan : p))
    : [plan, ...plans];
}
export function draftFromPlan(plan: CopyPlan): CopyDraft {
  return {
    address: plan.address,
    name: plan.name,
    ...(plan.identity ? { identity: { ...plan.identity } } : {}),
    buyUsd: String(plan.buyCents / 100),
    dailyUsd: String(plan.dailyCents / 100),
    slippage: String(plan.slippageBps / 100),
    copySells: plan.copySells,
  };
}
export function loadCopyPlans(): { plans: CopyPlan[]; warning: string } {
  try {
    const raw = localStorage.getItem(COPY_STORAGE_KEY);
    if (!raw) return { plans: [], warning: "" };
    const data = JSON.parse(raw);
    if (
      data?.version !== 1 ||
      !Array.isArray(data.plans) ||
      data.plans.length > 25
    )
      throw new Error();
    const plans: CopyPlan[] = [];
    for (const plan of data.plans) {
      if (
        !plan ||
        typeof plan.id !== "string" ||
        plans.some((p) => p.id === plan.id) ||
        typeof plan.address !== "string" ||
        typeof plan.name !== "string" ||
        typeof plan.copySells !== "boolean" ||
        plan.status !== "draft" ||
        ![plan.buyCents, plan.dailyCents, plan.slippageBps].every(
          Number.isSafeInteger,
        ) ||
        !Number.isFinite(Date.parse(plan.createdAt)) ||
        !Number.isFinite(Date.parse(plan.updatedAt)) ||
        copyError(draftFromPlan(plan), plans)
      )
        throw new Error();
      plans.push(plan);
    }
    return { plans, warning: "" };
  } catch {
    return {
      plans: [],
      warning:
        "Saved copy plans could not be read. No copy trading is running.",
    };
  }
}
