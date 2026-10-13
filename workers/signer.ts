import {directLimitBuyPolicy} from '../server/direct-limit-buy-policy.js';
import {cashDynamicStreams} from '../server/cash-dynamic-streams.js';
import {cashSourceMonitor} from '../server/cash-source-monitor.js';
import {cashStatusStream} from '../server/cash-status-stream.js';
import {cashStatusProof} from '../server/cash-status-proof.js';
import {cashStreamMonitor} from '../server/cash-stream-monitor.js';
import {cashEvmRpc} from '../server/cash-evm-rpc.js';
import {CASH_NETWORKS,type CashNetwork} from '../src/cash-route.js';
import {configuredHostedCashCopy,cashCopyHostConfig} from '../server/cash-copy-host-config.js';
import {startHostedLedgerBackup} from '../server/hosted-ledger-backup.js';
import {configuredDirectExitPilot} from '../server/direct-exit-pilot.js';
import {configuredNativePilot} from '../server/native-pilot-policy.js';
import { exitQueueHealth } from '../server/direct-exit-scheduler.js';
import { signerExecutionScope } from "../server/signer-execution-scope.js";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { privyCopyService } from "../server/privy-copy-service.js";
import { isolatedSignerApi } from "../server/isolated-signer-transport.js";
import { executorRpc } from "../server/copy-executor-rpc.js";
import { auditSignerDatabases } from "../server/signer-database-audit.js";
import { signerReadiness } from "../server/signer-readiness.js";
import { blockRecoveryRpc } from "../server/copy-block-recovery.js";
import { copyReadRpc } from "../server/copy-rpc.js";
import { cashCopySolanaRpc } from "../server/cash-copy-solana-rpc.js";
import { signerLoopHealth } from '../server/signer-loop-health.js';

