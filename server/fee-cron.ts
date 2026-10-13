import {runQuoteConversionCron} from './quote-conversion-cron.js';
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { payoutHostConfig, payoutConnection } from "./launch-payout-host.js";
import { buybackHostConfig } from "./buyback-host.js";
import { launchPayoutStore } from "./launch-payout-store.js";
import { launchPayoutChain } from "./launch-payout-chain.js";
import { runLaunchPayout } from "./launch-payout-worker.js";
import { buybackStore } from "./buyback-store.js";
import { buybackChain } from "./buyback-chain.js";
import { runBuyback } from "./buyback-worker.js";
import { blockRecoveryRpc } from "./copy-block-recovery.js";
import {launchQuoteStore} from './launch-quote-store.js';
import {launchQuoteChain} from './launch-quote-chain.js';
import {runQuoteFeePayout} from './launch-quote-worker.js';
import {quoteFeeValuation} from './launch-quote-valuation.js';
import {quoteAcceptance,quoteAcceptanceAllows} from './quote-acceptance.js';

export type FeeJob = "payouts" | "buybacks";
export type FeeCronResult = { status: string; mode?: string; quoteMode?: string; conversionMode?: string; outcomes?: string[]; healthy?: boolean };

export {feeCronSigner} from "./fee-signer.js";
import {feeCronSigner} from "./fee-signer.js";

export async function boundedPayoutBatch(
  tick: () => Promise<{ outcome: string }>, signal: AbortSignal, now = Date.now,
) {
  const start = now(), outcomes: string[] = [];
  // Stop starting work after 25s. The shared 40s RPC deadline leaves time to
  // release a lease and return inside Vercel's 60s limit. Large queues rotate.
  while (outcomes.length < 12 && now() - start < 25000 && !signal.aborted) {
    const { outcome } = await tick();
    outcomes.push(outcome);
    if (["idle", "retry", "budget_exhausted", "expired_unresolved"].includes(outcome)) break;
  }
  return outcomes;
}

