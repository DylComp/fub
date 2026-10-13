import type { IncomingMessage, ServerResponse } from "node:http";
import { copyServiceStore } from "./copy-service-store.js";
import type { ServiceOutcome } from "./copy-service-store.js";
import { copyMonitorStore } from "./copy-monitor-store.js";
import { copyFeedStore } from "./copy-feed-store.js";
import { runCopyMonitorBatch } from "./copy-monitor-worker.js";
import { copyReadRpc, reserveCopyScan } from "./copy-rpc.js";
import { copyRecoveryStore } from "./copy-recovery-store.js";
import { runCopyRecovery } from "./copy-recovery-worker.js";
import { copyStream } from "./copy-stream.js";
import { copyExecution } from "./copy-execution.js";

import { MAINNET_GENESIS } from "./solana-network.js";
export { MAINNET_GENESIS } from "./solana-network.js";
import { blockRecoveryRpc } from "./copy-block-recovery.js";
export type ServiceConfig = {
  url: string;
  endpoint: string;
  intervalSeconds: number;
  port: number;
};
export function serviceConfig(
  env: Record<string, string | undefined>,
): ServiceConfig {
  if (env.COPY_SERVICE_ENABLED !== "true" || env.VERCEL_ENV || env.VERCEL)
    throw new Error("Continuous observation is not enabled.");
  if (
    (env.COPY_SERVICE_MODE && env.COPY_SERVICE_MODE !== "observe") ||
    env.FUNDING_EXECUTION_ENABLED === "true" ||
    env.COPY_EXECUTION_ENABLED === "true"
  )
    throw new Error("This service supports observation and recovery only.");
  return serviceConnection(env);
}
// Shared by independently hosted observer and execution processes.
export function serviceConnection(
  env: Record<string, string | undefined>,
): ServiceConfig {
  const intervalSeconds = Number(env.COPY_SERVICE_INTERVAL_SECONDS || 3),
    port = Number(env.PORT || 8080);
  if (
    !Number.isInteger(intervalSeconds) ||
    intervalSeconds < 3 ||
    intervalSeconds > 15 ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error("Invalid service timing or port.");
  let db: URL, rpc: URL;
  try {
    db = new URL(env.DATABASE_URL || "");
    rpc = new URL(env.SOLANA_RPC_URL || "");
  } catch {
    throw new Error("Database and dedicated HTTPS RPC are required.");
  }
  if (
    !["postgres:", "postgresql:"].includes(db.protocol) ||
    rpc.protocol !== "https:" ||
    rpc.username ||
    rpc.password ||
    rpc.hash ||
    [
      "api.mainnet-beta.solana.com",
      "api.devnet.solana.com",
      "api.testnet.solana.com",
      "localhost",
      "127.0.0.1",
      "[::1]",
    ].includes(rpc.hostname)
  )
    throw new Error("Database and dedicated HTTPS RPC are required.");
  return {
    url: db.toString(),
    endpoint: rpc.toString(),
    intervalSeconds,
    port,
  };
}
export type ServiceHealth = {
  phase: "starting" | "waiting-for-lease" | "running" | "degraded" | "stopping" | "stopped";
  lastCompletedAt: number | null;
  outcome: ServiceOutcome | null;
  iterations: number;
  stream?: {mode:string;subscriptions:number;connected:boolean};
};
export function healthHandler(state: ServiceHealth, now = Date.now) {
  return (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET");
      res.end(JSON.stringify({ status: "method_not_allowed" }));
      return;
    }
    if (req.url !== "/healthz") {
      res.statusCode = 404;
      res.end(JSON.stringify({ status: "not_found" }));
      return;
    }
    const ready =
      state.phase === "running" &&
      state.lastCompletedAt !== null &&
      now() - state.lastCompletedAt < 75000;
    res.statusCode = ready ? 200 : 503;
    // No wallet addresses, database details, provider URLs or error stacks.
    res.end(
      JSON.stringify({
        status: ready
          ? "ready"
          : state.phase === "running"
            ? "stale"
            : state.phase,
        mode: "observe",
        execution: false,
        outcome: state.outcome,
        ...(state.stream?{stream:state.stream}:{}),
      }),
    );
  };
}
export function observerDependencies(config: ServiceConfig) {
  const reserve = () => reserveCopyScan(config.url, config.endpoint);
  const stream = process.env.COPY_SERVICE_STREAM_ENABLED === 'true' ? copyStream(config.endpoint) : null;
  return {
    store: copyServiceStore(config.url),
    close: () => stream?.close(),
    monitoring: () => stream?.status(),
    async probe(signal: AbortSignal) {
      if (
        (await copyReadRpc(config.endpoint, signal)("getGenesisHash", [])) !==
        MAINNET_GENESIS
      )
        throw new Error("RPC is not Solana mainnet.");
    },
    async tick(leaseId: string, signal: AbortSignal): Promise<ServiceOutcome> {
      const rpc = () => copyReadRpc(config.endpoint, signal);
      if(stream)stream.update(await copyMonitorStore(config.url).activePlans());
      const hints=stream?.snapshot();
      // Confirmation and expiry always run before spending quota on new activity.
      const recovered = await runCopyRecovery({
        store: copyRecoveryStore(config.url),
        reserve,
        rpc,
        recover: (wallet, id, read) =>
          copyExecution({
            url: config.url,
            rpc: read,
            blockRecoveryRpc: blockRecoveryRpc(
              process.env.SOLANA_ARCHIVE_RPC_URL || config.endpoint,
              signal,
            ),
          }).recover(wallet, id),
      });
      if (signal.aborted) throw new Error("Observer stopped.");
      if (recovered.handled) return recovered.outcome as ServiceOutcome;
      const monitors=copyMonitorStore(config.url, {
        intervalSeconds:config.intervalSeconds,serviceLeaseId:leaseId,
        ...(hints?{wakePlanIds:hints.wakePlanIds}:{}),
      });
      const scanned = await runCopyMonitorBatch({
        monitors: {...monitors,complete:async(claim,outcome)=>{
          await monitors.complete(claim,outcome);
          if(outcome==='ready')hints?.acknowledge(claim.planId);
        }},
        feeds: copyFeedStore(config.url, config.intervalSeconds),
        reserve,
        rpc,
      }, signal);
      return scanned.outcome as ServiceOutcome;
    },
  };
}
export type ObserverDependencies = Omit<ReturnType<typeof observerDependencies>, "close" | "monitoring"> & {close?:()=>void;monitoring?:()=>ServiceHealth["stream"]};
function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}
export async function runObserver(
  deps: ObserverDependencies,
  state: ServiceHealth,
  signal: AbortSignal,
  onChange: (health: ServiceHealth) => void = () => {},
) {
  let lease: string | null = null,
    failures = 0,
    previous = "",
    lastProbeAt = 0;
  const publish = () => {
    const key = state.phase + ":" + state.outcome;
    if (key !== previous) {
      previous = key;
      onChange({ ...state });
    }
  };
  try {
    if (signal.aborted) return;
    await deps.probe(signal);
    lastProbeAt = Date.now();
    if (signal.aborted) return;
    // A crash leaves the previous owner's 90-second lease intact. Allow a
    // replacement to wait for natural expiry instead of exhausting its host's
    // restart attempts. A live owner remains fenced and is never displaced.
    const acquireUntil = Date.now() + 100000;
    while (!signal.aborted) {
      lease = await deps.store.begin();
      if (lease) break;
      state.phase = "waiting-for-lease";
      publish();
      if (Date.now() >= acquireUntil)
        throw new Error("Another observer holds the service lease.");
      await wait(5000, signal);
    }
    if (signal.aborted) return;
    if (!lease) throw new Error("Another observer holds the service lease.");
    while (!signal.aborted) {
      if (!(await deps.store.heartbeat(lease, state.outcome || "idle")))
        throw new Error("Observer lease expired.");
      if (failures || Date.now() - lastProbeAt >= 60000) {
        await deps.probe(signal);
        lastProbeAt = Date.now();
      }
      if (signal.aborted) break;
      const controller = new AbortController(),
        combined = AbortSignal.any([signal, controller.signal]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const outcome = await Promise.race([
          deps.tick(lease, combined),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error("Observer iteration timed out."));
            }, 45000);
          }),
        ]);
        state.outcome = outcome;
        state.stream = deps.monitoring?.();
        failures = outcome === "retry" ? Math.min(failures + 1, 5) : 0;
        state.phase = failures ? "degraded" : "running";
        state.lastCompletedAt = Date.now();
        state.iterations++;
        if (!(await deps.store.heartbeat(lease, outcome)))
          throw new Error("Observer lease expired.");
      } finally {
        if (timer) clearTimeout(timer);
        controller.abort();
      }
      publish();
      await wait(
        failures
          ? Math.min(30000, 1000 * 2 ** failures)
          : state.outcome === "idle"
            ? 5000
            : 1000,
        signal,
      );
    }
  } catch (error) {
    state.phase = "degraded";
    publish();
    throw error;
  } finally {
    deps.close?.();
    state.phase = "stopping";
    publish();
    if (lease) await deps.store.release(lease);
    state.phase = "stopped";
    publish();
  }
}
