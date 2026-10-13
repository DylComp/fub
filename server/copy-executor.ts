import {recoverNativeHandoff,type NativeSignatureRecovery} from "./native-signature-recovery.js";
import { neon } from "@neondatabase/serverless";
import type { IncomingMessage, ServerResponse } from "node:http";
import { serviceConnection } from "./copy-service.js";
import { copyReadRpc, reserveCopyScan } from "./copy-rpc.js";
import { MAINNET_GENESIS } from "./solana-network.js";
import { runCopyRecovery } from "./copy-recovery-worker.js";
import { copyRecoveryStore } from "./copy-recovery-store.js";
import { copyExecution } from "./copy-execution.js";
import { blockRecoveryRpc } from "./copy-block-recovery.js";
import { copyDispatchStore } from "./copy-dispatch-store.js";
import { runCopyDispatch } from "./copy-dispatch-worker.js";
import type { CopySigningAdapter } from "./copy-dispatch-worker.js";
import { executorRpc } from "./copy-executor-rpc.js";
import { runToken22Recovery } from "./token2022-recovery-worker.js";
import { token22Journal } from "./token2022-journal.js";
import { token22Accounting } from "./token2022-accounting.js";
import { runNativeExecutor } from "./token2022-executor.js";
import type { Token22Signer } from "./token2022-signing.js";

export type ExecutorConfig = {
  url: string;
  endpoint: string;
  archiveEndpoint?: string;
  port: number;
  mode: "recover" | "execute";
  apiKey?: string;
  nativeEnabled?: boolean;
};
export function executorConfig(
  env: Record<string, string | undefined>,
): ExecutorConfig {
  if (env.COPY_EXECUTOR_ENABLED !== "true" || env.VERCEL_ENV || env.VERCEL)
    throw new Error("A standalone executor host must be explicitly enabled.");
  const mode = env.COPY_EXECUTOR_MODE || "recover";
  if (
    !["recover", "execute"].includes(mode) ||
    env.FUNDING_EXECUTION_ENABLED === "true"
  )
    throw new Error(
      "Invalid executor mode or unrelated funding configuration.",
    );
  if (
    mode === "execute" &&
    (env.COPY_EXECUTION_ENABLED !== "true" || !env.JUPITER_API_KEY?.trim())
  )
    throw new Error(
      "Execution requires explicit opt-in and provider configuration.",
    );
  if (mode === "recover" && env.COPY_EXECUTION_ENABLED === "true")
    throw new Error("Recovery mode cannot enable execution.");
  if (env.COPY_NATIVE_EXECUTION_ENABLED === "true" && mode !== "execute")
    throw new Error("Native execution requires execution mode.");
  const { url, endpoint, port } = serviceConnection(env);
  if (env.SOLANA_ARCHIVE_RPC_URL) blockRecoveryRpc(env.SOLANA_ARCHIVE_RPC_URL);
  return {
    url,
    endpoint,
    port,
    mode: mode as ExecutorConfig["mode"],
    nativeEnabled: env.COPY_NATIVE_EXECUTION_ENABLED === "true",
    ...(env.SOLANA_ARCHIVE_RPC_URL
      ? { archiveEndpoint: env.SOLANA_ARCHIVE_RPC_URL }
      : {}),
    ...(mode === "execute" ? { apiKey: env.JUPITER_API_KEY } : {}),
  };
}
export type ExecutorOutcome =
  | "idle"
  | "recovering"
  | "halted"
  | "waiting_for_feed"
  | "submitted"
  | "prepared"
  | "skipped"
  | "superseded"
  | "retry";
