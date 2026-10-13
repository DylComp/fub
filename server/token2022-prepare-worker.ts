import {nativeBuyBound} from './native-buy-bound.js';
import {hasActivePumpCurve,simulateCurveSwap} from './pump-curve-execution.js';
import {curveNativeResult} from './token2022-recovery.js';
import { token22Queue, nativeJobRequest } from "./token2022-queue.js";
import { simulateRaydium22Swap,simulateStandardNativeSwap,simulatePumpNativeSwap } from "./token2022-raydium-simulation.js";
import {decodeCopyRoute,instructionBytes} from '../src/copy-swap.js';
import {record} from '../src/live-orders.js';
import type { Raydium22Request } from "./token2022-raydium.js";
import type { Rpc } from "./funding.js";
import { boundedDispatchRpc } from "./copy-dispatch-worker.js";
import { TOKEN_PROGRAM,WSOL } from "../src/funding-model.js";
import { isMint } from "../src/assets.js";
import { MAINNET_GENESIS } from "./solana-network.js";

// Keep headroom between the quoted minimum and the independently enforced
// signed limit. The on-chain transaction is stricter than the user maximum.
export function nativeQuoteSlippage(authorizedBps:number){
  if(!Number.isInteger(authorizedBps)||authorizedBps<10||authorizedBps>500)throw Error('Invalid authorized slippage.');
  return Math.max(10,Math.floor(authorizedBps/2));
}
export async function fetchNativeBuild(
  request: Raydium22Request,
  apiKey: string,
  deadline: number,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
  maxSellRaw = '1000000',
  includePump = false,
  maxBuyRaw = '10000000',
) {
  signal?.throwIfAborted();
  if (
    !apiKey ||
    /[\r\n]/.test(apiKey) ||
    !Number.isSafeInteger(deadline) ||
    deadline <= Date.now() ||
    ![request.wallet, request.mint].every(isMint) ||
    !["buy", "sell"].includes(request.direction) ||
    !/^[1-9][0-9]{0,19}$/.test(request.inputRaw) ||
    !/^[1-9][0-9]{0,19}$/.test(maxSellRaw) || BigInt(maxSellRaw)>18446744073709551615n ||
    BigInt(request.inputRaw) >
      (request.direction === "buy" ? nativeBuyBound(maxBuyRaw) : BigInt(maxSellRaw)) ||
    !Number.isInteger(request.slippageBps) ||
    request.slippageBps < 10 ||
    request.slippageBps > 500
  )
    throw Error("Invalid native quote request.");
  const query = new URLSearchParams({
    inputMint: request.direction === "buy" ? WSOL : request.mint,
    outputMint: request.direction === "buy" ? request.mint : WSOL,
    amount: request.inputRaw,
    slippageBps: String(request.slippageBps),
    taker: request.wallet,
    dexes: includePump ? "Raydium CLMM,Pump.fun Amm" : "Raydium CLMM",
    instructionVersion: "V2",
    // The native verifier accepts direct CLMM routes, not shared multi-hop
    // paths. V2 ignores the legacy onlyDirectRoutes hint. Bound the account
    // search instead; the independent instruction/pool review remains required.
    maxAccounts: includePump ? "40" : "24",
  });
  const response = await fetcher(`https://api.jup.ag/swap/v2/build?${query}`, {
    headers: { "x-api-key": apiKey, Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.any([
      AbortSignal.timeout(Math.min(8000, deadline - Date.now())),
      ...(signal ? [signal] : []),
    ]),
  });
  if (!response.ok)
    throw Error(`Native quote provider returned HTTP ${response.status}.`);
  if (
    !response.body ||
    Number(response.headers.get("content-length") || 0) > 150000
  )
    throw Error("Native quote response is too large or empty.");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 150000) throw Error("Native quote response is too large.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  signal?.throwIfAborted();
  if (Date.now() >= deadline) throw Error("Native quote expired.");
  let build: unknown;
  try {
    build = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw Error("Native quote returned invalid JSON.");
  }
  if (includePump) {
    const route = decodeCopyRoute(instructionBytes(record(record(build).swapInstruction).data));
    // The larger PumpSwap account allowance can make the provider select a
    // shared/multihop CLMM path. Request one constrained CLMM quote instead;
    // the same deadline, amounts and independent trade validators still apply.
    if (route.kind !== 'direct' || route.intermediateNode !== undefined)
      return fetchNativeBuild(request,apiKey,deadline,signal,fetcher,maxSellRaw,false,maxBuyRaw);
  }
  return build;
}
export function isPumpNativeBuild(build:unknown){
 const route=decodeCopyRoute(instructionBytes(record(record(build).swapInstruction).data));
 return route.steps.some(s=>[99,100,193,194].includes(s.variant));
}
// Bounded preparation-only runner. No signer, broadcast, permission enrollment or
// process entry point is supplied here. Hosts must opt in after configuration.
export async function runNativePreparation(
  options: {
    url: string;
    rpc: Rpc;
    apiKey?: string;
    enabled?: boolean;
    signal?: AbortSignal;
  },
  deps = {
    queue: token22Queue,
    fetchBuild: fetchNativeBuild,
    simulate: simulateRaydium22Swap,
    simulateStandard: simulateStandardNativeSwap,
    simulatePump: simulatePumpNativeSwap,
    curveAvailable:hasActivePumpCurve,
    simulateCurve:simulateCurveSwap,
  },
) {
  if (options.enabled !== true || !options.apiKey)
    return { outcome: "disabled" as const };
  options.signal?.throwIfAborted();
  const queue = deps.queue(options.url);
  await queue.discover();
  const job = await queue.claim();
  if (!job) return { outcome: "idle" as const };
  const deadline = Math.min(job.deadline, job.leaseUntil),
    rpc = boundedDispatchRpc(options.rpc, deadline, options.signal);
  try {
    if ((await rpc("getGenesisHash", [])) !== MAINNET_GENESIS)
      throw Error("Mainnet RPC is required.");
    const position =
      job.decision.side === "sell" ? await queue.position(job) : "0";
    let request: Raydium22Request;
    try {
      request = nativeJobRequest(job, position);
    } catch {
      await queue.finish(job, false);
      return { outcome: "ineligible" as const };
    }
    if(job.permission.version>=9&&await deps.curveAvailable(request.mint,rpc)){
      const simulated=await deps.simulateCurve({wallet:request.wallet,mint:request.mint,direction:request.direction,inputRaw:request.inputRaw,slippageBps:request.slippageBps},rpc,undefined,BigInt(job.permission.maxFeeLamports)>=10000n?5000:0,job.permission.buyLamports);
      options.signal?.throwIfAborted();if(!(await queue.current(job)))return{outcome:'superseded' as const};
      simulated.review.expiresAt=Math.min(simulated.review.expiresAt,job.deadline);
      const result=curveNativeResult(simulated);
      if(BigInt(result.maximumSetupRentLamports)>BigInt(job.permission.maxRentLamports)){await queue.finish(job,false);return{outcome:"ineligible" as const};}
      const id=await queue.save(job,result.executionReview);
      return{outcome:id?'prepared' as const:'superseded' as const};
    }
    request={...request,slippageBps:nativeQuoteSlippage(job.permission.slippageBps)};
    const build = await deps.fetchBuild(
      request,
      options.apiKey,
      deadline,
      options.signal,
      fetch,
      request.direction === 'sell' ? position : undefined,
      job.permission.version>=7&&job.decision.tokenProgram===TOKEN_PROGRAM,
      job.permission.buyLamports,
    );
    options.signal?.throwIfAborted();
    if (!(await queue.current(job))) return { outcome: "superseded" as const };
    const priorityMicroLamports=BigInt(job.permission.maxFeeLamports)>=7000n?5000:0;
    const pump=isPumpNativeBuild(build);
    if(pump&&(job.permission.version<7||job.decision.tokenProgram!==TOKEN_PROGRAM))throw Error('PumpSwap is outside this permission.');
    const result = await (pump?deps.simulatePump:job.decision.tokenProgram===TOKEN_PROGRAM?deps.simulateStandard:deps.simulate)(build, request, rpc, request.direction === 'sell' ? position : undefined, request.direction === "sell",priorityMicroLamports,true,job.permission.buyLamports);
    options.signal?.throwIfAborted();
    if(BigInt(result.maximumSetupRentLamports)>BigInt(job.permission.maxRentLamports)){
      await queue.finish(job,false);return{outcome:"ineligible" as const};
    }
    const review = {
      ...result.executionReview,
      expiresAt: Math.min(result.executionReview.expiresAt, job.deadline),
    };
    const id = await queue.save(job, review);
    return { outcome: id ? ("prepared" as const) : ("superseded" as const) };
  } catch {
    await queue.finish(job, true);
    return { outcome: "retry" as const };
  }
}
