// Vite can accept imports that native Node ESM rejects. Check every emitted API
// entry using Node before deployment, without invoking handlers or making calls.
import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = await mkdtemp(join(tmpdir(), "fomo-server-runtime-"));
try {
  execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(root, "tsconfig.json"),
    "--noEmit", "false", "--allowImportingTsExtensions", "false", "--incremental", "false", "--outDir", output], { cwd: root, stdio: "pipe" });
  await writeFile(join(output, "package.json"), JSON.stringify({ type: "module" }));
  await symlink(join(root, "node_modules"), join(output, "node_modules"), "dir");
  await symlink(join(root, "vendor"), join(output, "vendor"), "dir");
  const entries = (await readdir(join(output, "api"))).filter(file => file.endsWith(".js"));
  const cashUrl = pathToFileURL(join(output, "server", "cash-route-handler.js")).href;
  execFileSync(process.execPath, ["--no-experimental-require-module", "--input-type=module", "-e", `const cash = await import(${JSON.stringify(cashUrl)}); if (typeof cash.handleCashRoute !== "function") throw Error("Missing cash quote handler");`], { cwd: root, stdio: "pipe", timeout: 10000 });
  for (const name of ['cash-wallet-api', 'cash-purchase-service', 'cash-receipt', 'cash-return-simulation', 'cash-return-service', 'cash-trade-api']) {
    const url = pathToFileURL(join(output, 'server', name + '.js')).href;
    execFileSync(process.execPath, ['--no-experimental-require-module', '--input-type=module', '-e', `await import(${JSON.stringify(url)})`], { cwd: root, stdio: 'pipe', timeout: 10000 });
  }
  for (const entry of entries) {
    const url = pathToFileURL(join(output, "api", entry)).href;
    execFileSync(process.execPath, ["--input-type=module", "-e", `const entry = await import(${JSON.stringify(url)}); if (typeof entry.default !== "function") throw Error("Missing API handler");`], { cwd: root, stdio: "pipe", timeout: 10000 });
  }
  const workerUrl = pathToFileURL(join(output, "server", "copy-dispatch-worker.js")).href;
  execFileSync(process.execPath, ["--input-type=module", "-e", `const worker = await import(${JSON.stringify(workerUrl)}); if (typeof worker.runCopyDispatch !== "function" || typeof worker.runCopyDispatchLoop !== "function") throw Error("Missing execution worker");`], { cwd: root, stdio: "pipe", timeout: 10000 });
  const serviceUrl = pathToFileURL(join(output, "server", "copy-service.js")).href;
  execFileSync(process.execPath, ["--input-type=module", "-e", `const service = await import(${JSON.stringify(serviceUrl)}); if (typeof service.runObserver !== "function") throw Error("Missing observer service");`], { cwd: root, stdio: "pipe", timeout: 10000 });
  const executorUrl = pathToFileURL(join(output, "server", "copy-executor-host.js")).href;
  execFileSync(process.execPath, ["--input-type=module", "-e", `const service = await import(${JSON.stringify(executorUrl)}); if (typeof service.runExecutorHost !== "function") throw Error("Missing executor host");`], { cwd: root, stdio: "pipe", timeout: 10000 });
  const token22Url = pathToFileURL(join(output, "server", "token2022-recovery.js")).href;
  execFileSync(process.execPath, ["--input-type=module", "-e", `const recovery = await import(${JSON.stringify(token22Url)}); if (typeof recovery.bindRaydium22Signed !== "function" || typeof recovery.recoverRaydium22Execution !== "function") throw Error("Missing Token-2022 recovery boundary");`], { cwd: root, stdio: "pipe", timeout: 10000 });
  const nativeSendUrl = pathToFileURL(join(output, "server", "token2022-submission.js")).href;
  execFileSync(process.execPath, ["--input-type=module", "-e", `const send = await import(${JSON.stringify(nativeSendUrl)}); if (typeof send.token22Submission !== "function") throw Error("Missing native submission adapter");`], { cwd: root, stdio: "pipe", timeout: 10000 });
  const nativeDispatchUrl = pathToFileURL(join(output, "server", "token2022-dispatch.js")).href;
  execFileSync(process.execPath, ["--input-type=module", "-e", `const worker = await import(${JSON.stringify(nativeDispatchUrl)}); if (typeof worker.runToken22Dispatch !== "function") throw Error("Missing native dispatch adapter");`], { cwd: root, stdio: "pipe", timeout: 10000 });
  const nativePrepareUrl = pathToFileURL(join(output, "server", "token2022-prepare-worker.js")).href;
  execFileSync(process.execPath, ["--input-type=module", "-e", `const worker = await import(${JSON.stringify(nativePrepareUrl)}); if (typeof worker.runNativePreparation !== "function") throw Error("Missing native preparation worker");`], { cwd: root, stdio: "pipe", timeout: 10000 });
  console.log(`PASS: ${entries.length} API entries, dispatch worker, observer, executor host and Token-2022 recovery load in native Node ESM. No handlers invoked.`);
} catch (error) {
  if (error.stderr) process.stderr.write(error.stderr);
  if (error.stdout) process.stderr.write(error.stdout);
  throw error;
} finally {
  await rm(output, { recursive: true, force: true });
}
