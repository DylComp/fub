import {validateCashLimitDelivery,type CashLimitDelivery} from './cash-limit-delivery.js';
import {validateSignedNativeExpiry} from './native-expiry-proof.js';
import {validateCashCopyDelivery,type CashCopyDelivery} from './cash-copy-delivery.js';
import {validateExitDelivery,type ExitDelivery} from './direct-exit-delivery.js';
import { signerExecutionScope, type SignerExecutionScope } from "./signer-execution-scope.js";
import {validateUnsignedNativeExpiry,validateNativeRecoveryRequest,type NativeRecoveryRequest,type NativeSignatureRecovery} from "./native-signature-recovery.js";
import type { Token22Signer, Token22SigningRequest } from "./token2022-signing.js";
import { timingSafeEqual } from "node:crypto";
import type { CopySigningAdapter, CopySigningRequest } from "./copy-dispatch-worker.js";
import { verifyPrivySignedTransaction } from "./privy-sign-only.js";
const MAX_BODY = 98304;
function validToken(token: string) { if (!/^[a-f0-9]{64}$/.test(token)) throw Error("A dedicated executor credential is required."); }
async function boundedJson(response: Request | Response, signal: AbortSignal, maxBody=MAX_BODY) {
  if (!response.body || Number(response.headers.get("content-length")) > maxBody) throw Error();
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  const aborted = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", aborted, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) { const part = await reader.read(); signal.throwIfAborted(); if (part.done) break; size += part.value.length; if (size > maxBody) throw Error(); chunks.push(part.value); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { signal.removeEventListener("abort", aborted); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export function isolatedSignerApi(config: { executorToken: string; signingEnabled: boolean; exitPilotEnabled?:boolean; enrollment: (request: Request) => Promise<Response>; cashEnrollment?: (request: Request) => Promise<Response>; cashLimitApi?: (request:Request)=>Promise<Response>; cashLimitDelivery?:(signal:AbortSignal)=>Promise<CashLimitDelivery|null>; cashDelivery?:(signal:AbortSignal,wait?:boolean)=>Promise<CashCopyDelivery|null>; sign: CopySigningAdapter; signNative?: Token22Signer; recoverNative?: NativeSignatureRecovery; nativeSigningEnabled?: boolean; exitDelivery?:(signal:AbortSignal)=>Promise<ExitDelivery|null>; operations?:()=>object; backupReady?:()=>boolean; ready?: () => boolean; executionScope?: SignerExecutionScope }) {
  validToken(config.executorToken);
  const scope = config.executionScope ?? signerExecutionScope({});
  let inFlight = 0;
  const slots = new Map<string, { minute: number; count: number }>();
  return async (request: Request, peer: string): Promise<Response> => {
    const reply = (status: number, body: object) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    const url = new URL(request.url);
    if(url.pathname==="/backupz"&&request.method==="GET"&&!url.search){const ready=config.backupReady?.()===true;return reply(ready?200:503,{ready});}
    if (url.pathname === "/healthz" && request.method === "GET" && !url.search) return reply(200, { ready: true });
    if (url.pathname === "/readyz" && request.method === "GET" && !url.search) {
      const ready = config.ready?.() ?? false; return reply(ready ? 200 : 503, { ready });
    }
    if (url.search || !peer || peer.length > 128) return reply(400, { error: "Invalid request." });
    const minute = Math.floor(Date.now() / 60000);
    for (const [key, entry] of slots) if (entry.minute !== minute) slots.delete(key);
    if (!slots.has(peer) && slots.size >= 4096) return reply(503, { error: "Service busy." });
    const rate = slots.get(peer) ?? { minute, count: 0 }; slots.set(peer, rate);
    if (++rate.count > 120 || inFlight >= 24) return reply(429, { error: "Try again shortly." });
    if (request.headers.has("content-encoding") && request.headers.get("content-encoding") !== "identity") return reply(415, { error: "Encoding refused." });
    inFlight++;
    try {
      if (/^\/v1\/enrollment\/(access|prepare|activate|stop|status|list|position-review|position-apply|direct-exit-review|direct-exit-activate|direct-exit-recover|direct-exit-list|direct-exit-cancel)$/.test(url.pathname)) return await config.enrollment(request);
      if (/^\/v1\/cash-enrollment\/(config|activate|status|stop|list|readiness|history|owner-sale-review|owner-sale-submit)$/.test(url.pathname)) return config.cashEnrollment ? await config.cashEnrollment(request) : reply(404,{error:'Not found.'});
      if(/^\/v1\/cash-limits\/(config|activate|status|stop|list)$/.test(url.pathname))return config.cashLimitApi?await config.cashLimitApi(request):reply(404,{error:'Not found.'});
      const limitDelivery=url.pathname==='/v1/limit-delivery';
      const cashDelivery=url.pathname==='/v1/cash-delivery';
      const exitDelivery=url.pathname==='/v1/exit-delivery';
      const operations=url.pathname==='/v1/operations';
      const native = url.pathname === "/v1/sign-native", recovery = url.pathname === "/v1/recover-native", capabilities = url.pathname === "/v1/capabilities";
      if (!limitDelivery && !cashDelivery && !operations && !exitDelivery && !native && !recovery && !capabilities && url.pathname !== "/v1/sign") return reply(404, { error: "Not found." });
      if (request.method !== ((limitDelivery || cashDelivery || operations || capabilities || exitDelivery) ? "GET" : "POST") || request.headers.has("origin")) return reply(403, { error: "Signing request refused." });
      const supplied = request.headers.get("authorization") ?? "", expected = `Bearer ${config.executorToken}`;
      if (supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return reply(401, { error: "Signing request refused." });
      if(limitDelivery){const delivery=await config.cashLimitDelivery?.(request.signal)||null;if(delivery)await validateCashLimitDelivery(delivery);return reply(200,{delivery});}
      if(cashDelivery){
        if(!config.cashDelivery||!config.ready?.())return reply(503,{error:'Cash copy delivery is unavailable.'});
        const signal=AbortSignal.any([request.signal,AbortSignal.timeout(8000)]),delivery=await config.cashDelivery(signal,request.headers.get('prefer')==='wait=5');
        signal.throwIfAborted();if(delivery)await validateCashCopyDelivery(delivery);return reply(200,{delivery});
      }
      if(operations)return config.operations?reply(200,config.operations()):reply(503,{error:'Worker status unavailable.'});
      if (capabilities) return reply(200, { version: 1, ready: config.ready?.() ?? false, executionEnabled: config.signingEnabled && scope.mode !== "disabled", nativeExecutionEnabled: !config.exitPilotEnabled && config.signingEnabled && !!config.nativeSigningEnabled && !!config.signNative && scope.mode !== "disabled", scope: scope.mode, pilotWalletCount: scope.walletCount });
      if(exitDelivery){
        if(!config.signingEnabled||!(scope.mode==='public'||scope.mode==='pilot'&&config.exitPilotEnabled)||!config.exitDelivery||!config.ready?.())return reply(503,{error:'Direct exits are not activated.'});
        const signal=AbortSignal.any([request.signal,AbortSignal.timeout(8000)]),delivery=await config.exitDelivery(signal);
        signal.throwIfAborted();if(delivery){validateExitDelivery(delivery);if(!scope.allows(delivery.wallet))throw Error();}
        return reply(200,{delivery});
      }
      if (!recovery && scope.mode === "pilot" && (!native || config.exitPilotEnabled)) return reply(403,{error:"This pilot does not permit this signing endpoint."});
      if (recovery ? !config.recoverNative : (!config.signingEnabled || scope.mode === "disabled" || (native && (!config.nativeSigningEnabled || !config.signNative)))) return reply(503, { error: "Signing is not activated." });
      if (request.headers.get("content-type")?.split(";")[0] !== "application/json") return reply(415, { error: "Use JSON." });
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(native ? NATIVE_SIGNING_TIMEOUT_MS : 8000)]);
      const payload = await boundedJson(request, signal);
      if(recovery){validateNativeRecoveryRequest(payload);const signed=await config.recoverNative!(payload,signal);signal.throwIfAborted();return reply(200,typeof signed==='string'?{status:'recovered',signed}:signed?(signed.status==='signed-expired'?validateSignedNativeExpiry(signed,payload):validateUnsignedNativeExpiry(signed,payload)):{status:'pending'});}
      const body = payload as CopySigningRequest | Token22SigningRequest;
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).sort().join(",") !== (native ? "claimId,executionId,expiresAt,idempotencyKey,permission,review,reviewHash,wallet" : "attemptId,dispatch,expiresAt,idempotencyKey,permission,review,wallet") ||
          !Number.isSafeInteger(body.expiresAt) || body.expiresAt <= Date.now() || body.expiresAt > Date.now() + (native ? 60000 : 30000)) throw Error();
      if (!scope.allows(body.wallet)) return reply(403, { error: "Wallet is outside the active signing scope." });
      const signed = native ? await config.signNative!(body as Token22SigningRequest, signal) : await config.sign(body as CopySigningRequest, signal);
      signal.throwIfAborted();
      verifyPrivySignedTransaction(body.review.unsigned, signed, body.wallet);
      return reply(200, { signed });
    } catch { return reply(409, { error: "Signing was not confirmed. Recover the existing attempt before retrying." }); }
    finally { inFlight--; }
  };
}
function remoteSigner(config: { origin: string; token: string; fetcher?: typeof fetch }, native: boolean) {
  validToken(config.token);
  const endpoint = new URL(config.origin);
  if (endpoint.protocol !== "https:" || endpoint.origin !== config.origin) throw Error("A fixed HTTPS signer origin is required.");
  const fetcher = config.fetcher ?? fetch;
  return async (request: CopySigningRequest | Token22SigningRequest, signal: AbortSignal) => {
    try {
      signal.throwIfAborted();
      if (!Number.isSafeInteger(request.expiresAt) || request.expiresAt <= Date.now() || request.expiresAt > Date.now() + (native ? 60000 : 30000)) throw Error();
      const body = JSON.stringify(request); if (Buffer.byteLength(body) > MAX_BODY) throw Error();
      const active = AbortSignal.any([signal, AbortSignal.timeout(Math.min(native ? NATIVE_SIGNING_TIMEOUT_MS : 8000, request.expiresAt - Date.now()))]);
      const response = await fetcher(`${config.origin}/v1/${native ? "sign-native" : "sign"}`, { method: "POST", headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" }, body, signal: active, redirect: "error", cache: "no-store" });
      if (!response.ok) { await response.body?.cancel(); throw Error(); }
      const result = await boundedJson(response, active);
      if (!result || Object.keys(result).join(",") !== "signed" || typeof result.signed !== "string") throw Error();
      verifyPrivySignedTransaction(request.review.unsigned, result.signed, request.wallet);
      active.throwIfAborted();
      return result.signed;
    } catch { throw Error("Isolated signing was not confirmed. Recover the existing attempt before retrying."); }
  };
}

export function remoteCopySigner(config: {origin:string;token:string;fetcher?:typeof fetch}):CopySigningAdapter{return remoteSigner(config,false);}
export function remoteNativeSigner(config: {origin:string;token:string;fetcher?:typeof fetch}):Token22Signer{return remoteSigner(config,true);}

export function remoteNativeRecovery(config:{origin:string;token:string;fetcher?:typeof fetch}):NativeSignatureRecovery{
 validToken(config.token);const endpoint=new URL(config.origin);if(endpoint.protocol!=='https:'||endpoint.origin!==config.origin)throw Error('A fixed HTTPS signer origin is required.');
 return async(request:NativeRecoveryRequest,signal:AbortSignal)=>{
  validateNativeRecoveryRequest(request);const active=AbortSignal.any([signal,AbortSignal.timeout(Math.min(8000,request.expiresAt-Date.now()))]);active.throwIfAborted();
  try{
   const response=await (config.fetcher??fetch)(`${config.origin}/v1/recover-native`,{method:'POST',headers:{Authorization:`Bearer ${config.token}`,'Content-Type':'application/json'},body:JSON.stringify(request),signal:active,redirect:'error',cache:'no-store'});
   if(!response.ok){await response.body?.cancel();throw Error();}
   const result=await boundedJson(response,active);active.throwIfAborted();
   if(result?.status==='signed-expired')return validateSignedNativeExpiry(result,request);
   if(result?.status==='unsigned-expired')return validateUnsignedNativeExpiry(result,request);
   if(result?.status==='pending'&&Object.keys(result).join(',')==='status')return null;
   if(result?.status==='recovered'&&Object.keys(result).sort().join(',')==='signed,status'&&typeof result.signed==='string'&&result.signed.length<=1644)return result.signed;
   throw Error();
  }catch{throw Error('Native signature recovery unavailable. The existing reservation remains held.');}
 };
}

export function remoteExitDelivery(config:{origin:string;token:string;fetcher?:typeof fetch}){
 validToken(config.token);const u=new URL(config.origin);if(u.protocol!=='https:'||u.origin!==config.origin)throw Error('A fixed HTTPS signer origin is required.');
 return async(signal:AbortSignal):Promise<ExitDelivery|null>=>{
  const active=AbortSignal.any([signal,AbortSignal.timeout(8000)]);
  const response=await(config.fetcher??fetch)(config.origin+'/v1/exit-delivery',{method:'GET',headers:{Authorization:`Bearer ${config.token}`},signal:active,redirect:'error',cache:'no-store'});
  if(!response.ok){await response.body?.cancel();throw Error('Direct exit delivery unavailable.');}
  const body=await boundedJson(response,active);active.throwIfAborted();
  if(!body||Object.keys(body).join()!=='delivery')throw Error('Invalid direct exit handoff.');
  if(body.delivery!==null)validateExitDelivery(body.delivery);
  return body.delivery;
 };
}
import {NATIVE_SIGNING_TIMEOUT_MS} from './native-signing-deadline.js';

export function remoteCashCopyDelivery(config:{origin:string;token:string;fetcher?:typeof fetch}){
 validToken(config.token);const u=new URL(config.origin);if(u.protocol!=='https:'||u.origin!==config.origin)throw Error('Fixed HTTPS signer origin required.');
 return async(signal:AbortSignal):Promise<CashCopyDelivery|null>=>{
  const active=AbortSignal.any([signal,AbortSignal.timeout(10000)]);
  const r=await(config.fetcher||fetch)(config.origin+'/v1/cash-delivery',{headers:{Authorization:'Bearer '+config.token,Prefer:'wait=5'},signal:active,redirect:'error',cache:'no-store'});
  if(!r.ok){void r.body?.cancel();throw Error('Cash copy delivery unavailable.');}const body=await boundedJson(r,active,524288);
  if(!body||Object.keys(body).join()!=='delivery')throw Error('Invalid cash copy handoff.');if(body.delivery!==null)await validateCashCopyDelivery(body.delivery);active.throwIfAborted();return body.delivery;
 };
}

export function remoteCashLimitDelivery(config:{origin:string;token:string;fetcher?:typeof fetch}){
 validToken(config.token);const u=new URL(config.origin);if(u.protocol!=='https:'||u.origin!==config.origin)throw Error('Fixed HTTPS signer origin required.');
 return async(signal:AbortSignal):Promise<CashLimitDelivery|null>=>{
  const active=AbortSignal.any([signal,AbortSignal.timeout(10000)]);
  const r=await(config.fetcher||fetch)(config.origin+'/v1/limit-delivery',{headers:{Authorization:'Bearer '+config.token,Prefer:'wait=5'},signal:active,redirect:'error',cache:'no-store'});
  if(!r.ok){void r.body?.cancel();throw Error('Cash copy delivery unavailable.');}const body=await boundedJson(r,active,524288);
  if(!body||Object.keys(body).join()!=='delivery')throw Error('Invalid cash copy handoff.');if(body.delivery!==null)await validateCashLimitDelivery(body.delivery);active.throwIfAborted();return body.delivery;
 };
}
