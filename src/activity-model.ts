import { fomoHandle } from "./fomo-identity.js";
import { fomoAvatar } from "./fomo-recipient.js";
import { LAUNCH_ASSET_ORIGIN } from "./launch-publication.js";
import { isMint } from "./assets.js";
import { directoryAmount } from "./token-directory-model.js";
export const activityKinds = ["launch", "fee", "burn", "copy"] as const;
export type ActivityKind = (typeof activityKinds)[number];
export type ActivityRecord = {
  id: string;
  kind: ActivityKind;
  imageUrl?: string | null;
  recipientAvatarUrl?: string | null;
  feeSource?: "launchpad" | "official" | null;
  title: string;
  handle: string | null;
  mint: string | null;
  at: string;
  state: string;
  signature: string | null;
  recipient: string | null;
  treasury: string | null;
  burned: string | null;
  decimals: number | null;
};
export type ActivityReport = {
  wallet: string | null;
  records: ActivityRecord[];
  more: ActivityKind[];
  burnTotals?: {mint: string; decimals: number; tokens: string; spent: string; count: number}[];
  checkedAt: number;
};
export function validActivity(
  x: unknown,
  wallet: string | null,
): x is ActivityReport {
  try {
    const d = x as ActivityReport;
    return (
      !!d &&
      d.wallet === wallet &&
      (d.burnTotals === undefined || (Array.isArray(d.burnTotals) &&
        (wallet === null || d.burnTotals.length === 0) &&
        d.burnTotals.every(t => isMint(t.mint) && Number.isInteger(t.decimals) && t.decimals >= 0 && t.decimals <= 9 && directoryAmount(t.tokens) && directoryAmount(t.spent) && Number.isSafeInteger(t.count) && t.count >= 0))) &&
      Number.isSafeInteger(d.checkedAt) &&
      d.checkedAt > 0 &&
      d.checkedAt <= Date.now() + 30000 &&
      Array.isArray(d.more) &&
      d.more.every((k) => activityKinds.includes(k)) &&
      Array.isArray(d.records) &&
      d.records.length <= 100 &&
      new Set(d.records.map((r) => r.id)).size === d.records.length &&
      d.records.every(
        (r) =>
          typeof r.id === "string" &&
          /^[a-z]+:[a-f0-9-]{1,80}$/.test(r.id) &&
          activityKinds.includes(r.kind) &&
          (r.feeSource == null || r.kind === "fee" && ["launchpad","official"].includes(r.feeSource)) &&
          (r.imageUrl == null || typeof r.imageUrl === "string" && r.imageUrl.startsWith(LAUNCH_ASSET_ORIGIN + "/api/launch-assets?kind=image&id=") && /^[a-f0-9]{64}$/.test(r.imageUrl.split("&id=")[1] || '')) &&
          (r.recipientAvatarUrl == null || fomoAvatar(r.recipientAvatarUrl) === r.recipientAvatarUrl) &&
          typeof r.title === "string" &&
          r.title.length > 0 &&
          r.title.length <= 120 &&
          (r.handle === null || (typeof r.handle === "string" && fomoHandle(r.handle) === r.handle)) &&
          (r.mint === null || isMint(r.mint)) &&
          Number.isFinite(Date.parse(r.at)) &&
          [
            "prepared",
            "pending",
            "expired_unresolved",
            "confirmed",
            "failed",
            "superseded",
            "reserved",
            "submitting",
            "unknown",
            "released",
            "skipped",
            "signing",
            "signed",
            "canceled",
          ].includes(r.state) &&
          (r.signature === null ||
            /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(r.signature)) &&
          [r.recipient, r.treasury, r.burned].every(
            (v) => v === null || directoryAmount(v),
          ) &&
          (r.decimals === null ||
            (Number.isInteger(r.decimals) &&
              r.decimals >= 0 &&
              r.decimals <= 9)) &&
          (r.kind !== "burn" ||
            (r.burned !== null &&
              r.treasury !== null &&
              r.mint !== null &&
              r.decimals !== null &&
              r.signature !== null &&
              r.state === "confirmed")) &&
          (r.kind !== "fee" ||
            (r.recipient !== null &&
              r.treasury !== null &&
              r.signature !== null &&
              r.state === "confirmed")),
      )
    );
  } catch {
    return false;
  }
}
export function activityUnits(raw: string, decimals: number) {
  const n = BigInt(raw),
    scale = 10n ** BigInt(decimals);
  const whole = (n / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","),
    fraction = (n % scale)
      .toString()
      .padStart(decimals, "0")
      .replace(/0+$/, "");
  return whole + (fraction ? "." + fraction : "");
}
export const activityStates: Record<string, string> = {
  prepared: "Awaiting signatures",
  pending: "Awaiting confirmation",
  expired_unresolved: "Needs confirmation",
  confirmed: "Confirmed",
  failed: "Failed on chain",
  superseded: "Replaced after expiry",
  reserved: "Reserved",
  submitting: "Awaiting confirmation",
  unknown: "Needs recovery",
  released: "Not sent",
  skipped: "Skipped",
  signing: "Awaiting signature",
  signed: "Awaiting confirmation",
  canceled: "Cancelled",
};
