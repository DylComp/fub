import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { payIssuerConfig, payStripeClient, payIssuerReader } from "../server/pay-issuer.js";
import { payIssuerStore } from "../server/pay-issuer-store.js";
import { reconcilePayBatch } from "../server/pay-issuer-worker.js";
const stop = new AbortController();
for (const name of ["SIGINT", "SIGTERM"]) process.once(name, () => stop.abort());
try {
  if (process.env.PAY_ISSUER_WORKER_ENABLED !== "true" || !process.env.DATABASE_URL || !process.env.PAY_STRIPE_READ_KEY) throw Error();
  const scope = payIssuerConfig(), store = payIssuerStore(process.env.DATABASE_URL, scope), reader = payIssuerReader(payStripeClient(process.env.PAY_STRIPE_READ_KEY, scope), scope);
  await reader.verifyAccount();
  let lastSuccess = 0, healthy = false;
  const port = Number(process.env.PORT || "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error();
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store");
    if (req.url !== "/healthz" || req.method !== "GET") { res.statusCode = 404; res.end(); return; }
    const okay = healthy && Date.now() - lastSuccess < 180000;
    res.statusCode = okay ? 200 : 503; res.end(JSON.stringify({ ready: okay }));
  });
  server.listen(port, "0.0.0.0");
  stop.signal.addEventListener("abort", () => server.close(), { once: true });
  while (!stop.signal.aborted) {
    try {
      const result = await reconcilePayBatch(store, reader, 5, stop.signal), health = await store.health();
      healthy = !health.overdue && !health.failed && !health.discovery_failed && !result.retry && !result.unbound;
      lastSuccess = Date.now(); console.log(JSON.stringify({ event: "pay_issuer_cycle", ...result, healthy }));
    } catch { healthy = false; console.error("Card reconciliation unavailable; retrying."); }
    await delay(60000, undefined, { signal: stop.signal }).catch(() => {});
  }
} catch { console.error("Card reconciliation requires an enabled worker, matching issuer credentials and durable storage."); process.exitCode = 1; }
