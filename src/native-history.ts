export type NativeTrade = {
  id: string;
  mint: string;
  side: "buy" | "sell";
  inputRaw: string;
  decimals: number;
  state:
    | "prepared"
    | "signing"
    | "signed"
    | "confirmed"
    | "failed"
    | "canceled"
    | "expired";
  accounting: "reserved" | "applied" | "released";
  accountingBlocked: boolean;
  reservedLamports: string;
  outputRaw?: string;
  feeLamports?: string;
  rentLamports?: string;
  tokenFeeRaw?: string;
  signature?: string;
  submission: "claimed" | "accepted" | "uncertain" | null;
  checkedAt: string | null;
  reviewExpiresAt?: string;
  nextCheckAt: string | null;
  checks: number;
  recovery: string;
  createdAt: string;
  updatedAt: string;
};
export type NativeHistoryReport = {
  wallet: string;
  planId: string;
  checkedAt: string;
  day: string;
  spentTodayLamports: string;
  reservedTodayLamports: string;
  heldLamports: string;
  proceedsLamports: string;
  hasMore: boolean;
  trades: NativeTrade[];
};
// Quote expiry alone is not proof of transaction expiry or non-execution.
// Use a recorded recovery check, rather than the browser clock, to flag delay.
export function nativeConfirmationDelayed(t: NativeTrade) {
  return t.state === "signed" && !!t.checkedAt && !!t.reviewExpiresAt &&
    Date.parse(t.checkedAt) >= Date.parse(t.reviewExpiresAt) + 120_000;
}
export function nativeTradeStatus(t: NativeTrade) {
  if(t.state === "expired") return t.accounting === "released" ? "Expired without executing" : "Expired, releasing reservation";
  if (t.state === "confirmed" || t.state === "failed")
    return `${t.state === "confirmed" ? "Confirmed" : "Failed on chain"}${t.accounting !== "applied" ? ", accounting pending" : ""}`;
  if (t.state === "canceled")
    return t.accounting === "released"
      ? "Canceled before signing"
      : "Canceled, release pending";
  if (t.state === "prepared") return "Prepared";
  if (t.state === "signing") return "Waiting for a signing result";
  if (nativeConfirmationDelayed(t)) return "Confirmation unresolved";
  if (t.submission === "accepted") return "Submitted, awaiting confirmation";
  if (t.submission === "claimed" || t.submission === "uncertain")
    return "Submission outcome uncertain";
  return "Signature saved";
}
