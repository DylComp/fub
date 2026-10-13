import Stripe from "stripe";
import { createHash } from "node:crypto";
import { validPayRecord, type PayRecord } from "../src/pay-ledger-model.js";
export const PAY_STRIPE_VERSION = "2026-08-26.dahlia" as const;
export type PayIssuerScope = { accountId: string; live: boolean; connected: boolean };
export type PayEvent = PayIssuerScope & { id: string; kind: PayRecord["kind"]; resourceId: string; created: number; digest: string };
export type PayResource = PayIssuerScope & { kind: PayRecord["kind"]; resourceId: string };
export class PayEventInvalid extends Error {}
export function validPayScope(c: PayIssuerScope) {
  if (!c || !/^acct_[A-Za-z0-9]{1,100}$/.test(c.accountId) || typeof c.live !== "boolean" || typeof c.connected !== "boolean") throw Error("Card provider scope is missing.");
}
export function payIssuerConfig() {
  const mode = process.env.PAY_STRIPE_MODE, context = process.env.PAY_STRIPE_ACCOUNT_CONTEXT;
  const c = { accountId: process.env.PAY_STRIPE_ACCOUNT_ID || "", live: mode === "live", connected: context === "connected" };
  validPayScope(c);
  if (!["test", "live"].includes(mode || "") || !["direct", "connected"].includes(context || "")) throw Error("Card provider scope is missing.");
  return c;
}
export function payStripeClient(key: string, c: PayIssuerScope) {
  validPayScope(c);
  if (!new RegExp(`^(rk|sk)_${c.live ? "live" : "test"}_[A-Za-z0-9]+$`).test(key)) throw Error("Card read credential does not match this environment.");
  return new Stripe(key, { apiVersion: PAY_STRIPE_VERSION, timeout: 8000, maxNetworkRetries: 0 });
}
const signatures = new Stripe("sk_test_webhook_verification_only", { apiVersion: PAY_STRIPE_VERSION });
export function verifyPayEvent(raw: Buffer, signature: string, secret: string, scope: PayIssuerScope, now = Date.now()): PayEvent | null {
  try {
    validPayScope(scope);
    if (!/^whsec_[A-Za-z0-9]+$/.test(secret) || raw.length > 262144 || typeof signature !== "string" || signature.length > 2048) throw Error();
    // The SDK verifies raw bytes and past age. Also bound future timestamps and duplicate timestamp fields.
    const timestamps = signature.split(",").filter(s => s.startsWith("t="));
    if (timestamps.length !== 1 || !/^t=\d{10,12}$/.test(timestamps[0]) || Math.abs(now / 1000 - Number(timestamps[0].slice(2))) > 300) throw Error();
    const event = signatures.webhooks.constructEvent(raw, signature, secret, 300, undefined, now);
    if (event.object !== "event" || event.livemode !== scope.live || event.api_version !== PAY_STRIPE_VERSION ||
        (scope.connected ? event.account !== scope.accountId : event.account !== undefined) ||
        !/^evt_[A-Za-z0-9]{1,100}$/.test(event.id) || !Number.isSafeInteger(event.created) || event.created <= 0 || event.created > now / 1000 + 300) throw Error();
    const kind = ["issuing_authorization.created", "issuing_authorization.updated"].includes(event.type) ? "authorization" :
      ["issuing_transaction.created", "issuing_transaction.updated"].includes(event.type) ? "transaction" : null;
    if (!kind) return null;
    const obj = event.data.object as { id: string; object: string };
    if (obj.object !== `issuing.${kind}` || !(kind === "authorization" ? /^iauth_[A-Za-z0-9]{1,100}$/ : /^ipi_[A-Za-z0-9]{1,100}$/).test(obj.id)) throw Error();
    const hint: Omit<PayEvent, "digest"> = { ...scope, id: event.id, kind, resourceId: obj.id, created: event.created };
    return { ...hint, digest: createHash("sha256").update(JSON.stringify([scope.accountId, scope.live, scope.connected, event.id, kind, obj.id, event.created])).digest("hex") };
  } catch { throw new PayEventInvalid("Invalid card event."); }
}
function id(value: unknown, prefix: string): string {
  const result = typeof value === "string" ? value : value && typeof value === "object" ? (value as { id?: unknown }).id : null;
  if (typeof result !== "string" || !new RegExp(`^${prefix}_[A-Za-z0-9]{1,100}$`).test(result)) throw Error("Invalid issuer identity.");
  return result;
}
export function normalizePayRecord(value: unknown, expected: PayResource): PayRecord {
  const v = value as Record<string, any>;
  if (!v || v.id !== expected.resourceId || v.object !== `issuing.${expected.kind}` || v.livemode !== expected.live || !Number.isSafeInteger(v.amount)) throw Error("Issuer record does not match.");
  const record: PayRecord = { id: v.id, kind: expected.kind, cardId: id(v.card, "ic"), cardholderId: id(v.cardholder, "ich"),
    currency: v.currency, amount: String(v.amount), created: v.created, merchant: typeof v.merchant_data?.name === "string" ? v.merchant_data.name.trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160) || "Merchant" : "Merchant",
    status: expected.kind === "authorization" ? v.status : v.type, approved: expected.kind === "authorization" ? v.approved : null,
    authorizationId: expected.kind === "transaction" && v.authorization !== null ? id(v.authorization, "iauth") : null };
  if (!validPayRecord(record)) throw Error("Unsupported issuer record.");
  return record;
}
export function payIssuerReader(client: Stripe, scope: PayIssuerScope) {
  validPayScope(scope);
  const options = scope.connected ? { stripeAccount: scope.accountId } : {};
  return {
    async verifyAccount() {
      const account = await client.accounts.retrieve(null, {}, options);
      if (account.id !== scope.accountId) throw Error("Issuer account does not match.");
    },
    async read(r: PayResource) {
      if (r.accountId !== scope.accountId || r.live !== scope.live || r.connected !== scope.connected) throw Error("Issuer scope mismatch.");
      const value = r.kind === "authorization" ? await client.issuing.authorizations.retrieve(r.resourceId, {}, options) : await client.issuing.transactions.retrieve(r.resourceId, {}, options);
      return normalizePayRecord(value, r);
    },
    async list(cardId: string, kind: PayRecord["kind"], after?: string) {
      id(cardId, "ic");
      if (after) id(after, kind === "authorization" ? "iauth" : "ipi");
      const params = { card: cardId, limit: 25, ...(after ? { starting_after: after } : {}) };
      const page = kind === "authorization" ? await client.issuing.authorizations.list(params, options) : await client.issuing.transactions.list(params, options);
      if (!Array.isArray(page.data) || page.data.length > 25 || typeof page.has_more !== "boolean" || (page.has_more && !page.data.length)) throw Error("Incomplete issuer page.");
      return { records: page.data.map(v => {
        const record = normalizePayRecord(v, { ...scope, kind, resourceId: v.id });
        if (record.cardId !== cardId) throw Error("Issuer card mismatch.");
        return record;
      }), hasMore: page.has_more };
    },
  };
}
