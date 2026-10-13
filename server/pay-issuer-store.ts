import { neon } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";
import type { PayEvent, PayIssuerScope, PayResource } from "./pay-issuer.js";
import { validPayScope } from "./pay-issuer.js";
import { validPayRecord, type PayRecord, type PayStatement } from "../src/pay-ledger-model.js";
import { isMint } from "../src/assets.js";
export type PayClaim = PayResource & { lease: string; generation: string };
export type DiscoveryClaim = PayIssuerScope & { cardId: string; cardholderId: string; kind: PayRecord["kind"]; cursor: string | null; lease: string };
export class PayEventConflict extends Error {}
export function payIssuerStore(url: string, scope: PayIssuerScope) {
  validPayScope(scope);
  if (!url) throw Error("Card history storage is unavailable.");
  const sql = neon(url, { fetchOptions: { signal: AbortSignal.timeout(5000) } });
  function same(r: PayResource | PayIssuerScope) { if (r.accountId !== scope.accountId || r.live !== scope.live || r.connected !== scope.connected) throw Error("Card scope mismatch."); }
  return {
    async receive(e: PayEvent): Promise<"received" | "duplicate"> {
      same(e);
      const rows = await sql`WITH inserted AS (
        INSERT INTO fub_pay_events(account_id,live,event_id,kind,resource_id,occurred_at,digest)
        VALUES(${e.accountId},${e.live},${e.id},${e.kind},${e.resourceId},${e.created},${e.digest})
        ON CONFLICT DO NOTHING RETURNING *
      ) INSERT INTO fub_pay_resources(account_id,live,kind,resource_id)
        SELECT account_id,live,kind,resource_id FROM inserted
        ON CONFLICT(account_id,live,kind,resource_id) DO UPDATE SET generation=fub_pay_resources.generation+1,next_at=clock_timestamp()
        RETURNING resource_id`;
      if (rows.length) return "received";
      const previous = await sql`SELECT digest FROM fub_pay_events WHERE account_id=${scope.accountId} AND live=${scope.live} AND event_id=${e.id}`;
      if (previous[0]?.digest !== e.digest) throw new PayEventConflict();
      return "duplicate";
    },
    async claim(): Promise<PayClaim | null> {
      const lease = randomUUID();
      const rows = await sql`WITH candidate AS (
        SELECT account_id,live,kind,resource_id FROM fub_pay_resources
        WHERE account_id=${scope.accountId} AND live=${scope.live} AND next_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp())
        ORDER BY next_at,resource_id FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE fub_pay_resources r SET lease_id=${lease},lease_until=clock_timestamp()+interval '45 seconds'
        FROM candidate c WHERE (r.account_id,r.live,r.kind,r.resource_id)=(c.account_id,c.live,c.kind,c.resource_id)
        RETURNING r.kind,r.resource_id,r.generation::text`;
      return rows[0] ? { ...scope, kind: rows[0].kind, resourceId: rows[0].resource_id, generation: rows[0].generation, lease } : null;
    },
    async finish(c: PayClaim, record: PayRecord) {
      same(c);
      if (!validPayRecord(record) || record.kind !== c.kind || record.id !== c.resourceId) throw Error("Invalid card snapshot.");
      // A new event during the API read fences off the old snapshot. A lost/expired
      // lease cannot overwrite a newer worker. Unbound cards never reach owner history.
      const rows = await sql`UPDATE fub_pay_resources r SET snapshot=${JSON.stringify(record)}::jsonb,fetched_at=clock_timestamp(),
        applied_generation=generation,lease_id=NULL,lease_until=NULL,failures=0,last_error=NULL,
        next_at=clock_timestamp()+CASE WHEN ${record.kind === "authorization" && record.status === "pending"} THEN interval '5 minutes' ELSE interval '1 day' END
        WHERE r.account_id=${scope.accountId} AND r.live=${scope.live} AND r.kind=${c.kind} AND r.resource_id=${c.resourceId}
          AND r.lease_id=${c.lease} AND r.lease_until>clock_timestamp() AND r.generation=${c.generation}::bigint
          AND EXISTS(SELECT 1 FROM fub_pay_cards b WHERE b.account_id=r.account_id AND b.live=r.live AND b.card_id=${record.cardId} AND b.cardholder_id=${record.cardholderId})
        RETURNING resource_id`;
      if (rows.length) return true;
      await sql`UPDATE fub_pay_resources SET lease_id=NULL,lease_until=NULL,next_at=clock_timestamp()
        WHERE account_id=${scope.accountId} AND live=${scope.live} AND kind=${c.kind} AND resource_id=${c.resourceId} AND lease_id=${c.lease} AND generation<>${c.generation}::bigint`;
      return false;
    },
    async bound(record: PayRecord) {
      const rows = await sql`SELECT 1 FROM fub_pay_cards WHERE account_id=${scope.accountId} AND live=${scope.live} AND card_id=${record.cardId} AND cardholder_id=${record.cardholderId}`;
      return rows.length === 1;
    },
    async fail(c: PayClaim, error: "provider_unavailable" | "unsupported_record" | "unbound_card") {
      same(c);
      await sql`UPDATE fub_pay_resources SET lease_id=NULL,lease_until=NULL,failures=LEAST(failures+1,10),last_error=${error},
        next_at=CASE WHEN generation<>${c.generation}::bigint THEN clock_timestamp() ELSE clock_timestamp()+LEAST(30*power(2,LEAST(failures,7)),3600)*interval '1 second' END
        WHERE account_id=${scope.accountId} AND live=${scope.live} AND kind=${c.kind} AND resource_id=${c.resourceId} AND lease_id=${c.lease} AND lease_until>clock_timestamp()`;
    },
    async seedDiscovery() {
      await sql`INSERT INTO fub_pay_discovery(account_id,live,card_id,kind)
        SELECT b.account_id,b.live,b.card_id,k.kind FROM fub_pay_cards b CROSS JOIN (VALUES ('authorization'),('transaction')) k(kind)
        WHERE b.account_id=${scope.accountId} AND b.live=${scope.live} ON CONFLICT DO NOTHING`;
    },
    async claimDiscovery(): Promise<DiscoveryClaim | null> {
      const lease = randomUUID();
      const rows = await sql`WITH c AS (
        SELECT account_id,live,card_id,kind FROM fub_pay_discovery WHERE account_id=${scope.accountId} AND live=${scope.live}
          AND next_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp())
        ORDER BY next_at,card_id,kind FOR UPDATE SKIP LOCKED LIMIT 1
      ), claimed AS (
        UPDATE fub_pay_discovery d SET lease_id=${lease},lease_until=clock_timestamp()+interval '45 seconds' FROM c
        WHERE (d.account_id,d.live,d.card_id,d.kind)=(c.account_id,c.live,c.card_id,c.kind) RETURNING d.*
      ) SELECT c.*,b.cardholder_id FROM claimed c JOIN fub_pay_cards b USING(account_id,live,card_id)`;
      return rows[0] ? { ...scope, lease, cardId: rows[0].card_id, cardholderId: rows[0].cardholder_id, kind: rows[0].kind, cursor: rows[0].cursor } : null;
    },
    async finishDiscovery(c: DiscoveryClaim, records: PayRecord[], hasMore: boolean) {
      same(c);
      if (records.length > 25 || (hasMore && !records.length) || new Set(records.map(r => r.id)).size !== records.length ||
          records.some(r => !validPayRecord(r) || r.cardId !== c.cardId || r.cardholderId !== c.cardholderId || r.kind !== c.kind || r.id === c.cursor)) throw Error("Invalid issuer history page.");
      const ids = records.map(r => r.id);
      // Page and cursor persist together. Discovery queues a fresh retrieve; its list
      // response never overwrites a concurrently reconciled resource snapshot.
      const rows = await sql`WITH advanced AS (
        UPDATE fub_pay_discovery SET cursor=${hasMore ? ids.at(-1)! : null},lease_id=NULL,lease_until=NULL,failures=0,
          next_at=clock_timestamp()+CASE WHEN ${hasMore} THEN interval '1 second' ELSE interval '15 minutes' END,
          last_completed_at=CASE WHEN ${hasMore} THEN last_completed_at ELSE clock_timestamp() END
        WHERE account_id=${scope.accountId} AND live=${scope.live} AND card_id=${c.cardId} AND kind=${c.kind}
          AND lease_id=${c.lease} AND lease_until>clock_timestamp() RETURNING account_id,live,kind
      ), queued AS (
        INSERT INTO fub_pay_resources(account_id,live,kind,resource_id)
        SELECT a.account_id,a.live,a.kind,j.id FROM advanced a CROSS JOIN jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) j(id)
        ON CONFLICT(account_id,live,kind,resource_id) DO UPDATE SET generation=fub_pay_resources.generation+1,next_at=clock_timestamp()
        RETURNING resource_id
      ) SELECT count(*)::integer AS advanced FROM advanced`;
      return rows[0]?.advanced === 1;
    },
    async failDiscovery(c: DiscoveryClaim) {
      same(c);
      await sql`UPDATE fub_pay_discovery SET lease_id=NULL,lease_until=NULL,failures=LEAST(failures+1,10),
        next_at=clock_timestamp()+LEAST(30*power(2,LEAST(failures,7)),3600)*interval '1 second'
        WHERE account_id=${scope.accountId} AND live=${scope.live} AND card_id=${c.cardId} AND kind=${c.kind} AND lease_id=${c.lease} AND lease_until>clock_timestamp()`;
    },
    async statement(wallet: string): Promise<PayStatement> {
      if (!isMint(wallet)) throw Error("Invalid wallet.");
      const rows = await sql`SELECT r.snapshot FROM fub_pay_resources r JOIN fub_pay_cards b
        ON b.account_id=r.account_id AND b.live=r.live AND b.card_id=r.snapshot->>'cardId' AND b.cardholder_id=r.snapshot->>'cardholderId'
        WHERE b.wallet=${wallet} AND r.account_id=${scope.accountId} AND r.live=${scope.live} AND r.snapshot IS NOT NULL
        ORDER BY (r.snapshot->>'created')::bigint DESC,r.resource_id DESC LIMIT 101`;
      const pending = await sql`SELECT count(*)::integer AS count FROM fub_pay_resources r JOIN fub_pay_cards b
        ON b.account_id=r.account_id AND b.live=r.live AND b.card_id=r.snapshot->>'cardId' AND b.cardholder_id=r.snapshot->>'cardholderId'
        WHERE b.wallet=${wallet} AND r.account_id=${scope.accountId} AND r.live=${scope.live} AND (r.generation<>r.applied_generation OR r.last_error IS NOT NULL OR r.next_at<clock_timestamp())`;
      const records = rows.slice(0, 100).map(r => r.snapshot);
      if (!records.every(validPayRecord)) throw Error("Invalid stored card history.");
      return { wallet, records, asOf: Date.now(), truncated: rows.length > 100, pendingSync: Number(pending[0].count) };
    },
    async health() {
      const rows = await sql`SELECT
        (SELECT count(*)::integer FROM fub_pay_resources WHERE account_id=${scope.accountId} AND live=${scope.live} AND next_at<clock_timestamp()-interval '5 minutes') AS overdue,
        (SELECT count(*)::integer FROM fub_pay_resources WHERE account_id=${scope.accountId} AND live=${scope.live} AND last_error IS NOT NULL) AS failed,
        (SELECT count(*)::integer FROM fub_pay_discovery WHERE account_id=${scope.accountId} AND live=${scope.live} AND (failures>0 OR next_at<clock_timestamp()-interval '5 minutes')) AS discovery_failed`;
      return rows[0] as { overdue: number; failed: number; discovery_failed: number };
    },
  };
}
export type PayIssuerStore = ReturnType<typeof payIssuerStore>;
