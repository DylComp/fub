import {configuredCashLimitRelay} from '../server/cash-limit-relay.js';
import {exitRelayEnabled,relayDirectExit} from '../server/direct-exit-relay.js';
import {configuredCashCopyRelay} from '../server/cash-copy-relay.js';
import {executorRpc} from '../server/copy-executor-rpc.js';
import { runExecutorHost } from "../server/copy-executor-host.js";
import { remoteCopySigner, remoteNativeSigner, remoteNativeRecovery, remoteExitDelivery } from "../server/isolated-signer-transport.js";

// Recovery remains the default. Execute mode requires the separately configured
// isolated transport; provider credentials never enter this executor process.
async function start() {
  const remote = process.env.COPY_SIGNER_TRANSPORT === "isolated" ? remoteCopySigner({ origin: process.env.COPY_SIGNER_ORIGIN || "", token: process.env.COPY_SIGNER_TOKEN || "" }) : undefined;
  if (process.env.COPY_SIGNER_TRANSPORT && process.env.COPY_SIGNER_TRANSPORT !== "isolated") throw Error();
  const native = remote && process.env.COPY_NATIVE_EXECUTION_ENABLED === "true" ? remoteNativeSigner({origin:process.env.COPY_SIGNER_ORIGIN || "", token:process.env.COPY_SIGNER_TOKEN || ""}) : undefined;
  const recovery = remote ? remoteNativeRecovery({origin:process.env.COPY_SIGNER_ORIGIN || "",token:process.env.COPY_SIGNER_TOKEN || ""}) : undefined;
  const exits=exitRelayEnabled(process.env,!!remote);
  const next=exits?remoteExitDelivery({origin:process.env.COPY_SIGNER_ORIGIN||'',token:process.env.COPY_SIGNER_TOKEN||''}):undefined;
  const relay=next?(signal:AbortSignal)=>relayDirectExit({enabled:()=>process.env.DIRECT_EXIT_EXECUTION_ENABLED==='true',next,rpc:s=>executorRpc(process.env.SOLANA_RPC_URL||'',s)},signal):undefined;
  await runExecutorHost(process.env, remote, native, recovery,relay,configuredCashCopyRelay(process.env),configuredCashLimitRelay(process.env));
}
start().catch(() => {
  console.error(
    JSON.stringify({
      event: "executor_stopped",
      reason:
        "Executor configuration, signing adapter, provider or storage unavailable. Verify host settings and service readiness.",
    }),
  );
  process.exitCode = 1;
});
