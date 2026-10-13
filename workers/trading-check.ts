import { tradingPreflight } from "../server/trading-preflight.js";
const args = process.argv.slice(2);
if (args.length > 1 || (args.length && args[0] !== "--pilot")) {
  console.error("Usage: node .worker-dist/workers/trading-check.js [--pilot]"); process.exitCode = 2;
} else {
  try {
    const report = await tradingPreflight(process.env, args[0] === "--pilot" ? "pilot" : "prepare");
    console.log(JSON.stringify(report, null, 2)); process.exitCode = report.infrastructureReady ? 0 : 1;
  } catch { console.error('{"infrastructureReady":false,"error":"trading_preflight_failed"}'); process.exitCode = 2; }
}
