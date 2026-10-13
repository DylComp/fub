import { SOL_PAIR_MINT, pairAmount } from "./launch-pairs.js";
import { isMint } from "./assets.js";
import { fomoHandle, validFomoLookup } from "./fomo-identity.js";
import type { FomoLookup } from "./fomo-identity.js";
export const LAUNCH_SPLIT = { recipientBps: 8000, buybackBps: 2000 } as const;
export const LAUNCH_DRAFT_KEY = "fomo.launch.draft.v1";
export type LaunchDraft = { name: string; ticker: string; description: string; twitter: string; telegram: string; website: string; initialBuy: string; handle: string; quoteMint?: string };
export const emptyLaunch: LaunchDraft = { name: "", ticker: "", description: "", twitter: "", telegram: "", website: "", initialBuy: "", handle: "" };
const bytes = (s: string) => new TextEncoder().encode(s).length;
export function initialBuyLamports(value: string): bigint {
  if (value === "") return 0n;
  if (!/^(0|[1-9]\d{0,2})(\.\d{1,9})?$/.test(value)) throw Error("Use a SOL amount with up to nine decimal places.");
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole) * 1000000000n + BigInt(fraction.padEnd(9, "0"));
  if (amount > 10000000000n || (amount > 0n && amount < 1000000n)) throw Error("Initial buy must be 0, or between 0.001 and 10 SOL.");
  return amount;
}
export function launchDraft(value: unknown): LaunchDraft {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.keys(emptyLaunch).sort().join(), [...Object.keys(emptyLaunch), "quoteMint"].sort().join()].includes(Object.keys(value).sort().join())) throw Error("Invalid launch fields.");
  const v = value as LaunchDraft;
  if (Object.values(v).some(x => typeof x !== "string")) throw Error("Invalid launch fields.");
  const d = { ...v, name: v.name.trim(), ticker: v.ticker.trim().toUpperCase(), handle: fomoHandle(v.handle) || "" };
  if (!d.name || bytes(d.name) > 32 || /[\u0000-\u001f\u007f]/.test(d.name)) throw Error("Name must fit within 32 UTF-8 bytes.");
  if (!/^[A-Z0-9]{1,10}$/.test(d.ticker)) throw Error("Ticker needs 1–10 letters or numbers.");
  if (!d.handle) throw Error("Enter a Fomo username.");
  if (d.description.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(d.description)) throw Error("Description must be 1,000 characters or fewer.");
  for (const key of ["twitter", "telegram", "website"] as const) {
    d[key] = d[key].trim();
    if (!d[key]) continue;
    let url: URL;
    try { url = new URL(d[key]); } catch { throw Error("Social and website links must be complete HTTPS URLs."); }
    if (d[key].length > 200 || url.protocol !== "https:" || url.username || url.password || url.port || /[\s\u0000-\u001f]/.test(d[key])) throw Error("Use a public HTTPS link without login details.");
    if (key === "twitter" && !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname)) throw Error("Enter an X or Twitter link.");
    if (key === "telegram" && url.hostname !== "t.me") throw Error("Enter a t.me Telegram link.");
  }
  if (d.quoteMint !== undefined && !isMint(d.quoteMint)) throw Error("Choose a valid pair asset.");
  if (!d.quoteMint || d.quoteMint === SOL_PAIR_MINT) initialBuyLamports(d.initialBuy);
  else pairAmount(d.initialBuy, 18); // Exact decimals are checked against the live mint before preparation.
  return d;
}
export function confirmedLaunchRecipient(draft: LaunchDraft, lookup: FomoLookup, now = Date.now()) {
  if (!validFomoLookup(lookup, draft.handle) || lookup.fetchedAt > now + 1000 || now - lookup.fetchedAt > 300000) throw Error("Find and confirm the recipient again before reviewing.");
  return lookup.address;
}
export function launchShares(recipient: string, buyback: string) {
  if (!isMint(recipient) || !isMint(buyback) || recipient === buyback) throw Error("Fee destinations must be two distinct Solana addresses.");
  return [{ address: recipient, shareBps: LAUNCH_SPLIT.recipientBps }, { address: buyback, shareBps: LAUNCH_SPLIT.buybackBps }];
}
export function launchFeeAllocation(lamports: bigint) {
  if (lamports < 0n) throw Error("Invalid creator fee amount.");
  const recipient = lamports * 8000n / 10000n, buyback = lamports * 2000n / 10000n;
  // Dust stays in the vault; never round up an entitlement.
  return { recipient, buyback, dust: lamports - recipient - buyback };
}
