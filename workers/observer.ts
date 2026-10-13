import { createServer } from "node:http";
import {
  serviceConfig,
  observerDependencies,
  runObserver,
  healthHandler,
} from "../server/copy-service.js";
import type { ServiceHealth } from "../server/copy-service.js";
async function main() {
  const config = serviceConfig(process.env),
    controller = new AbortController();
  const health: ServiceHealth = {
    phase: "starting",
    lastCompletedAt: null,
    outcome: null,
    iterations: 0,
  };
  const server = createServer(healthHandler(health));
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Node's default bind supports IPv6 private-network health checks and IPv4.
    server.listen(config.port, resolve);
  });
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (controller.signal.aborted) return;
    health.phase = "stopping";
    controller.abort();
    shutdownTimer = setTimeout(() => process.exit(1), 55000);
    shutdownTimer.unref();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runObserver(
      observerDependencies(config),
      health,
      controller.signal,
      (s) =>
        console.log(
          JSON.stringify({
            event: "observer_state",
            phase: s.phase,
            outcome: s.outcome,
            execution: false,
          }),
        ),
    );
  } finally {
    controller.abort();
    if (shutdownTimer) clearTimeout(shutdownTimer);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
main().catch(() => {
  console.error(
    JSON.stringify({
      event: "observer_stopped",
      reason:
        "Configuration, provider or storage unavailable. Check deployment secrets, schema and lease health.",
      execution: false,
    }),
  );
  process.exitCode = 1;
});
