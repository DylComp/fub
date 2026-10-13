import { neon } from "@neondatabase/serverless";
import type { WhopEvent } from "./whop-events.js";

export class WhopEventConflict extends Error {}
export function whopEventStore(url = process.env.DATABASE_URL) {
  if (!url) throw Error("Whop event storage is unavailable.");
  const sql = neon(url, { fetchOptions: { signal: AbortSignal.timeout(2500) } });
  return {
    async receive(e: WhopEvent): Promise<"received" | "duplicate"> {
      // Concurrent retries are serialized by the unique constraint. No account
      // balance or trade authorization is ever changed by an incoming event.
      const rows = await sql`INSERT INTO fomo_whop_events
        (environment,event_id,account_id,event_type,resource_id,occurred_at,payload_digest)
        VALUES (${e.environment},${e.id},${e.accountId},${e.type},${e.resourceId},${e.occurredAt},${e.digest})
        ON CONFLICT (environment,event_id) DO NOTHING RETURNING event_id`;
      if (rows.length) return "received";
      const existing = await sql`SELECT payload_digest FROM fomo_whop_events
        WHERE environment=${e.environment} AND event_id=${e.id}`;
      if (existing[0]?.payload_digest !== e.digest) throw new WhopEventConflict();
      return "duplicate";
    },
  };
}
