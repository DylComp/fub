import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export type WhopEnvironment = "production" | "sandbox";
export type WhopEvent = {
  environment: WhopEnvironment;
  id: string;
  accountId: string;
  type: string;
  resourceId: string;
  occurredAt: string;
  digest: string;
};
export type WhopConfig = {
  environment: WhopEnvironment;
  accountId: string;
  version: string;
  secret: string;
};
export class WhopInputError extends Error {
  constructor(message?: string, readonly envelopeShape?: {
    hasAccountId: boolean;
    hasCompanyId: boolean;
    companyMatches: boolean;
    versionMatches: boolean;
    versionIsNull: boolean;
    apiV1: boolean;
  }) { super(message); }
}
export function whopConfig(env = process.env): WhopConfig {
  const environment = env.WHOP_ENVIRONMENT;
  if ((environment !== "production" && environment !== "sandbox") ||
      !/^biz_[A-Za-z0-9]{6,80}$/.test(env.WHOP_ACCOUNT_ID || "") ||
      !/^\d{4}-\d{2}-\d{2}(?:-\d+)?$/.test(env.WHOP_API_VERSION || "") ||
      !/^ws_[A-Za-z0-9_-]{20,200}$/.test(env.WHOP_WEBHOOK_SECRET || ""))
    throw Error("Whop event configuration is incomplete.");
  return { environment, accountId: env.WHOP_ACCOUNT_ID!, version: env.WHOP_API_VERSION!, secret: env.WHOP_WEBHOOK_SECRET! };
}
const supported = new Set([
  "card_transaction.created", "card_transaction.completed", "card_transaction.declined",
  "card_transaction.reversed", "card_transaction.updated", "card.created", "card.updated",
  "card.frozen", "card.canceled", "card_application.created", "card_application.updated",
  "card_application.approved", "card_application.denied", "deposit.succeeded",
  "transfer.created", "transfer.completed", "transfer.failed",
]);
function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new WhopInputError("object");
  return value as Record<string, unknown>;
}
// Whop HMACs with the literal ws_ secret, prefix included. Match the official
// @whop/sdk 2.0 helper; do not base64-decode the provider-issued secret.
export function verifyWhopEvent(raw: Buffer, headers: IncomingHttpHeaders, config: WhopConfig, now = Date.now()): WhopEvent | null {
  const id = headers["webhook-id"], timestamp = headers["webhook-timestamp"], signatures = headers["webhook-signature"];
  if (raw.length > 262144 || typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id) ||
      typeof timestamp !== "string" || !/^\d{10}$/.test(timestamp) ||
      Math.abs(now / 1000 - Number(timestamp)) > 300 ||
      typeof signatures !== "string" || signatures.length > 2048) throw new WhopInputError("headers_or_age");
  const expected = createHmac("sha256", config.secret).update(`${id}.${timestamp}.`).update(raw).digest();
  const valid = signatures.split(/\s+/).some(s => {
    if (!/^v1,[A-Za-z0-9+/]{43}=$/.test(s)) return false;
    const candidate = Buffer.from(s.slice(3), "base64");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
  if (!valid) throw new WhopInputError("signature");
  let event: Record<string, unknown>;
  try { event = object(JSON.parse(raw.toString("utf8"))); } catch { throw new WhopInputError("json"); }
  if (event.id !== id) throw new WhopInputError("identity");
  if (event.account_id !== config.accountId)
    throw new WhopInputError(event.account_id === undefined ? "missing_account" : "account", {
      // Authenticate first, then record only shape/compatibility booleans.
      // This distinguishes a legacy test serializer from a different owner
      // without logging account IDs, resource data, or arbitrary fields.
      hasAccountId: event.account_id !== undefined,
      hasCompanyId: event.company_id !== undefined,
      companyMatches: event.company_id === config.accountId,
      versionMatches: event.api_version_date === config.version,
      versionIsNull: event.api_version_date === null,
      apiV1: event.api_version === "v1",
    });
  if (event.api_version !== "v1" || event.api_version_date !== config.version) throw new WhopInputError("version");
  if (typeof event.type !== "string" ||
      typeof event.timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(event.timestamp) ||
      !Number.isFinite(Date.parse(event.timestamp))) throw new WhopInputError("event_shape");
  if (!supported.has(event.type)) return null;
  const data = object(event.data);
  if (typeof data.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(data.id)) throw new WhopInputError("resource");
  // Only routing metadata survives ingestion. Never persist the full payload:
  // card credentials, addresses and other personal fields can be present.
  return { environment: config.environment, id, accountId: config.accountId,
    type: event.type, resourceId: data.id, occurredAt: new Date(event.timestamp).toISOString(),
    digest: createHash("sha256").update(raw).digest("hex") };
}