// Dedicated process/database/credentials. Never bundle this into a Vercel API.
async function run() {
  const env = process.env;
  const executionScope = signerExecutionScope(env);
  const exitPilot = configuredDirectExitPilot(env,executionScope.mode);
  const nativePilot = exitPilot ? undefined : configuredNativePilot(env,executionScope.mode);
  if (env.SIGNER_SERVICE_ENABLED !== "true" || env.SIGNER_TLS_TERMINATED !== "true" || env.VERCEL || env.VERCEL_ENV) throw Error();
  const required = (name: string) => { const v = env[name]; if (!v) throw Error(); return v; };
  const origin = required("SIGNER_SERVICE_ORIGIN"), site = required("SIGNER_WEB_ORIGIN"), rpcUrl = required("SOLANA_RPC_URL");
  if (new URL(origin).origin !== origin || !origin.startsWith("https://") || origin === site || new URL(rpcUrl).protocol !== "https:") throw Error();
  if (new URL(site).origin !== site || !site.startsWith("https://")) throw Error();
  const port = Number(env.PORT ?? 8788); if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw Error();
  const applicationReadUrl = required("SIGNER_APPLICATION_READ_URL"), privateBudgetUrl = required("SIGNER_DATABASE_URL");
  const trustedAdminRoles = required("SIGNER_DATABASE_ADMIN_ROLES").split(",").map(r => r.trim());
  const directExits=env.DIRECT_EXIT_SERVICE_ENABLED==='true',limitBuyPolicy=directLimitBuyPolicy(env);
  if(env.DIRECT_EXIT_EXECUTION_ENABLED==='true'&&(!directExits||env.SIGNER_EXECUTION_ENABLED!=='true'||executionScope.mode==='disabled'))throw Error();
  const cashConfiguration=cashCopyHostConfig(env);
  const readiness = signerReadiness(() => auditSignerDatabases({ applicationReadUrl, privateBudgetUrl, trustedAdminRoles, directExits, cashCopies:!!cashConfiguration }));
  const recoveryHealth=signerLoopHealth(45000),exitHealth=signerLoopHealth(60000),exitQueue=exitQueueHealth();
  await readiness.check();
  const service = privyCopyService({ nativePilot, appId: required("PRIVY_APP_ID"), appSecret: required("PRIVY_APP_SECRET"), authorizationPrivateKey: required("PRIVY_AUTHORIZATION_PRIVATE_KEY"),
    origin: site, policy: { signerId: required("SIGNER_ID"), policyId: required("SIGNER_POLICY_ID"), policyDigest: required("SIGNER_POLICY_DIGEST"), publicKey: required("SIGNER_PUBLIC_KEY") },
    applicationReadUrl, privateBudgetUrl,
    ...(directExits?{directExits:{pilot:exitPilot,buyEnabled:limitBuyPolicy.allows,apiKey:required('JUPITER_API_KEY'),enabled:()=>env.DIRECT_EXIT_EXECUTION_ENABLED==='true'&&env.SIGNER_EXECUTION_ENABLED==='true'&&readiness.ready(),allows:executionScope.allows}}:{}),
    expiryRpc: signal => (method,params) => copyReadRpc(env.SOLANA_ARCHIVE_RPC_URL || rpcUrl,signal)(method,params),
    blockRpc: signal => blockRecoveryRpc(env.SOLANA_ARCHIVE_RPC_URL || rpcUrl,signal),
    rpc: (method, params) => {
      if (method === "sendTransaction") throw Error("Signer cannot broadcast.");
      return method === "getTransaction" ? copyReadRpc(rpcUrl)(method, params) : executorRpc(rpcUrl, AbortSignal.timeout(5000))(method, params);
    },
  });
  const recoveryController = new AbortController();
  let cashMonitorReady:((leader:string,networks:CashNetwork[])=>boolean)|undefined;
  const cash=configuredHostedCashCopy(env,readiness.ready,cashCopySolanaRpc(rpcUrl),recoveryController.signal,(leader,networks)=>cashMonitorReady?.(leader,networks)===true);
  const cashHealth=signerLoopHealth(120000);
  // Read-only shadow streams run independently of trading permissions. Missing
  // endpoints are explicit in operations status, not mistaken for fast copying.
  const sourceWallets=cashConfiguration?.leaders.map(l=>l.sourceWallet)||[];
  const sourceEndpoint=env.CASH_SOLANA_STREAM_RPC_URL;
  const cashSources=env.CASH_SOLANA_WS_URL&&sourceEndpoint&&sourceWallets.length?cashSourceMonitor({endpoint:env.CASH_SOLANA_WS_URL,wallets:sourceWallets,rpc:signal=>copyReadRpc(sourceEndpoint,signal)}):null;
  cashSources?.start();
  const cashStatuses=cashStatusStream();
  cashStatuses.maintain();
  const cashStatusInterval=setInterval(()=>cashStatuses.maintain(),1000);cashStatusInterval.unref();
  await cash?.restoreLeaders();
  const cashStreams=cashDynamicStreams({networks:(Object.keys(CASH_NETWORKS) as CashNetwork[]).filter(n=>!!env[`CASH_${n.toUpperCase()}_WS_URL`]),create:(network,leaders)=>{
    const mode=env[`CASH_${network.toUpperCase()}_WS_MODE`]||(network==='base'?'pendingLogs':'logs');
    if(mode!=='logs'&&mode!=='pendingLogs')throw Error('Invalid cash stream mode.');
    return cashStreamMonitor({
     targets:[{network,endpoint:env[`CASH_${network.toUpperCase()}_WS_URL`]!,leaders,mode,heartbeat:'poll'}],
     onVerified:async(event,signal)=>{if(cash&&readiness.ready()&&env.CASH_COPY_LIVE_ENABLED==='true'&&env.CASH_COPY_EXECUTION_ENABLED==='true')await cash.live.accept(event,signal);},
     onRemoved:async hint=>{if(cash)await cash.live.removed(hint.network,hint.transaction,hint.blockHash,AbortSignal.timeout(5000));},
     associate:async(balance,fill,signal)=>{
      const binding=cash?.leaders().find(l=>l.wallet===balance.leader&&l.networks.includes(balance.network));
      if(!binding||!sourceEndpoint)return{state:'awaiting-source',event:null};
      return cashStatusProof({balance,fill,sourceWallet:binding.sourceWallet},{solana:copyReadRpc(sourceEndpoint,signal),signal,status:id=>cashStatuses.read(id)});
     },rpc:(network,signal)=>cashEvmRpc(network,fetch,{endpoint:env[`CASH_${network.toUpperCase()}_STREAM_RPC_URL`],archive:false,signal,timeoutMs:2500}),
    });
  }});
  const refreshCashStreams=()=>{try{cashStreams.update(cash?.leaders()||[]);}catch{console.error(JSON.stringify({event:'cash_stream_refresh_unavailable'}));}};
  cashMonitorReady=(leader,networks)=>{refreshCashStreams();return cashStreams.ready(leader,networks);};
  refreshCashStreams();const cashStreamInterval=setInterval(refreshCashStreams,1000);cashStreamInterval.unref();
  const backups=startHostedLedgerBackup(env,'private');
  const handler = isolatedSignerApi({ executionScope, exitPilotEnabled:!!exitPilot, executorToken: required("SIGNER_EXECUTOR_TOKEN"), signingEnabled: env.SIGNER_EXECUTION_ENABLED === "true", ready: readiness.ready, nativeSigningEnabled: env.SIGNER_NATIVE_EXECUTION_ENABLED === "true",
    ...(cash?{cashEnrollment:cash.enrollment,cashDelivery:(signal,wait)=>wait?cash.waitDelivery(signal):cash.delivery(signal)}:{}),
    backupReady:()=>backups?.snapshot().status==='healthy',
    operations:()=>({signingPolicy:{signerId:env.SIGNER_ID,policyId:env.SIGNER_POLICY_ID,digest:env.SIGNER_POLICY_DIGEST,limitBuyPolicyMatches:!!env.DIRECT_LIMIT_BUY_POLICY_DIGEST&&env.DIRECT_LIMIT_BUY_POLICY_DIGEST===env.SIGNER_POLICY_DIGEST,limitBuyScope:limitBuyPolicy.mode,limitBuysEnabled:env.DIRECT_LIMIT_BUY_ENABLED==='true'},cashRuntime:cash?.runtime()||null,cashSources:cashSources?.snapshot()||{mode:'shadow',executionEnabled:false,connected:false,status:'unconfigured'},cashStatusStream:cashStatuses.snapshot(),cashStreams:cashStreams.snapshot(),cashCopies:cashHealth.snapshot(!!cash),...(backups?{backups:backups.snapshot()}:{}),version:1,checkedAt:Date.now(),databaseReady:readiness.ready(),exitQueue:exitQueue.snapshot(directExits&&env.DIRECT_EXIT_EXECUTION_ENABLED==='true'&&env.SIGNER_EXECUTION_ENABLED==='true'),recovery:recoveryHealth.snapshot(true),directExits:exitHealth.snapshot(directExits&&env.DIRECT_EXIT_EXECUTION_ENABLED==='true'&&env.SIGNER_EXECUTION_ENABLED==='true')}),
    enrollment: request => /\/v1\/enrollment\/(prepare|activate|position-review|position-apply|direct-exit-review|direct-exit-activate)$/.test(new URL(request.url).pathname) && request.method === "POST"
      ? readiness.run(signal => service.enrollment(new Request(request, { signal })), request.signal)
      : service.enrollment(request),
    ...(service.exits?{exitDelivery:(signal:AbortSignal)=>readiness.run(active=>service.exits!.delivery(active),signal)}:{}),
    sign: (request, signal) => readiness.run(active => service.sign(request, active), signal),
    recoverNative: (request, signal) => readiness.run(active => service.recoverNative(request, active), signal),
    signNative: (request, signal) => readiness.run(active => service.signNative(request, active), signal),
  });
  const controllers = new Set<AbortController>();
  const server = createServer(async (req, res) => {
    const controller = new AbortController(); controllers.add(controller);
    const abort = () => controller.abort(); req.once("aborted", abort); res.once("close", abort);
    try {
      const url = new URL(req.url || "/", origin); if (url.origin !== origin) throw Error();
      const headers = new Headers(); for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(",") : value);
      const request = new Request(url, { method: req.method, headers, signal: controller.signal,
        ...(!["GET", "HEAD"].includes(req.method || "GET") ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: "half" } : {}) } as RequestInit);
      const result = await handler(request, req.socket.remoteAddress || "unknown");
      if (!res.destroyed) { res.writeHead(result.status, Object.fromEntries(result.headers)); res.end(Buffer.from(await result.arrayBuffer())); }
    } catch { if (!res.destroyed) { res.writeHead(400, { "Cache-Control": "no-store" }); res.end(); } }
    finally { controllers.delete(controller); req.removeListener("aborted", abort); res.removeListener("close", abort); }
  });
  server.headersTimeout = 5000; server.requestTimeout = 15000; server.keepAliveTimeout = 1000; server.maxConnections = 128;
  server.setTimeout(SIGNER_SOCKET_TIMEOUT_MS, socket => socket.destroy());
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, resolve); });
  console.log(JSON.stringify({ event: "isolated_signer_ready", execution: env.SIGNER_EXECUTION_ENABLED === "true" }));
  const observeCash=async()=>{
    if(!cash||!readiness.ready()||recoveryController.signal.aborted||!cashHealth.begin())return;
    try{await cash.restoreLeaders();cashHealth.complete(await cash.tick(AbortSignal.any([recoveryController.signal,AbortSignal.timeout(45000)])));}
    catch{cashHealth.fail();console.error(JSON.stringify({event:'cash_copy_observer_unavailable'}));}
  };
  const cashInterval=setInterval(()=>{void observeCash();},5000);cashInterval.unref();void observeCash();
  const recover = async () => {
    if (recoveryController.signal.aborted || !readiness.ready() || !recoveryHealth.begin()) return;
    try {
      const signal = AbortSignal.any([recoveryController.signal,AbortSignal.timeout(12000)]);
      const result = await service.recover(signal);
      recoveryHealth.complete(result);
      if (result.checked || result.refused) console.log(JSON.stringify({event:"isolated_inventory_recovery",...result}));
    } catch { recoveryHealth.fail();console.error(JSON.stringify({event:"isolated_inventory_recovery_unavailable"})); }
  };
  const observeExits=async()=>{
    if(!service.exits||!readiness.ready()||recoveryController.signal.aborted||!exitHealth.begin())return;
    try{const signal=AbortSignal.any([recoveryController.signal,AbortSignal.timeout(25000)]);const r=await service.exits.observe(signal);exitHealth.complete(r);if(r.refused)console.error(JSON.stringify({event:'direct_exit_check_refused',count:r.refused}));}
    catch{exitHealth.fail();console.error(JSON.stringify({event:'direct_exit_check_unavailable'}));}
  };
  let checkingQueue=false,lastQueueStatus='';
  const checkQueue=async()=>{
    if(checkingQueue||!service.exits||recoveryController.signal.aborted)return;
    checkingQueue=true;
    try{exitQueue.complete(await service.exits.observationQueue());}catch{exitQueue.fail();}
    finally{checkingQueue=false;}
    const report=exitQueue.snapshot(directExits&&env.DIRECT_EXIT_EXECUTION_ENABLED==='true'&&env.SIGNER_EXECUTION_ENABLED==='true');
    if(report.status!==lastQueueStatus){lastQueueStatus=report.status;console.log(JSON.stringify({event:'direct_exit_queue',...report}));}
  };
  const queueInterval=setInterval(()=>{void checkQueue();},15000);queueInterval.unref();void checkQueue();
  const exitInterval=setInterval(()=>{void observeExits();},5000);exitInterval.unref();
  let checkingExpiry=false;
  const recoverExpired=async()=>{
    if(checkingExpiry||recoveryController.signal.aborted||!readiness.ready())return;
    checkingExpiry=true;
    try{const result=await service.recoverExpired(AbortSignal.any([recoveryController.signal,AbortSignal.timeout(120000)]));
      if(result.outcome!=='idle')console.log(JSON.stringify({event:'native_signed_expiry_recovery',...result}));
    }catch{console.error(JSON.stringify({event:'native_signed_expiry_unavailable'}));}
    finally{checkingExpiry=false;}
  };
  const expiryInterval=setInterval(()=>{void recoverExpired();},60000);expiryInterval.unref();void recoverExpired();
  const recoveryInterval = setInterval(()=>{ void recover(); },15000); recoveryInterval.unref();
  void recover();
  const interval = setInterval(() => { void readiness.check().catch(() => {
    console.error(JSON.stringify({ event: "isolated_signer_not_ready", reason: "Database isolation checks failed. Signing and new grants are withheld." }));
  }); }, 15000);
  interval.unref();
  const stop = () => { clearInterval(cashStreamInterval); clearInterval(cashStatusInterval); cashSources?.close(); cashStatuses.stop(); cashStreams.close(); clearInterval(cashInterval); clearInterval(expiryInterval); backups?.stop(); clearInterval(queueInterval); clearInterval(exitInterval); clearInterval(recoveryInterval); recoveryController.abort(); clearInterval(interval); readiness.stop(); for (const c of controllers) c.abort(); server.closeAllConnections(); server.close(); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
run().catch(() => { console.error(JSON.stringify({ event: "isolated_signer_stopped", reason: "Private host configuration or service initialization failed." })); process.exitCode = 1; });
import {SIGNER_SOCKET_TIMEOUT_MS} from '../server/native-signing-deadline.js';
