import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
export type ServiceOutcome =
  | "idle"
  | "ready"
  | "busy"
  | "retry"
  | "gap"
  | "catching_up"
  | "expired"
  | "unknown"
  | "confirmed"
  | "failed";
export function copyServiceStore(url: string) {
  const client = () =>
    neon(url, { fetchOptions: { signal: AbortSignal.timeout(5000) } });
  return {
    async begin() {
      const sql = client(),
        id = randomUUID();
      const rows =
        await sql`INSERT INTO fomo_copy_service(name,lease_id,lease_until,last_started_at,last_heartbeat_at)
        VALUES('observer',${id},clock_timestamp()+interval '90 seconds',clock_timestamp(),clock_timestamp())
        ON CONFLICT(name) DO UPDATE SET lease_id=EXCLUDED.lease_id,lease_until=EXCLUDED.lease_until,last_started_at=EXCLUDED.last_started_at,last_heartbeat_at=EXCLUDED.last_heartbeat_at,outcome='idle'
        WHERE fomo_copy_service.lease_until IS NULL OR fomo_copy_service.lease_until<=clock_timestamp() RETURNING name`;
      return rows.length ? id : null;
    },
    async heartbeat(id: string, outcome: ServiceOutcome) {
      const sql = client();
      const rows =
        await sql`UPDATE fomo_copy_service SET lease_until=clock_timestamp()+interval '90 seconds',last_heartbeat_at=clock_timestamp(),outcome=${outcome}
        WHERE name='observer' AND lease_id=${id} AND lease_until>clock_timestamp() RETURNING name`;
      return !!rows.length;
    },
    async release(id: string) {
      const sql = client();
      await sql`UPDATE fomo_copy_service SET lease_id=NULL,lease_until=NULL,last_finished_at=clock_timestamp(),outcome='stopped' WHERE name='observer' AND lease_id=${id}`;
    },
  };
}