export type ExecutorDependencies = {
  probe(signal: AbortSignal): Promise<void>;
  tick(signal: AbortSignal): Promise<ExecutorOutcome>;
};
export function executorDependencies(
  config: ExecutorConfig,
  signer?: CopySigningAdapter,
  nativeSigner?: Token22Signer,
  nativeRecovery?: NativeSignatureRecovery,
): ExecutorDependencies {
  if (config.mode === "execute" && (!signer || !config.apiKey))
    throw new Error(
      "A policy-enforcing signing adapter must be installed before execution can start.",
    );
  if (config.nativeEnabled && (config.mode !== "execute" || !nativeSigner))
    throw new Error(
      "Native execution requires its policy-enforcing signing adapter.",
    );
  const control = copyDispatchStore(config.url);
  let nativeTurn = true,
    nativeRecoveryTurn = false;
  return {
    async probe(signal) {
      if (
        (await copyReadRpc(config.endpoint, signal)("getGenesisHash", [])) !==
        MAINNET_GENESIS
      )
        throw new Error("Execution provider is not Solana mainnet.");
      // Fails startup if the queue schema or control row is unavailable. Never
      // turns it on. The worker rechecks the control inside each durable claim.
      if (!(await control.health()))
        throw new Error("Execution control is unavailable.");
    },
    async tick(signal) {
      signal.throwIfAborted();
      nativeRecoveryTurn = !nativeRecoveryTurn;
      if(nativeRecoveryTurn && nativeRecovery && await recoverNativeHandoff(config.url,nativeRecovery,signal))return "recovering";
      const recovered = await runCopyRecovery({
        store: copyRecoveryStore(config.url),
        reserve: () => reserveCopyScan(config.url, config.endpoint),
        rpc: () => copyReadRpc(config.endpoint, signal),
        recover: (wallet, id, rpc) =>
          copyExecution({
            url: config.url,
            rpc,
            blockRecoveryRpc: blockRecoveryRpc(
              config.archiveEndpoint || config.endpoint,
              signal,
            ),
          }).recover(wallet, id),
        preferToken22: nativeRecoveryTurn,
        recoverToken22: () =>
          runToken22Recovery({
            store: token22Journal(config.url),
            reserve: () => reserveCopyScan(config.url, config.endpoint),
            rpc: () => copyReadRpc(config.endpoint, signal),
            reconcile: () => token22Accounting(config.url).reconcile(),
          }),
      });
      signal.throwIfAborted();
      if (recovered.handled)
        return recovered.outcome === "retry" ? "retry" : "recovering";
      if (config.mode === "recover") return "idle";
      const health = await control.health();
      if (!health) throw new Error("Execution control disappeared.");
      if (!health.enabled) return "halted";
      // A timeout belongs to this read, not the lifetime of the worker.
      const sql = neon(config.url, {
        fetchOptions: {
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        },
      });
      // Continuous feed availability is operational readiness. Individual signal
      // freshness and journal gaps are still checked atomically by dispatch.
      const feed =
        await sql`SELECT 1 FROM fomo_copy_service WHERE name='observer' AND lease_until>clock_timestamp()
        AND last_heartbeat_at>clock_timestamp()-interval '75 seconds' AND outcome NOT IN('retry','stopped')`;
      if (!feed.length) return "waiting_for_feed";
      signal.throwIfAborted();
      const options = {
        url: config.url,
        rpc: executorRpc(config.endpoint, signal),
        apiKey: config.apiKey,
        enabled: true,
        signer,
        signal,
      };
      const standard = () => runCopyDispatch(options);
      const native = () =>
        runNativeExecutor({ ...options, signer: nativeSigner });
      // Alternate first refusal; an empty lane gives the other lane the tick.
      // Each handled tick retains a single RPC transport and send budget.
      const firstNative = config.nativeEnabled && nativeTurn;
      if (config.nativeEnabled) nativeTurn = !nativeTurn;
      let result = await (firstNative ? native() : standard());
      if (config.nativeEnabled && result.outcome === "idle") {
        signal.throwIfAborted();
        result = await (firstNative ? standard() : native());
      }
      if (result.outcome === "disabled")
        throw new Error("Execution dependencies unavailable.");
      return result.outcome;
    },
  };
}
export type ExecutorHealth = {
  mode: ExecutorConfig["mode"];
  phase: "starting" | "running" | "degraded" | "stopping" | "stopped";
  lastCompletedAt: number | null;
  outcome: ExecutorOutcome | null;
  iterations: number;
};
export function executorHealthHandler(state: ExecutorHealth, now = Date.now) {
  return (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET");
      res.end('{"status":"method_not_allowed"}');
      return;
    }
    if (req.url !== "/healthz") {
      res.statusCode = 404;
      res.end('{"status":"not_found"}');
      return;
    }
    const ready =
      state.phase === "running" &&
      state.lastCompletedAt !== null &&
      now() - state.lastCompletedAt < 60000;
    res.statusCode = ready ? 200 : 503;
    res.end(
      JSON.stringify({
        status: ready
          ? "ready"
          : state.phase === "running"
            ? "stale"
            : state.phase,
        mode: state.mode,
        outcome: state.outcome,
      }),
    );
  };
}
function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
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
export async function runExecutor(
  deps: ExecutorDependencies,
  state: ExecutorHealth,
  signal: AbortSignal,
  onChange: (state: ExecutorHealth) => void = () => {},
) {
  let lastProbe = 0,
    failures = 0,
    previous = "";
  const publish = () => {
    const next = state.phase + ":" + state.outcome;
    if (next !== previous) {
      previous = next;
      onChange({ ...state });
    }
  };
  try {
    if (signal.aborted) return;
    await deps.probe(signal);
    lastProbe = Date.now();
    while (!signal.aborted) {
      if (failures || Date.now() - lastProbe >= 60000) {
        await deps.probe(signal);
        lastProbe = Date.now();
      }
      if (signal.aborted) break;
      const controller = new AbortController(),
        combined = AbortSignal.any([signal, controller.signal]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const outcome = await Promise.race([
          deps.tick(combined),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error("Executor iteration exceeded its deadline."));
            }, 45000);
          }),
        ]);
        if (signal.aborted) break;
        state.outcome = outcome;
        state.iterations++;
        state.lastCompletedAt = Date.now();
        failures =
          outcome === "retry" || outcome === "waiting_for_feed"
            ? Math.min(failures + 1, 5)
            : 0;
        state.phase = failures ? "degraded" : "running";
      } finally {
        if (timer) clearTimeout(timer);
        controller.abort();
      }
      publish();
      await wait(
        failures
          ? Math.min(30000, 1000 * 2 ** failures)
          : ["idle", "halted"].includes(state.outcome!)
            ? 5000
            : 1000,
        signal,
      );
    }
  } catch (error) {
    if (!signal.aborted) {
      state.phase = "degraded";
      publish();
      throw error;
    }
  } finally {
    state.phase = "stopping";
    publish();
    state.phase = "stopped";
    publish();
  }
}
