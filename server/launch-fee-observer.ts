import { neon } from "@neondatabase/serverless";
import { Connection } from "@solana/web3.js";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readLaunchFeeVault } from "./launch-payout-chain.js";
import type { PayoutRoute } from "./launch-payout-model.js";
export type FeeClaim = { route: PayoutRoute; lease: string };
export type FeeSnapshot = { available: bigint; slot: number };
export function launchFeeStore(url: string) {
  const database = () => neon(url, {
    fetchOptions: { signal: AbortSignal.timeout(7000) },
  });
  return {
    async claim(): Promise<FeeClaim | null> {
      const sql = database();
      const lease = randomUUID();
      // Register newly confirmed launches; never poll drafts or unconfirmed mints.
      await sql`INSERT INTO fomo_launch_fee_checks(mint) SELECT mint FROM fomo_public_launches ON CONFLICT DO NOTHING`;
      const r =
        await sql`WITH due AS (SELECT c.mint FROM fomo_launch_fee_checks c JOIN fomo_public_launches p ON p.mint=c.mint WHERE c.next_at<=clock_timestamp() AND (c.lease_until IS NULL OR c.lease_until<clock_timestamp()) ORDER BY c.next_at,c.mint LIMIT 1 FOR UPDATE OF c SKIP LOCKED), claimed AS (UPDATE fomo_launch_fee_checks c SET lease_id=${lease}::uuid,lease_until=clock_timestamp()+interval '50 seconds' FROM due WHERE c.mint=due.mint RETURNING c.mint) SELECT p.mint,p.recipient,p.buyback_wallet FROM claimed c JOIN fomo_launch_payouts p ON p.mint=c.mint`;
      return r.length
        ? {
            lease,
            route: {
              mint: r[0].mint,
              recipient: r[0].recipient,
              buybackWallet: r[0].buyback_wallet,
            },
          }
        : null;
    },
    async complete(claim: FeeClaim, snapshot: FeeSnapshot | null) {
      const sql = database();
      if (
        snapshot &&
        (snapshot.available < 0n ||
          snapshot.available > 18446744073709551615n ||
          !Number.isSafeInteger(snapshot.slot) ||
          snapshot.slot < 1)
      )
        throw Error("Invalid fee snapshot");
      // Consuming the live lease and saving its observation is atomic. Older slots
      // cannot overwrite a newer result, even after retries or worker overlap.
      await sql`WITH owned AS (UPDATE fomo_launch_fee_checks SET lease_id=NULL,lease_until=NULL,next_at=clock_timestamp()+interval '60 seconds',last_error_at=CASE WHEN ${snapshot === null} THEN clock_timestamp() ELSE NULL END WHERE mint=${claim.route.mint} AND lease_id=${claim.lease}::uuid AND lease_until>clock_timestamp() RETURNING mint)
    INSERT INTO fomo_launch_fee_snapshots(mint,available_lamports,slot) SELECT mint,${snapshot?.available.toString() ?? "0"}::numeric,${snapshot?.slot ?? 0}::bigint FROM owned WHERE ${snapshot !== null}
    ON CONFLICT(mint) DO UPDATE SET available_lamports=EXCLUDED.available_lamports,slot=EXCLUDED.slot,observed_at=clock_timestamp() WHERE EXCLUDED.slot>=fomo_launch_fee_snapshots.slot`;
    },
  };
}
export async function observeLaunchFees(
  store: Pick<ReturnType<typeof launchFeeStore>, "claim" | "complete">,
  read: (r: PayoutRoute) => Promise<FeeSnapshot>,
  now = Date.now,
) {
  const until = now() + 35000;
  let checked = 0,
    failed = 0;
  // Bounded batch; durable next_at order gives every token its turn.
  while (checked + failed < 12 && now() < until) {
    const claim = await store.claim();
    if (!claim) break;
    try {
      const snapshot = await read(claim.route);
      await store.complete(claim, snapshot);
      checked++;
    } catch {
      await store.complete(claim, null);
      failed++;
    }
  }
  return { checked, failed };
}
export function launchFeeObserverHandler(
  run?: () => Promise<{ checked: number; failed: number }>,
) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    const send = (status: number, value: unknown) => {
      res.statusCode = status;
      res.end(JSON.stringify(value));
    };
    if (req.method !== "GET") return send(405, { message: "GET required." });
    const expected = process.env.CRON_SECRET
        ? `Bearer ${process.env.CRON_SECRET}`
        : "",
      actual = String(req.headers.authorization || "");
    if (
      !expected ||
      Buffer.byteLength(expected) !== Buffer.byteLength(actual) ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
    )
      return send(401, { message: "Unauthorized." });
    try {
      if (run) return send(200, await run());
      if (!process.env.DATABASE_URL)
        return send(503, { message: "Fee observation is not configured." });
      const deadline = AbortSignal.timeout(40000);
      const connection = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", {
        commitment: "finalized",
        disableRetryOnRateLimit: true,
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            signal: AbortSignal.any([deadline, AbortSignal.timeout(8000)]),
          }),
      });
      return send(
        200,
        await observeLaunchFees(launchFeeStore(process.env.DATABASE_URL), (r) =>
          readLaunchFeeVault(connection, r),
        ),
      );
    } catch {
      return send(503, { message: "Fee observation is unavailable." });
    }
  };
}
export const handleLaunchFeeObserver = launchFeeObserverHandler();
