import { createServer } from "node:http";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { launchPayoutStore } from "./launch-payout-store.js";
import { launchPayoutChain } from "./launch-payout-chain.js";
import { runLaunchPayout } from "./launch-payout-worker.js";
import { rawLamports } from "./launch-payout-model.js";
import { blockRecoveryRpc } from "./copy-block-recovery.js";
import { payoutPilotPolicy } from "./launch-payout-pilot.js";

export function payoutHostConfig(env: NodeJS.ProcessEnv, runtime: "host" | "cron" = "host") {
  if (!env.DATABASE_URL || (runtime === "host"
    ? env.LAUNCH_PAYOUT_ENABLED !== "true" || !!env.VERCEL_ENV
    : env.LAUNCH_PAYOUT_CRON_ENABLED !== "true" || env.VERCEL_ENV !== "production")) throw Error("Payout runtime configuration required.");
  const mode = (runtime === "cron" ? env.LAUNCH_PAYOUT_CRON_MODE : env.LAUNCH_PAYOUT_MODE) || "recover";
  if (mode !== "recover" && mode !== "execute") throw Error("Unsupported payout mode.");
  const endpoint = new URL(env.LAUNCH_PAYOUT_RPC_URL || env.SOLANA_RPC_URL || "");
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash || endpoint.hostname === "api.mainnet-beta.solana.com") throw Error("Dedicated HTTPS RPC required.");
  let fallbackEndpoint: string | undefined;
  if (env.SOLANA_FALLBACK_RPC_URL) {
    const fallback = new URL(env.SOLANA_FALLBACK_RPC_URL);
    if (fallback.protocol !== "https:" || fallback.username || fallback.password || fallback.hash || fallback.toString() === endpoint.toString()) throw Error("Independent HTTPS fallback RPC required.");
    fallbackEndpoint = fallback.toString();
  }
  const payer = new PublicKey(env.LAUNCH_PAYOUT_PAYER || "");
  if (!PublicKey.isOnCurve(payer.toBytes()) || payer.toBase58() !== env.LAUNCH_PAYOUT_PAYER) throw Error("Payout fee payer required.");
  const pilot = runtime === "cron" ? payoutPilotPolicy(env.LAUNCH_PAYOUT_CRON_PILOT_POLICY, payer.toBase58()) : undefined;
  const minimumLamports = env.LAUNCH_PAYOUT_MIN_LAMPORTS || "3000000";
  const maxFeeLamports = env.LAUNCH_PAYOUT_MAX_FEE_LAMPORTS || "10000";
  const dailyCapLamports = pilot ? "10000" : env.LAUNCH_PAYOUT_DAILY_CAP_LAMPORTS || "10000000";
  if (rawLamports(maxFeeLamports) < 5000n || rawLamports(maxFeeLamports) > 100000n ||
      rawLamports(minimumLamports) < rawLamports(maxFeeLamports) * 10n ||
      rawLamports(dailyCapLamports) < rawLamports(maxFeeLamports) || rawLamports(dailyCapLamports) > 1000000000n) throw Error("Invalid payout costs or daily cap.");
  const port = Number(env.PORT || "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error("Invalid health port.");
  if (pilot && rawLamports(maxFeeLamports) > 10000n) throw Error("Pilot payout fee exceeds its cap.");
  if (runtime === "cron" && mode === "execute" && env.LAUNCH_PAYOUT_CRON_OPERATIONS_VERIFIED !== "true" && !pilot) throw Error("Verified scheduled payout operation required.");
  if ([env.LAUNCH_BURN_WALLET, env.FUB_DEVELOPMENT_WALLET].includes(payer.toBase58())) throw Error("Payout fee payer must be separate from revenue wallets.");
  if (runtime === "host" && mode === "execute" && (!env.LAUNCH_PAYOUT_KEY_FILE || !isAbsolute(env.LAUNCH_PAYOUT_KEY_FILE))) throw Error("Dedicated payout signer file required.");
  const allowAmm = env.LAUNCH_PAYOUT_AMM_VERIFIED === "true";
  return { mode, allowAmm, endpoint: endpoint.toString(), fallbackEndpoint, databaseUrl: env.DATABASE_URL, payer: payer.toBase58(), keyFile: env.LAUNCH_PAYOUT_KEY_FILE, minimumLamports, maxFeeLamports, dailyCapLamports, port, pilot };
}
export async function payoutFeeSigner(path: string, expected: string) {
  // This is a dedicated network-fee wallet, NEVER a recipient, user's Fomo
  // key, or buyback treasury. The host has no swap or token-burn capability.
  // Validate and read the same descriptor. Do not follow a symlink or permit a
  // path replacement between the permission check and the private-key read.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let value: unknown;
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 1024 || info.uid !== process.getuid?.()) throw Error("Payout key file must be private and owned by this process user.");
    value = JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
  if (!Array.isArray(value) || value.length !== 64 || value.some(v => !Number.isInteger(v) || v < 0 || v > 255)) throw Error("Invalid payout key file.");
  const keypair = Keypair.fromSecretKey(Uint8Array.from(value));
  if (keypair.publicKey.toBase58() !== expected) throw Error("Payout signer address mismatch.");
  return async (unsigned: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    const tx = VersionedTransaction.deserialize(Buffer.from(unsigned, "base64"));
    tx.sign([keypair]);
    return Buffer.from(tx.serialize()).toString("base64");
  };
}
export function payoutConnection(endpoint: string, signal: AbortSignal, fallbackEndpoint?: string) {
  return new Connection(endpoint, {
    commitment: "finalized", disableRetryOnRateLimit: true,
    fetch: async (_input, init) => {
      const call = JSON.parse(String(init?.body || "{}")) as { method?: string };
      if (!["getGenesisHash", "getAccountInfo", "getMultipleAccounts", "getMinimumBalanceForRentExemption", "getLatestBlockhash", "getFeeForMessage", "simulateTransaction", "getTransaction", "getSignatureStatuses", "getBlockHeight", "sendTransaction"].includes(call.method || "")) throw Error("Unsupported payout RPC request.");
      for (const url of [endpoint, ...(fallbackEndpoint ? [fallbackEndpoint] : [])]) {
        signal.throwIfAborted();
        try {
          const response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
          if (!response.ok || Number(response.headers.get("content-length")) > 2000000 || !response.body) throw Error("Payout provider unavailable.");
          const reader = response.body.getReader(), chunks: Uint8Array[] = [];
          let length = 0;
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              length += value.length;
              if (length > 2000000) throw Error("Payout response exceeded limit.");
              chunks.push(value);
            }
          } finally { await reader.cancel(); }
          const bytes = Buffer.concat(chunks), body = JSON.parse(bytes.toString("utf8"));
          if (body.error || body.jsonrpc !== "2.0" || !("result" in body)) throw Error("Payout RPC error.");
          return new Response(bytes, { status: response.status, headers: { "content-type": "application/json" } });
        } catch {
          // A send retry contains identical signed bytes and therefore the same
          // signature. A lost response never authorizes a different transaction.
          signal.throwIfAborted();
        }
      }
      throw Error("Payout providers unavailable.");
    },
  });
}
export async function runPayoutHost(env: NodeJS.ProcessEnv) {
  const config = payoutHostConfig(env), stop = new AbortController();
  const signer = config.mode === "execute" ? await payoutFeeSigner(config.keyFile!, config.payer) : async () => { throw Error("Recovery host cannot sign."); };
  const store = launchPayoutStore(config.databaseUrl);
  for (const endpoint of [config.endpoint, ...(config.fallbackEndpoint ? [config.fallbackEndpoint] : [])]) {
    if (await payoutConnection(endpoint, stop.signal).getGenesisHash() !== "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d") throw Error("Mainnet required for each provider.");
  }
  await store.health();
  let lastProgress = 0, lastHealthy = 0, degraded = false;
  const server = createServer((request, response) => {
    if (request.url !== "/healthz") { response.writeHead(404).end(); return; }
    const healthy = !stop.signal.aborted && Date.now() - lastProgress < 45000 && !degraded;
    response.writeHead(healthy ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ healthy, mode: config.mode, lastProgress, lastHealthy }));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.port, "0.0.0.0", resolve); });
  const shutdown = () => { stop.abort(); server.close(); };
  process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
  try {
    while (!stop.signal.aborted) {
      try {
        // Up to four due coins per pass. Competing hosts share per-mint leases;
        // there is no singleton lock blocking a healthy standby's other coins.
        let tickDegraded = false;
        for (let i = 0; i < 4 && !stop.signal.aborted; i++) {
          const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(40000)]);
          const outcome = await runLaunchPayout({ store, chain: launchPayoutChain(payoutConnection(config.endpoint, signal, config.fallbackEndpoint), config, blockRecoveryRpc(config.fallbackEndpoint || config.endpoint, signal)),
            payer: config.payer, dailyCapLamports: config.dailyCapLamports, sign: signer, signal, execute: config.mode === "execute" });
          lastProgress = Date.now();
          tickDegraded ||= ["retry", "expired_unresolved", "budget_exhausted"].includes(outcome.outcome);
          console.log(JSON.stringify({ event: "launch_payout_tick", outcome: outcome.outcome }));
          if (outcome.outcome === "idle") break;
        }
        const health = await store.health();
        degraded = tickDegraded || health.overdue > 0 || health.blocked > 0 || health.unresolved > 0;
        if (!degraded) lastHealthy = lastProgress;
      } catch {
        degraded = true;
        console.error(JSON.stringify({ event: "launch_payout_unavailable" }));
      }
      if (!stop.signal.aborted) await delay(5000, undefined, { signal: stop.signal }).catch(() => {});
    }
  } finally {
    server.close(); process.removeListener("SIGTERM", shutdown); process.removeListener("SIGINT", shutdown);
  }
}
