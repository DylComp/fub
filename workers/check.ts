import { checkOperations } from "../server/copy-operations.js";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length && args[0] !== "--running")) {
  console.error("Usage: node .worker-dist/workers/check.js [--running]");
  process.exitCode = 2;
} else {
  try {
    const report = await checkOperations(process.env, args[0] === "--running");
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ready ? 0 : 1;
  } catch {
    console.error('{"ready":false,"error":"operations_check_failed"}');
    process.exitCode = 2;
  }
}
