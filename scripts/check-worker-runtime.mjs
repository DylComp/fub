// Verify the emitted Node graph and executable refusal paths without inheriting
// a developer's production credentials or making provider/storage requests.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const env = { PATH: process.env.PATH, NODE_ENV: "production" };
function run(args, expected, extra = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.error, undefined, "Worker subprocess must finish within ten seconds.");
  assert.equal(result.status, expected, "Unexpected worker subprocess exit status.");
  assert(!`${result.stdout}${result.stderr}`.includes("fixture-secret"), "Worker must redact credentials.");
  return result;
}
run(["--input-type=module", "-e", `
  await import('./.worker-dist/server/controlled-window-selection.js');
  for (const file of ['cash-trade-api','cash-return-service','cash-purchase-service','pump-curve-execution','pump-curve-observation','isolated-signer-transport','signer-execution-scope','trading-preflight','pay-issuer','pay-issuer-store','pay-issuer-worker','bridge-card-wallet','bridge-card-provider','copy-service','copy-executor-host','copy-operations','privy-sign-only','privy-owner','signer-enrollment','signer-enrollment-store','signer-enrollment-api','privy-copy-service','isolated-copy-signer','isolated-signing-budget','pump-launch','launch-payout-chain','launch-payout-store','launch-payout-host','launch-recovery-worker','buyback-host','buyback-chain','buyback-store']) {
    await import('./.worker-dist/server/' + file + '.js');
  }
`], 0);
// Stale operator shortcuts have no implicit run; refusal precedes env loading.

for (const worker of ["observer", "executor", "payouts", "buybacks", "pay-issuer", "signer", "launch-recovery"]) {
  run([`.worker-dist/workers/${worker}.js`], 1);
  run([`.worker-dist/workers/${worker}.js`], 1, {
    COPY_SERVICE_ENABLED: "true", COPY_EXECUTOR_ENABLED: "true",
    DATABASE_URL: "postgresql://fixture:fixture-secret@db.invalid/db",
    SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com?fixture-secret",
  });
}
// A configured execute entry still cannot start without an installed signer.
run([".worker-dist/workers/executor.js"], 1, {
  COPY_EXECUTOR_ENABLED: "true", COPY_EXECUTOR_MODE: "execute",
  COPY_EXECUTION_ENABLED: "true", JUPITER_API_KEY: "fixture-secret",
  DATABASE_URL: "postgresql://fixture:fixture-secret@db.invalid/db",
  SOLANA_RPC_URL: "https://rpc.invalid/?fixture-secret",
});
const check = run([".worker-dist/workers/check.js"], 1);
const report = JSON.parse(check.stdout);
assert.equal(report.ready, false);
assert.equal(report.automaticTradingReady, false);
assert.equal(report.snapshot, null);
run([".worker-dist/workers/check.js", "--execute"], 2);
const trading = run([".worker-dist/workers/trading-check.js"], 1);
assert.equal(JSON.parse(trading.stdout).automaticTradingReady, false);
assert.equal(JSON.parse(trading.stdout).readOnly, true);
run([".worker-dist/workers/trading-check.js", "--execute"], 2);
console.log("PASS: worker modules load; unconfigured/public-RPC/missing-signer startup is refused; diagnostics are redacted. No network work requested.");