const cannotSign = async () => { throw Error("Recovery cannot sign."); };
const mainnet = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
async function runBaseFeeCron(job: FeeJob, env: NodeJS.ProcessEnv): Promise<FeeCronResult> {
  // Defense in depth: calling this function outside the HTTP handler cannot
  // activate a preview deployment or inherit a dedicated host's execute flag.
  if (env.VERCEL_ENV !== "production") throw Error("Production scheduled runtime required.");
  const enabled = job === "payouts" ? env.LAUNCH_PAYOUT_CRON_ENABLED : env.BUYBACK_CRON_ENABLED;
  if (enabled !== "true") return { status: "disabled" };
  if (job === "buybacks" && !env.LAUNCH_PLATFORM_MINT && !env.BUYBACK_CRON_PILOT_POLICY) return { status: "awaiting_official_mint" };
  const signal = AbortSignal.timeout(40000);
  if (job === "payouts") {
    const config = payoutHostConfig(env, "cron");
    const sign = config.mode === "execute" ? feeCronSigner(env.LAUNCH_PAYOUT_CRON_KEY_JSON, config.payer) : cannotSign;
    const store = launchPayoutStore(config.databaseUrl, "minute", config.pilot);
    const chain = launchPayoutChain(payoutConnection(config.endpoint, signal, config.fallbackEndpoint), config,
      blockRecoveryRpc(config.fallbackEndpoint || config.endpoint, signal));
    for (const url of [config.endpoint, ...(config.fallbackEndpoint ? [config.fallbackEndpoint] : [])])
      if (await payoutConnection(url, signal).getGenesisHash() !== mainnet) throw Error("Mainnet required.");
    const nativeTick = () => runLaunchPayout({ store, chain, payer: config.payer,
      dailyCapLamports: config.dailyCapLamports, sign, signal, execute: config.mode === "execute",
      onFailure: failure => console.error(JSON.stringify({event:"launch_payout_failure",...failure})) });
    const quoteConfigured=env.LAUNCH_QUOTE_PAYOUTS_ENABLED==='true';
    const acceptance=quoteConfigured&&env.LAUNCH_QUOTE_PAYOUTS_VERIFIED!=='true'?quoteAcceptance(env.QUOTE_ACCEPTANCE_POLICY,env.LAUNCH_BURN_WALLET):null;
    const quotes=quoteConfigured?launchQuoteStore(config.databaseUrl,acceptance?.quoteMint):null;
    const quoteExecute=config.mode==='execute'&&(env.LAUNCH_QUOTE_PAYOUTS_VERIFIED==='true'||!!acceptance&&quoteAcceptanceAllows(acceptance,acceptance.quoteMint,acceptance.treasury))&&!config.pilot;
    const authorize=acceptance?(route:import('./launch-quote-fees.js').QuoteFeeRoute)=>quoteAcceptanceAllows(acceptance,route.asset.mint,route.buybackWallet):undefined;
    const quoteChain=quotes?launchQuoteChain(payoutConnection(config.endpoint,signal,config.fallbackEndpoint),{payer:config.payer,value:quoteFeeValuation(env.JUPITER_API_KEY||'',signal),recoveryRpc:()=>blockRecoveryRpc(config.fallbackEndpoint||config.endpoint,signal)}):null;
    // Both queues get a turn even when the native queue is empty. Their shared
    // database payer lock prevents concurrent gas-budget overspending.
    const quoteOutcomes:string[]=[];
    const outcomes = await boundedPayoutBatch(async()=>{
     const settled=await Promise.allSettled([nativeTick(),...(quotes?[runQuoteFeePayout({store:quotes,chain:quoteChain!,payer:config.payer,dailyCapLamports:config.dailyCapLamports,execute:quoteExecute,signal,authorize,sign:quoteExecute?sign:cannotSign})]:[])]);
     const results=settled.map(r=>r.status==='fulfilled'?r.value:{outcome:'retry' as const});
     if(results[1])quoteOutcomes.push(results[1].outcome);
     const failure=results.find(r=>['retry','budget_exhausted','expired_unresolved'].includes(r.outcome));
     return failure||results.find(r=>r.outcome!=='idle')||results[0];
    }, signal);
    const health = await store.health();
    const quoteHealth=quotes?await quotes.health():null;
    return { status: "completed", mode: config.mode, quoteMode:quoteConfigured?(quoteExecute?(acceptance?'acceptance':'execute'):'recover'):'disabled',outcomes:[...outcomes,...quoteOutcomes],
      healthy: !signal.aborted && !outcomes.some(v => ["retry", "budget_exhausted", "expired_unresolved"].includes(v)) &&
        (!quoteHealth||quoteHealth.unresolved===0&&(!quoteExecute||quoteHealth.blocked===0&&quoteHealth.overdue===0))&&
        health.blocked === 0 && health.unresolved === 0 && (config.mode !== "execute" || health.overdue === 0) };
  }
  const config = buybackHostConfig(env, "cron");
  const sign = config.mode === "execute" ? feeCronSigner(env.BUYBACK_CRON_KEY_JSON, config.policy.treasury) : cannotSign;
  const store = buybackStore(config.databaseUrl, config.policy, "minute", config.pilot);
  for (const url of [config.endpoint, ...(config.fallback ? [config.fallback] : [])])
    if (await payoutConnection(url, signal).getGenesisHash() !== mainnet) throw Error("Mainnet required.");
  await store.register();
  const result = await runBuyback({ store, chain: buybackChain(payoutConnection(config.endpoint, signal, config.fallback),
    config.policy, blockRecoveryRpc(config.fallback || config.endpoint, signal)), sign, signal, execute: config.mode === "execute",
    onFailure: failure => console.error(JSON.stringify({event:"buyback_failure",...failure})) });
  const health = await store.health();
  return { status: "completed", mode: config.mode, outcomes: [result.outcome],
    healthy: !signal.aborted && health.unresolved === 0 && !["retry", "budget_exhausted", "expired_unresolved"].includes(result.outcome) &&
      (config.mode !== "execute" || health.enabled === true || (!!config.pilot && health.outcome === "confirmed")) };
}

export async function runFeeCron(job:FeeJob,env:NodeJS.ProcessEnv):Promise<FeeCronResult>{
 if(job!=='buybacks'||env.QUOTE_CONVERSION_ENABLED!=='true')return runBaseFeeCron(job,env);
 const results=await Promise.allSettled([runBaseFeeCron(job,env),runQuoteConversionCron(env)]);
 const values=results.map(r=>r.status==='fulfilled'?r.value:{status:'unavailable',healthy:false});
 return{status:'completed',conversionMode:values[1]?.mode,outcomes:values.flatMap(v=>v?.outcomes||[]),healthy:values.every(v=>v?.healthy!==false)};
}

export function feeCronHandler(job: FeeJob, env = process.env, run = runFeeCron) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    const send = (status: number, body: unknown) => { res.statusCode = status; res.end(JSON.stringify(body)); };
    if (req.method !== "GET") { res.setHeader("Allow", "GET"); return send(405, { message: "GET required." }); }
    const expected = env.CRON_SECRET ? `Bearer ${env.CRON_SECRET}` : "", actual = String(req.headers.authorization || "");
    if (!expected || Buffer.byteLength(expected) !== Buffer.byteLength(actual) || !timingSafeEqual(Buffer.from(expected), Buffer.from(actual)))
      return send(401, { message: "Unauthorized." });
    if (env.VERCEL_ENV !== "production") return send(403, { message: "Production scheduled runtime required." });
    try {
      const result = await run(job, env);
      // Only fixed status/outcome values are returned; never serialize an error,
      // provider response, configuration object or signed transaction.
      console.log(JSON.stringify({ event: "fee_cron", job, ...result }));
      return send(result.healthy === false ? 503 : 200, result);
    } catch {
      console.error(JSON.stringify({ event: "fee_cron_unavailable", job }));
      return send(503, { status: "unavailable" });
    }
  };
}
