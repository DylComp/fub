import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { copyMonitorStore, monitorAvailable } from "./copy-monitor-store.js";
import { copyFeedStore } from "./copy-feed-store.js";
import { copyReadRpc, reserveCopyScan } from "./copy-rpc.js";
import { scanCopyFeed } from "./copy-scanner.js";
import { recoveryAvailable } from "./copy-recovery-store.js";
import { runCopyRecovery } from "./copy-recovery-worker.js";
import type { CopyMonitor } from "../src/copy-monitor.js";
import { copyBatchRpc } from "./copy-batch-rpc.js";

// One scheduled invocation shares the provider quota. Confirmation recovery has
// priority over discovering new activity, including for paused/archived plans.
export async function runCopyBackground(
  deps = {
    recoveryAvailable,
    monitorAvailable,
    recover: runCopyRecovery,
    monitor: runCopyMonitor,
  },
) {
  if (deps.recoveryAvailable()) {
    const result = await deps.recover();
    if (result.handled) return { outcome: result.outcome };
  }
  return deps.monitorAvailable() ? deps.monitor() : { outcome: "idle" };
}
export function validWorkerAuth(
  header: unknown,
  secret = process.env.CRON_SECRET,
) {
  if (!secret || secret.length < 32 || typeof header !== "string")
    return false;
  const expected = Buffer.from(`Bearer ${secret}`),
    actual = Buffer.from(header);
  return (
    actual.length === expected.length && timingSafeEqual(actual, expected)
  );
}
export async function runCopyMonitor(
  deps = {
    monitors: copyMonitorStore(process.env.DATABASE_URL!),
    feeds: copyFeedStore(process.env.DATABASE_URL!),
    reserve: () => reserveCopyScan(process.env.DATABASE_URL!),
    rpc: copyReadRpc,
  },
) {
  const worker = await deps.monitors.beginWorker();
  if (!worker) return { outcome: "busy" };
  let outcome = "idle";
  try {
    const claim = await deps.monitors.claim();
    if (!claim) return { outcome };
    try {
      if (!(await deps.reserve())) {
        outcome = "busy";
        await deps.monitors.complete(claim, "busy");
        return { outcome };
      }
      let acquired = false;
      const feeds = {
        ...deps.feeds,
        acquire: async (...args: Parameters<typeof deps.feeds.acquire>) => {
          const lease = await deps.feeds.acquire(...args);
          acquired = !!lease;
          return lease;
        },
      };
      const result = await scanCopyFeed(
        feeds,
        deps.rpc(),
        claim.wallet,
        claim.planId,
        claim,
      );
      const state = acquired ? result?.status || "retry" : "busy";
      outcome = state;
      await deps.monitors.complete(claim, state);
      return { outcome };
    } catch {
      outcome = "retry";
      await deps.monitors.complete(claim, "retry");
      return { outcome };
    }
  } catch (error) {
    outcome = "retry";
    throw error;
  } finally {
    await deps.monitors.endWorker(worker, outcome);
  }
}

// Hosted observation only. Cron/manual scans retain their existing one-plan
// path. Every plan still acquires its own versioned feed lease before any read.
export async function runCopyMonitorBatch(
  deps: Parameters<typeof runCopyMonitor>[0] & {},
  signal?: AbortSignal,
) {
  const worker = await deps.monitors.beginWorker();
  if (!worker) return { outcome: "busy", scanned: 0 };
  let outcome: CopyMonitor["outcome"] = "idle";
  let batch: ReturnType<typeof copyBatchRpc> | undefined;
  try {
    // Reserve before claiming: a busy provider must not push due plans back.
    if (signal?.aborted) return { outcome, scanned: 0 };
    if (!(await deps.reserve())) return { outcome: (outcome = "busy"), scanned: 0 };
    const claims = await deps.monitors.claimMany(5);
    if (!claims.length) return { outcome, scanned: 0 };
    batch = copyBatchRpc(deps.rpc(), signal);
    const read = batch.rpc;
    const results = await Promise.allSettled(claims.map(async (claim) => {
      let state: CopyMonitor["outcome"] = "retry";
      try {
        if (signal?.aborted) throw new Error("Observer stopped.");
        let acquired = false;
        const feeds = {
          ...deps.feeds,
          acquire: async (...args: Parameters<typeof deps.feeds.acquire>) => {
            const lease = await deps.feeds.acquire(...args);
            acquired = !!lease;
            return lease;
          },
        };
        const result = await scanCopyFeed(feeds, read, claim.wallet, claim.planId, claim);
        state = acquired ? result?.status || "retry" : "busy";
      } finally {
        await deps.monitors.complete(claim, state);
      }
      return state;
    }));
    // Wait for all siblings even if one database operation fails. Never release
    // the singleton worker while another plan is still writing its checkpoint.
    outcome = results.some(r => r.status === "rejected" || r.value === "retry")
      ? "retry"
      : results.some(r => r.status === "fulfilled" && r.value === "catching_up")
        ? "catching_up"
        : results.some(r => r.status === "fulfilled" && r.value === "ready")
          ? "ready"
          : results.some(r => r.status === "fulfilled" && r.value === "gap")
            ? "gap" : "busy";
    return { outcome, scanned: claims.length, ...batch.stats() };
  } catch (error) {
    outcome = "retry";
    throw error;
  } finally {
    batch?.close();
    await deps.monitors.endWorker(worker, outcome);
  }
}
export async function handleCopyMonitor(
  req: IncomingMessage,
  res: ServerResponse,
) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
  const send = (status: number, body: unknown) => {
    res.statusCode = status;
    res.end(JSON.stringify(body));
  };
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    send(405, { message: "Method not allowed." });
    return;
  }
  if (!validWorkerAuth(req.headers.authorization)) {
    send(401, { message: "Unauthorized." });
    return;
  }
  if (!monitorAvailable() && !recoveryAvailable()) {
    send(503, { message: "Background checks are paused." });
    return;
  }
  try {
    const result = await runCopyBackground();
    send(result.outcome === "retry" ? 503 : 200, result);
  } catch {
    send(503, { message: "Background check unavailable." });
  }
}
