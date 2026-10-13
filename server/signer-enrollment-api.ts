import {matchesFubOrigin} from '../src/fub-origin.js';
import type { directExitOrders } from './direct-exit-orders.js';
import { InventoryCorrectionRefused } from "./isolated-inventory-corrections.js";
export type InventoryOwnerApi = {
  review(token:string,wallet:string,walletId:string,mint:string,signal:AbortSignal):Promise<unknown>;
  apply(token:string,wallet:string,walletId:string,id:string,allocations:unknown,signal:AbortSignal):Promise<unknown>;
};
import type { signerEnrollment } from "./signer-enrollment.js";
// Mount ONLY on the isolated signer service, never a Vercel application route.
// The outer host must supply HTTPS, connection/body deadlines and rate limits.
export function signerEnrollmentApi(origin: string, service: ReturnType<typeof signerEnrollment>, inventory?: InventoryOwnerApi, exits?:ReturnType<typeof directExitOrders>) {
  if (new URL(origin).origin !== origin || new URL(origin).protocol !== "https:") throw Error("Invalid enrollment origin.");
  return async (request: Request): Promise<Response> => {
    const requestOrigin = request.headers.get("origin");
    const allowed = matchesFubOrigin(requestOrigin, origin);
    const headers: Record<string, string> = { "Cache-Control": "no-store", "Vary": "Origin", "X-Content-Type-Options": "nosniff" };
    if (allowed) Object.assign(headers, { "Access-Control-Allow-Origin": requestOrigin!, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type" });
    const response = (body: unknown, status = 200) => Response.json(body, { status, headers });
    if (!allowed) return response({ error: "Request origin refused." }, 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") return response({ error: "Use POST." }, 405);
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return response({ error: "Use JSON." }, 415);
    const authorization = request.headers.get("authorization") ?? "";
    if (!/^Bearer [A-Za-z0-9_.-]{1,8192}$/.test(authorization)) return response({ error: "Sign in again." }, 401);
    const token = authorization.slice(7), signal = AbortSignal.any([request.signal, AbortSignal.timeout(10000)]);
    try {
      if (!request.body || Number(request.headers.get("content-length")) > 4096) return response({ error: "Request is too large." }, 413);
      const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      let abort: () => void = () => {};
      try {
        await Promise.race([(async () => {
          for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 4096) throw Error(); chunks.push(part.value); }
        })(), new Promise<never>((_, reject) => { abort = () => reject(Error()); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); })]);
      } finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!body || typeof body !== "object" || Array.isArray(body)) throw Error();
      const action = new URL(request.url).pathname;
      function exact(keys: string[]) { if (Object.keys(body).sort().join(",") !== keys.sort().join(",")) throw Error(); }
      if (action === '/v1/enrollment/access') {
        exact(['wallet', 'walletId']);
        return response(await service.access(token, body.wallet, body.walletId, signal));
      }
      if(action==='/v1/enrollment/direct-exit-review'&&exits){
        exact(['walletId','wallet','mint']);return response(await exits.review(token,body.walletId,body.wallet,body.mint,signal));
      }
      if (action === '/v1/enrollment/direct-exit-activate' && exits) {
        exact(['walletId','terms','signature']);
        if (body.terms?.origin !== requestOrigin) throw Error('Order origin does not match this request.');
        return response(await exits.activate(token,body.walletId,body.terms,body.signature,signal));
      }
      if (action === '/v1/enrollment/direct-exit-recover' && exits) {
        exact(['walletId','terms','signature']);
        if (body.terms?.origin !== requestOrigin) throw Error('Order origin does not match this request.');
        return response(await exits.recover(token,body.walletId,body.terms,body.signature,signal));
      }
      if (action === '/v1/enrollment/direct-exit-list' && exits) {
        exact(['wallet']);return response(await exits.list(token,body.wallet));
      }
      if (action === '/v1/enrollment/direct-exit-cancel' && exits) {
        exact(['id']);return response(await exits.cancel(token,body.id));
      }
      if (action === "/v1/enrollment/position-review" && inventory) {
        exact(["wallet","walletId","mint"]);
        return response(await inventory.review(token,body.wallet,body.walletId,body.mint,signal));
      }
      if (action === "/v1/enrollment/position-apply" && inventory) {
        exact(["wallet","walletId","id","allocations"]);
        return response(await inventory.apply(token,body.wallet,body.walletId,body.id,body.allocations,signal));
      }
      if (action === "/v1/enrollment/list") {
        exact(["wallet"]);
        return response(await service.list(token, body.wallet));
      }
      if (action === "/v1/enrollment/prepare") {
        exact(["wallet", "walletId", "durationMs"]);
        return response(await service.prepare(token, body.wallet, body.walletId, body.durationMs, signal, requestOrigin!));
      }
      if (!["/v1/enrollment/activate", "/v1/enrollment/stop", "/v1/enrollment/status"].includes(action)) return response({ error: "Not found." }, 404);
      exact(action.endsWith("/activate") ? ["id", "signature"] : ["id"]);
      if (typeof body.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body.id)) throw Error();
      if (action.endsWith("/activate")) await service.activate(token, body.id, body.signature, signal, requestOrigin!);
      if (action.endsWith("/stop")) await service.stop(token, body.id);
      return response(await service.status(token, body.id));
    } catch (error) {
      if(new URL(request.url).pathname.endsWith('/direct-exit-review'))return response({error:'This token balance could not be verified. Use a standard SPL token held in the connected wallet and check wallet access.'},400);
      if(error instanceof InventoryCorrectionRefused)return response({error:"Stop background access and resolve pending trades, then check the position again."},409);
      // Provider errors, tokens and signatures must not enter API errors/logs.
      return response({ error: "Permission request was not confirmed. Check its status before retrying." }, 400);
    }
  };
}
