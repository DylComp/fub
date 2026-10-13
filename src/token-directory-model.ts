import { isMint } from "./assets.js";
import { fomoHandle } from "./fomo-identity.js";
import { fomoAvatar } from "./fomo-recipient.js";
import { LAUNCH_ASSET_ORIGIN } from "./launch-publication.js";
export type DirectoryProfile = {
  wallet: string;
  handle: string;
  name: string;
  avatarUrl: string | null;
  observedAt: number | null;
};
export type DirectoryAssetFees = Omit<DirectoryFees,"assets"> & {mint:string;tokenProgram:string;decimals:number};
export type DirectoryFees = {
  assets?: DirectoryAssetFees[];
  recipientSent: string;
  buybackSent: string;
  paid: string;
  pending: string | null;
  checkedAt: number | null;
};
export type DirectoryToken = {
  publicationId?: string;
  description?: string;
  twitter?: string;
  telegram?: string;
  projectWebsite?: string;
  mint: string;
  name: string;
  ticker: string;
  imageUrl: string;
  confirmedAt: number;
  signature: string;
  profile: DirectoryProfile;
  fees: DirectoryFees;
};
export type DirectoryRecipient = {
  profile: DirectoryProfile;
  tokenCount: number;
  fees: DirectoryFees;
};
export type DirectoryView = "tokens" | "profiles";
export type DirectoryResult = {
  view: DirectoryView;
  tokens: DirectoryToken[];
  profiles: DirectoryRecipient[];
  nextCursor: string | null;
  totals: {
    assets?:DirectoryAssetFees[];
    tokens: number;
    profiles: number;
    recipientSent: string;
    buybackSent: string;
    paid: string;
  };
  asOf: number;
  coverage: "confirmed-fub-payouts";
};
export const directoryAmount = (s: unknown): s is string =>
  typeof s === "string" && /^(0|[1-9][0-9]{0,39})$/.test(s);
const time = (n: unknown) => Number.isSafeInteger(n) && (n as number) > 0;
const profile = (p: DirectoryProfile) =>
  !!p &&
  isMint(p.wallet) &&
  fomoHandle(p.handle) === p.handle &&
  typeof p.name === "string" &&
  p.name.length > 0 &&
  p.name.length <= 100 &&
  (p.avatarUrl === null || fomoAvatar(p.avatarUrl) === p.avatarUrl) &&
  (p.observedAt === null || time(p.observedAt));
const baseFees = (f: DirectoryFees) =>
  !!f &&
  [f.recipientSent, f.buybackSent, f.paid].every(directoryAmount) &&
  BigInt(f.paid) === BigInt(f.recipientSent) + BigInt(f.buybackSent) &&
  (f.pending === null || directoryAmount(f.pending)) &&
  (f.checkedAt === null || time(f.checkedAt));
const assetFees = (a:DirectoryAssetFees) => isMint(a.mint) &&
 ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA","TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"].includes(a.tokenProgram) &&
 Number.isInteger(a.decimals) && a.decimals>=0 && a.decimals<=18 && baseFees(a) &&
 (a.mint!=="So11111111111111111111111111111111111111112"||a.decimals===9);
const assetsValid = (a:DirectoryAssetFees[]|undefined) => a===undefined || Array.isArray(a) && a.length<=10000 && a.every(assetFees) && new Set(a.map(x=>x.mint)).size===a.length;
const matchingSol = (f:{assets?:DirectoryAssetFees[];recipientSent:string;buybackSent:string;paid:string}) => {
 if(f.assets===undefined)return true;
 const sol=f.assets.find(a=>a.mint==='So11111111111111111111111111111111111111112');
 return f.recipientSent===(sol?.recipientSent||'0')&&f.buybackSent===(sol?.buybackSent||'0')&&f.paid===(sol?.paid||'0');
};
const fees = (f:DirectoryFees)=>baseFees(f)&&assetsValid(f.assets)&&matchingSol(f);
export function validDirectory(
  value: unknown,
  view: DirectoryView,
): value is DirectoryResult {
  try {
    if (!value || typeof value !== "object") return false;
    const d = value as DirectoryResult;
    if (
      d.view !== view ||
      d.coverage !== "confirmed-fub-payouts" ||
      !time(d.asOf) ||
      d.asOf > Date.now() + 30000 ||
      !Array.isArray(d.tokens) ||
      !Array.isArray(d.profiles) ||
      d.tokens.length > 24 ||
      d.profiles.length > 24 ||
      (d.nextCursor !== null &&
        (typeof d.nextCursor !== "string" || d.nextCursor.length > 1024))
    )
      return false;
    if (
      (view === "tokens" && d.profiles.length) ||
      (view === "profiles" && d.tokens.length)
    )
      return false;
    if (
      !d.tokens.every(
        (t) =>
          isMint(t.mint) &&
          (t.publicationId===undefined || /^[a-f0-9]{64}$/.test(t.publicationId)) &&
          (t.description===undefined || typeof t.description==="string" && t.description.length<=1000) &&
          [t.twitter,t.telegram,t.projectWebsite].every(s=>s===undefined || s==="" || (typeof s==="string" && s.length<=200 && /^https:\/\/[^\s]+$/.test(s) && !new URL(s).username && !new URL(s).password)) &&
          typeof t.name === "string" &&
          t.name.length > 0 &&
          t.name.length <= 32 &&
          /^[A-Z0-9]{1,10}$/.test(t.ticker) &&
          typeof t.imageUrl === "string" &&
          new RegExp(
            "^" +
              LAUNCH_ASSET_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
              "/api/launch-assets\\?kind=image&id=[a-f0-9]{64}$",
          ).test(t.imageUrl) &&
          time(t.confirmedAt) &&
          /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(t.signature) &&
          profile(t.profile) &&
          fees(t.fees),
      )
    )
      return false;
    if (
      !d.profiles.every(
        (p) =>
          profile(p.profile) &&
          Number.isSafeInteger(p.tokenCount) &&
          p.tokenCount > 0 &&
          fees(p.fees),
      )
    )
      return false;
    if (
      new Set(d.tokens.map((t) => t.mint)).size !== d.tokens.length ||
      new Set(d.profiles.map((p) => p.profile.wallet)).size !==
        d.profiles.length
    )
      return false;
    return (
      !!d.totals && assetsValid(d.totals.assets) && matchingSol(d.totals) &&
      [d.totals.tokens, d.totals.profiles].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      ) &&
      [d.totals.recipientSent, d.totals.buybackSent, d.totals.paid].every(
        directoryAmount,
      ) &&
      BigInt(d.totals.paid) ===
        BigInt(d.totals.recipientSent) + BigInt(d.totals.buybackSent)
    );
  } catch {
    return false;
  }
}
// Exact decimal rendering, including amounts larger than Number's integer range.
export function directorySol(s: string) {
  return directoryUnits(s,9);
}
export function directoryUnits(s:string,decimals:number) {
  if (!directoryAmount(s)||!Number.isInteger(decimals)||decimals<0||decimals>18) throw Error("Invalid token amount");
  const scale=10n**BigInt(decimals);
  const n = BigInt(s),
    whole = (n / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","),
    fraction = (n % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return whole + (fraction ? "." + fraction : "");
}
