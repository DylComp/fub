import { buybackPilotPolicy } from "./buyback-pilot.js";
import { createServer } from "node:http";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { validateBuybackPolicy } from "./buyback-model.js";
import type { BuybackPolicy } from "./buyback-model.js";
import { buybackStore } from "./buyback-store.js";
import { buybackChain } from "./buyback-chain.js";
import { payoutConnection } from "./launch-payout-host.js";
import { runBuyback } from "./buyback-worker.js";
import { blockRecoveryRpc } from "./copy-block-recovery.js";
export function buybackHostConfig(env: NodeJS.ProcessEnv, runtime: "host" | "cron" = "host") {
  if (
    !env.DATABASE_URL ||
    (runtime === "host" ? env.BUYBACK_WORKER_ENABLED !== "true" || !!env.VERCEL_ENV
      : env.BUYBACK_CRON_ENABLED !== "true" || env.VERCEL_ENV !== "production")
  )
    throw Error("Dedicated buyback worker configuration required");
  const mode = (runtime === "cron" ? env.BUYBACK_CRON_MODE : env.BUYBACK_MODE) || "recover";
  if (!["recover", "execute"].includes(mode))
    throw Error("Invalid buyback mode");
  const pilot = runtime === "cron" ? buybackPilotPolicy(env.BUYBACK_CRON_PILOT_POLICY, env.LAUNCH_BURN_WALLET || "") : undefined;
  if (
    mode === "execute" &&
    (runtime === "cron" ? env.BUYBACK_CRON_OPERATIONS_VERIFIED !== "true" && !pilot
      : env.BUYBACK_OPERATIONS_VERIFIED !== "true" || !env.BUYBACK_KEY_FILE || !isAbsolute(env.BUYBACK_KEY_FILE))
  )
    throw Error(
      "Verified buyback operation and private treasury signer required",
    );
  const policy: BuybackPolicy = pilot?.policy || {
    treasury: env.LAUNCH_BURN_WALLET || "",
    mint: env.LAUNCH_PLATFORM_MINT || "",
    maxInput: env.BUYBACK_MAX_INPUT_LAMPORTS || "10000000",
    maxOverhead: env.BUYBACK_MAX_OVERHEAD_LAMPORTS || "9000000",
    dailyCap: env.BUYBACK_DAILY_CAP_LAMPORTS || "100000000",
    slippageBps: Number(env.BUYBACK_SLIPPAGE_BPS || "100"),
  };
  validateBuybackPolicy(policy);
  const endpoint = new URL(env.BUYBACK_RPC_URL || env.SOLANA_RPC_URL || "");
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.hostname === "api.mainnet-beta.solana.com"
  )
    throw Error("Dedicated HTTPS RPC required");
  let fallback: string | undefined;
  if (env.SOLANA_FALLBACK_RPC_URL) {
    const url = new URL(env.SOLANA_FALLBACK_RPC_URL);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      url.toString() === endpoint.toString()
    )
      throw Error("Independent HTTPS fallback required");
    fallback = url.toString();
  }
  const port = Number(env.PORT || "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error("Invalid health port");
  return {
    policy,
    pilot,
    mode,
    endpoint: endpoint.toString(),
    fallback,
    port,
    keyFile: env.BUYBACK_KEY_FILE,
    databaseUrl: env.DATABASE_URL,
  };
}
export async function buybackSigner(path: string, treasury: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let data: unknown;
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      info.size > 1024
    )
      throw Error(
        "Treasury signer file must be private and owned by this process",
      );
    data = JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
  if (
    !Array.isArray(data) ||
    data.length !== 64 ||
    data.some((v) => !Number.isInteger(v) || v < 0 || v > 255)
  )
    throw Error("Invalid treasury signer file");
  const key = Keypair.fromSecretKey(Uint8Array.from(data));
  if (key.publicKey.toBase58() !== treasury)
    throw Error("Treasury signer mismatch");
  return async (unsigned: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    const tx = VersionedTransaction.deserialize(
      Buffer.from(unsigned, "base64"),
    );
    tx.sign([key]);
    return Buffer.from(tx.serialize()).toString("base64");
  };
}
export async function runBuybackHost(env: NodeJS.ProcessEnv) {
  const config = buybackHostConfig(env),
    stop = new AbortController();
  const sign =
    config.mode === "execute"
      ? await buybackSigner(config.keyFile!, config.policy.treasury)
      : async () => {
          throw Error("Recovery cannot sign");
        };
  const store = buybackStore(config.databaseUrl, config.policy);
  await store.register();
  for (const url of [
    config.endpoint,
    ...(config.fallback ? [config.fallback] : []),
  ])
    if (
      (await payoutConnection(url, stop.signal).getGenesisHash()) !==
      "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
    )
      throw Error("Mainnet required");
  let lastProgress = Date.now(),
    degraded = true,
    lastOutcome = "starting";
  const server = createServer((req, res) => {
    if (req.url !== "/healthz") {
      res.writeHead(404).end();
      return;
    }
    const healthy =
      !stop.signal.aborted && !degraded && Date.now() - lastProgress < 120000;
    res
      .writeHead(healthy ? 200 : 503, {
        "content-type": "application/json",
        "cache-control": "no-store",
      })
      .end(
        JSON.stringify({
          healthy,
          mode: config.mode,
          lastProgress,
          lastOutcome,
        }),
      );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "0.0.0.0", resolve);
  });
  const shutdown = () => {
    stop.abort();
    server.close();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  try {
    while (!stop.signal.aborted) {
      try {
        const signal = AbortSignal.any([
            stop.signal,
            AbortSignal.timeout(90000),
          ]),
          result = await runBuyback({
            store,
            chain: buybackChain(
              payoutConnection(config.endpoint, signal, config.fallback),
              config.policy,
              blockRecoveryRpc(config.fallback || config.endpoint, signal),
            ),
            sign,
            signal,
            execute: config.mode === "execute",
          });
        lastProgress = Date.now();
        lastOutcome = result.outcome;
        const health = await store.health();
        degraded =
          health.unresolved > 0 ||
          ["retry", "expired_unresolved", "budget_exhausted"].includes(
            String(health.outcome),
          ) ||
          (config.mode === "execute" && !health.enabled);
        console.log(
          JSON.stringify({ event: "buyback_tick", outcome: lastOutcome }),
        );
      } catch {
        degraded = true;
        lastOutcome = "unavailable";
        console.error(JSON.stringify({ event: "buyback_unavailable" }));
      }
      if (!stop.signal.aborted)
        await delay(5000, undefined, { signal: stop.signal }).catch(() => {});
    }
  } finally {
    server.close();
    process.removeListener("SIGTERM", shutdown);
    process.removeListener("SIGINT", shutdown);
  }
}
