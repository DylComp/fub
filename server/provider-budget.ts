import { neon } from "@neondatabase/serverless";

export class ProviderBusy extends Error {
  constructor(readonly retryAfter = 3) {
    super("Jupiter requests are busy. Try again shortly.");
  }
}

// A single database row paces keyless calls across all production instances.
// Queue at most two seconds; never start an unbounded serverless wait.
export async function reserveProviderSlot(
  url: string,
  name = "jupiter-keyless",
): Promise<number> {
  const sql = neon(url, {
    fetchOptions: { signal: AbortSignal.timeout(5000) },
  });
  const rows = await sql`INSERT INTO fomo_provider_budget (name, next_at)
    VALUES (${name}, clock_timestamp() + interval '2200 milliseconds')
    ON CONFLICT (name) DO UPDATE
      SET next_at = GREATEST(fomo_provider_budget.next_at, clock_timestamp()) + interval '2200 milliseconds'
      WHERE fomo_provider_budget.next_at <= clock_timestamp() + interval '2200 milliseconds'
    RETURNING GREATEST(0, EXTRACT(EPOCH FROM (next_at - clock_timestamp())) * 1000 - 2200) AS wait_ms`;
  if (!rows.length) throw new ProviderBusy();
  return Math.max(0, Math.ceil(Number(rows[0].wait_ms)));
}
export async function waitForProviderSlot() {
  if (!process.env.DATABASE_URL)
    throw new Error("Shared provider budget unavailable.");
  const wait = await reserveProviderSlot(process.env.DATABASE_URL);
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
}
