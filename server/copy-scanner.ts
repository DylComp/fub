import type { MonitorClaim } from "./copy-monitor-store.js";
import type { Rpc } from "./funding.js";
import { FeedCapacity } from "./copy-feed-store.js";
import type { CopyFeedStore, FeedLease } from "./copy-feed-store.js";
import type { LeaderSignature } from "../src/copy-feed.js";
import {
  classifyLeaderSwap,
  parseLeaderSignatures,
} from "./copy-classifier.js";

// A bounded, read-only worker iteration. Never signs, quotes, reserves money or broadcasts.
// Discovery journals every signature atomically with the cursor before reading receipts.
export async function scanCopyFeed(
  store: CopyFeedStore,
  rpc: Rpc,
  wallet: string,
  planId: string,
  monitor?: MonitorClaim,
) {
  const lease = await store.acquire(wallet, planId, monitor);
  if (!lease) return store.report(wallet, planId);
  try {
    if (!lease.initialized) {
      const slot = await rpc("getSlot", [{ commitment: "finalized" }]);
      if (!Number.isSafeInteger(slot) || (slot as number) < 0)
        throw new Error("Invalid finalized slot.");
      const rows = parseLeaderSignatures(
        await rpc("getSignaturesForAddress", [
          lease.leader,
          { limit: 1, commitment: "finalized", minContextSlot: slot },
        ]),
        1,
      );
      await store.checkpoint(
        lease,
        [],
        rows[0]?.signature || null,
        slot as number,
      );
      await store.finish(
        lease,
        "ready",
        "Starting point saved. Check again for new finalized activity. Older trades will not be copied.",
      );
      return store.report(wallet, planId);
    }
    // Drain the oldest receipt first. Unavailable evidence never advances past it.
    let queued = await store.pending(lease);
    if (!queued.length) {
      const found = await discover(rpc, lease);
      if (!found.complete && found.more) {
        await store.stage(lease, found.rows);
        await store.finish(
          lease,
          "catching_up",
          `${found.rows.length} signatures saved while locating the last checkpoint. Check again to continue.`,
        );
        return store.report(wallet, planId);
      }
      if (!found.complete) {
        await store.finish(
          lease,
          "gap",
          "The saved starting point was not reached within the available history or 1,000-transaction limit. Activity is paused until the gap is resolved.",
        );
        return store.report(wallet, planId);
      }
      await store.checkpoint(
        lease,
        [...found.rows].reverse(),
        found.rows[0]?.signature || lease.cursor,
        lease.startSlot!,
      );
      queued = await store.pending(lease);
    }
    for (const event of queued) {
      const receipt = await rpc("getTransaction", [
        event.signature,
        {
          encoding: "jsonParsed",
          commitment: "finalized",
          maxSupportedTransactionVersion: 1,
        },
      ]);
      if (receipt === null)
        throw new Error("Finalized receipt not available yet.");
      await store.record(
        lease,
        event,
        classifyLeaderSwap(receipt, lease.leader, event),
      );
    }
    await store.finish(
      lease,
      "ready",
      "Activity checked. These records do not place trades.",
    );
  } catch (error) {
    await store.finish(
      lease,
      error instanceof FeedCapacity ? "gap" : "retry",
      error instanceof FeedCapacity
        ? "The 10,000-record activity limit was reached. Background checks are paused; existing records and checkpoints are kept."
        : "The activity check could not finish. Saved progress is kept. Check again to retry the missing evidence.",
    );
  }
  return store.report(wallet, planId);
}
async function discover(rpc: Rpc, lease: FeedLease) {
  const rows: LeaderSignature[] = [...lease.staged],
    seen = new Set(rows.map((row) => row.signature));
  let before: string | undefined = rows.at(-1)?.signature,
    lastSlot = rows.at(-1)?.slot ?? Number.MAX_SAFE_INTEGER;
  for (let page = 0; page < 4 && rows.length < 1000; page++) {
    const batch = parseLeaderSignatures(
      await rpc("getSignaturesForAddress", [
        lease.leader,
        {
          limit: 25,
          commitment: "finalized",
          ...(before ? { before } : {}),
          minContextSlot: lease.startSlot!,
        },
      ]),
      25,
    );
    for (const event of batch) {
      if (event.slot > lastSlot || seen.has(event.signature))
        throw new Error("Activity pagination is inconsistent.");
      if (
        event.signature === lease.cursor ||
        (!lease.cursor && event.slot <= lease.startSlot!)
      )
        return { rows, complete: true };
      lastSlot = event.slot;
      seen.add(event.signature);
      rows.push(event);
    }
    if (batch.length < 25) return { rows, complete: !lease.cursor };
    before = batch[batch.length - 1].signature;
  }
  return { rows, complete: false, more: rows.length < 1000 };
}
