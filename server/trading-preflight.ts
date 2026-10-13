import { operationsIssues, operationsSnapshot, type OperationsSnapshot } from "./copy-operations.js";
import { serviceConnection } from "./copy-service.js";
import { copyReadRpc } from "./copy-rpc.js";
import { MAINNET_GENESIS } from "./solana-network.js";

type Env = Record<string, string | undefined>;
type Result = { status: "ok" | "missing" | "failed"; issue?: string };
export type SignerCapabilities = { version: 1; ready: boolean; executionEnabled: boolean; nativeExecutionEnabled: boolean; scope: "disabled" | "pilot" | "public"; pilotWalletCount: number };
export type TradingPreflightDependencies = {
  snapshot(url: string): Promise<OperationsSnapshot>;
  rpc(endpoint: string): Promise<void>;
  quote(key: string): Promise<void>;
  signer(origin: string, token: string): Promise<SignerCapabilities>;
};
async function json(response: Response, limit: number, signal: AbortSignal): Promise<any> {
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel(); throw Error();
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) { const part = await reader.read(); signal.throwIfAborted(); if (part.done) break; size += part.value.length; if (size > limit) throw Error(); chunks.push(part.value); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { signal.removeEventListener("abort", cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export const tradingPreflightProbes: TradingPreflightDependencies = {
  snapshot: operationsSnapshot,
  async rpc(endpoint) {
    const read = copyReadRpc(endpoint, AbortSignal.timeout(12000));
    if (await read("getGenesisHash", []) !== MAINNET_GENESIS) throw Error();
    const slot = await read("getSlot", [{ commitment: "finalized" }]);
    if (!Number.isSafeInteger(slot) || (slot as number) <= 0) throw Error();
  },
  async quote(key) {
    const inputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", outputMint = "So11111111111111111111111111111111111111112";
    const query = new URLSearchParams({ inputMint, outputMint, amount: "1000000", slippageBps: "100", onlyDirectRoutes: "true" });
    const signal = AbortSignal.timeout(12000);
    const body = await json(await fetch(`https://api.jup.ag/swap/v1/quote?${query}`, { headers: { "x-api-key": key }, signal, redirect: "error", cache: "no-store" }), 100000, signal);
    if (body?.inputMint !== inputMint || body.outputMint !== outputMint || body.inAmount !== "1000000" || body.swapMode !== "ExactIn" || !/^[1-9]\d*$/.test(body.outAmount) || !Array.isArray(body.routePlan) || !body.routePlan.length) throw Error();
  },
  async signer(origin, token) {
    const signal = AbortSignal.timeout(12000);
    const body = await json(await fetch(`${origin}/v1/capabilities`, { headers: { Authorization: `Bearer ${token}` }, signal, redirect: "error", cache: "no-store" }), 4096, signal);
    if (!body || Object.keys(body).sort().join(",") !== "executionEnabled,nativeExecutionEnabled,pilotWalletCount,ready,scope,version" || body.version !== 1 || typeof body.ready !== "boolean" || typeof body.executionEnabled !== "boolean" || typeof body.nativeExecutionEnabled !== "boolean" || !["disabled", "pilot", "public"].includes(body.scope) || !Number.isInteger(body.pilotWalletCount) || body.pilotWalletCount < 0 || body.pilotWalletCount > 5 || (body.scope === "pilot" ? body.pilotWalletCount === 0 : body.pilotWalletCount !== 0)) throw Error();
    return body;
  },
};

// This command never invokes a signing/dispatch function, changes a control,
// starts a worker, writes a database row or asks an owner for a signature.
export async function tradingPreflight(env: Env, mode: "prepare" | "pilot" = "prepare", deps = tradingPreflightProbes) {
  const checks: Record<string, Result> = {};
  let snapshot: OperationsSnapshot | null = null, capabilities: SignerCapabilities | null = null;
  const check = async (name: string, configured: boolean, work: () => Promise<void>, issue: string) => {
    if (!configured) { checks[name] = { status: "missing", issue }; return; }
    try { await work(); checks[name] = { status: "ok" }; }
    catch { checks[name] = { status: "failed", issue }; }
  };
  await Promise.all([
    check("database", !!env.DATABASE_URL, async () => { snapshot = await deps.snapshot(env.DATABASE_URL!); }, "application_database_or_schema_unavailable"),
    check("rpc", !!env.SOLANA_RPC_URL, async () => {
      const { endpoint } = serviceConnection({ ...env, DATABASE_URL: env.DATABASE_URL || "postgresql://unused@localhost/unused" });
      await deps.rpc(endpoint);
    }, "dedicated_mainnet_rpc_required"),
    check("quotes", !!env.JUPITER_API_KEY?.trim(), async () => { await deps.quote(env.JUPITER_API_KEY!); }, "jupiter_quote_access_required"),
    check("signer", !!env.COPY_SIGNER_ORIGIN && !!env.COPY_SIGNER_TOKEN, async () => {
      const origin = new URL(env.COPY_SIGNER_ORIGIN!);
      if (origin.protocol !== "https:" || origin.origin !== env.COPY_SIGNER_ORIGIN || !/^[a-f0-9]{64}$/.test(env.COPY_SIGNER_TOKEN!)) throw Error();
      capabilities = await deps.signer(origin.origin, env.COPY_SIGNER_TOKEN!);
    }, "authenticated_signer_connection_required"),
  ]);
  // Snapshot variables are assigned by the awaited probes above.
  const state = snapshot as OperationsSnapshot | null, signer = capabilities as SignerCapabilities | null;
  const issues = Object.values(checks).flatMap(result => result.issue ? [result.issue] : []);
  if (state) {
    issues.push(...operationsIssues(state, mode === "pilot").filter(issue => issue !== "execution_control_enabled_without_installed_signer"));
    if (state.executionEnabled !== (mode === "pilot")) issues.push(mode === "pilot" ? "execution_control_is_off" : "execution_control_must_remain_off");
  }
  if (signer) {
    if (!signer.ready) issues.push("signer_database_isolation_not_ready");
    if (mode === "prepare" && (signer.executionEnabled || signer.nativeExecutionEnabled)) issues.push("signer_must_remain_disabled_during_preparation");
    if (mode === "pilot" && (signer.scope !== "pilot" || !signer.executionEnabled)) issues.push("wallet_restricted_pilot_not_enabled");
    if (mode === "pilot" && env.COPY_NATIVE_EXECUTION_ENABLED === "true" && !signer.nativeExecutionEnabled) issues.push("native_signing_not_enabled");
  }
  return {
    checkedAt: new Date().toISOString(), mode, readOnly: true,
    infrastructureReady: issues.length === 0, automaticTradingReady: false,
    checks, signer, snapshot: state, issues: [...new Set(issues)],
    stillRequires: ["Owner-approved trading plan and limits.", "Explicit funded-test approval.", "Supervised observer and executor with verified health.", "A confirmed buy, sell, stop and recovery test before public release."],
  };
}
