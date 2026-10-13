import {giftCheckoutRecovery} from './gift-checkout-recovery.js';
import {runCashDelivery} from './cash-delivery-loop.js';
import {runCashRecovery} from './cash-recovery-loop.js';
import {startHostedLedgerBackup} from './hosted-ledger-backup.js';
import {exitRelayEnabled,runDirectExitRelay} from './direct-exit-relay.js';
import {initialLaunchRecoveryHealth,launchRecoveryTick,runLaunchRecovery,withLaunchRecoveryHealth} from './launch-recovery-worker.js';
import type {NativeSignatureRecovery} from "./native-signature-recovery.js";
import { createServer } from "node:http";
import {
  executorConfig,
  executorDependencies,
  executorHealthHandler,
  runExecutor,
} from "./copy-executor.js";
import type { ExecutorHealth } from "./copy-executor.js";
import type { CopySigningAdapter } from "./copy-dispatch-worker.js";
import type { Token22Signer } from "./token2022-signing.js";

// The eventual provider-specific entry must supply its reviewed adapter here.
// No environment variable can install arbitrary signer code or a private key.
export async function runExecutorHost(
  env: Record<string, string | undefined>,
  signer?: CopySigningAdapter,
  nativeSigner?: Token22Signer,
  nativeRecovery?: NativeSignatureRecovery,
  directRelay?:(signal:AbortSignal)=>Promise<unknown>,
  cashCopyRelay?:(signal:AbortSignal)=>Promise<unknown>,
) {
  const config = executorConfig(env),
    deps = executorDependencies(config, signer, nativeSigner, nativeRecovery),
    controller = new AbortController();
  if(directRelay&&!exitRelayEnabled(env,!!signer))throw Error('Direct exits require an explicitly enabled relay.');
  if(cashCopyRelay&&(env.CASH_COPY_EXECUTION_ENABLED!=='true'||env.COPY_SIGNER_TRANSPORT!=='isolated'))throw Error('Cash copying requires an explicitly enabled relay.');
  const state: ExecutorHealth = {
    mode: config.mode,
    phase: "starting",
    lastCompletedAt: null,
    outcome: null,
    iterations: 0,
  };
  if(env.LAUNCH_RECOVERY_RUN && !['true','false'].includes(env.LAUNCH_RECOVERY_RUN))throw Error('Invalid launch recovery setting.');
  const launches=env.LAUNCH_RECOVERY_RUN==='true'?initialLaunchRecoveryHealth():undefined;
  const baseHealth=executorHealthHandler(state);
  const backups=startHostedLedgerBackup(env,'application');
  const health=launches?withLaunchRecoveryHealth(baseHealth,launches):baseHealth;
  const server = createServer((req,res)=>{
    if(req.url==='/backupz'&&req.method==='GET'){
      const ready=backups?.snapshot().status==='healthy';res.writeHead(ready?200:503,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({ready}));return;
    }
    health(req,res);
  });
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
    state.phase = "stopping";
    controller.abort();
    shutdownTimer = setTimeout(() => process.exit(1), 55000);
    shutdownTimer.unref();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const tasks=[runExecutor(deps, state, controller.signal, (s) =>
      console.log(
        JSON.stringify({
          event: "executor_state",
          mode: s.mode,
          phase: s.phase,
          outcome: s.outcome,
        }),
      ),
    )];
    if(env.CASH_DURABLE_STORAGE==='true'){
      const {cashTradeRuntime}=await import('./cash-trade-api.js');
      const cash=cashTradeRuntime();
      tasks.push(runCashRecovery(async()=>{const results=await Promise.all([cash.purchases.recoverBatch(),cash.returns.recoverBatch()]);if(results.flat().some(r=>r.state==='unavailable'))throw Error('Cash recovery incomplete.');},controller.signal,healthy=>console.log(JSON.stringify({event:'cash_recovery',healthy}))));
    }
    const gifts=giftCheckoutRecovery(env);
    if(gifts)tasks.push(runCashRecovery(async()=>{const result=await gifts.tick(controller.signal);if(result.retry)throw Error('Gift recovery incomplete.');},controller.signal,healthy=>console.log(JSON.stringify({event:'gift_checkout_recovery',healthy}))));
    if(launches)tasks.push(runLaunchRecovery(launchRecoveryTick(config),launches,controller.signal,s=>console.log(JSON.stringify({event:'launch_recovery_state',phase:s.phase,checked:s.checked,failed:s.failed}))));
    if(directRelay)tasks.push(runDirectExitRelay(directRelay,controller.signal,()=>console.error(JSON.stringify({event:'direct_exit_delivery_unconfirmed'}))));
    if(cashCopyRelay)tasks.push(runCashDelivery(cashCopyRelay,controller.signal,()=>console.error(JSON.stringify({event:'cash_copy_delivery_unconfirmed'}))));
    // Either unexpected loop exit stops its sibling before the host can exit.
    const supervised=tasks.map(task=>task.finally(()=>controller.abort()));
    const results=await Promise.allSettled(supervised);
    const failure=results.find(r=>r.status==='rejected');
    if(failure?.status==='rejected')throw failure.reason;
  } finally {
    controller.abort();backups?.stop();
    if (shutdownTimer) clearTimeout(shutdownTimer);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
