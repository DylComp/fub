export type PayRecord = {
  id: string; kind: "authorization" | "transaction"; cardId: string; cardholderId: string;
  currency: "usd"; amount: string; created: number; merchant: string;
  status: "pending" | "closed" | "expired" | "reversed" | "capture" | "refund";
  approved: boolean | null; authorizationId: string | null;
};
export type PayStatement = { wallet: string; records: PayRecord[]; asOf: number; truncated: boolean; pendingSync: number };
export function validPayRecord(v: unknown): v is PayRecord {
  if (!v || typeof v !== "object") return false;
  const x = v as PayRecord;
  return ["authorization", "transaction"].includes(x.kind) && new RegExp(x.kind === "authorization" ? "^iauth_[A-Za-z0-9]{1,100}$" : "^ipi_[A-Za-z0-9]{1,100}$").test(x.id) &&
    /^ic_[A-Za-z0-9]{1,100}$/.test(x.cardId) && /^ich_[A-Za-z0-9]{1,100}$/.test(x.cardholderId) && x.currency === "usd" &&
    typeof x.amount === "string" && /^-?(0|[1-9]\d{0,14})$/.test(x.amount) && x.amount !== "-0" && Number.isSafeInteger(Number(x.amount)) &&
    Number.isSafeInteger(x.created) && x.created > 0 && typeof x.merchant === "string" && x.merchant.length > 0 && x.merchant.length <= 160 &&
    (x.kind === "authorization" ? ["pending", "closed", "expired", "reversed"].includes(x.status) && typeof x.approved === "boolean" && BigInt(x.amount) >= 0n && x.authorizationId === null :
      ["capture", "refund"].includes(x.status) && x.approved === null && (x.authorizationId === null || /^iauth_[A-Za-z0-9]{1,100}$/.test(x.authorizationId)) && (x.status !== "capture" || BigInt(x.amount) <= 0n));
}
export function payStatementTotals(records: PayRecord[]) {
  let purchases = 0n, refunds = 0n, refundReversals = 0n;
  const seen = new Set<string>();
  for (const r of records) {
    if (!validPayRecord(r) || seen.has(r.id)) throw Error("Invalid card history.");
    seen.add(r.id);
    if (r.kind === "authorization") continue; // An authorization is not a second purchase or an available-balance deduction.
    const amount = BigInt(r.amount);
    if (r.status === "capture") purchases -= amount;
    else if (amount >= 0n) refunds += amount;
    else refundReversals -= amount;
  }
  return { purchases: purchases.toString(), refunds: refunds.toString(), refundReversals: refundReversals.toString(), netSpending: (purchases - refunds + refundReversals).toString() };
}
