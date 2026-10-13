import {readWalletSession,walletSessionConfigured,walletLogoutCookies} from './wallet-session.js';
import {nativeCopyApproval,NativeApprovalConflict} from "./native-copy-approval.js";
import type {Token22Permission} from "../src/native-copy-permission.js";
import type {NativeCopyLimits} from "./native-copy-approval.js";
import { lookupFomoProfiles } from "./fomo-profiles.js";
import { token22History } from "./token2022-history.js";
import { token22Reconciliation } from "./token2022-reconciliation.js";
import { nativeCopyReport } from "./token2022-report.js";
import { blockRecoveryRpc } from "./copy-block-recovery.js";
import { copyControls } from "./copy-controls.js";
import { copyReconciliation } from "./copy-reconciliation.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
} from "node:crypto";
import bs58 from "bs58";
import { isMint } from "../src/assets.js";
import { CopyValidation } from "../src/copy-account.js";
import { copyMonitorStore } from "./copy-monitor-store.js";
import { copyExecution } from "./copy-execution.js";
import { copyLedger } from "./copy-ledger.js";
import { copyHistory } from "./copy-history.js";
import { copyFeedStore } from "./copy-feed-store.js";
import { scanCopyFeed } from "./copy-scanner.js";
import { copyReadRpc, reserveCopyScan } from "./copy-rpc.js";
import { copyStore, CopyConflict } from "./copy-store.js";
import { readFundingBalance } from "./funding-balance.js";
import { createFundingService, rpcRequest, tokenInfo } from "./funding.js";
import {
  fundingConfigured,
  fundingInfrastructureConfigured,
  fundingStore,
} from "./funding-store.js";
import { operationId } from "../src/funding-model.js";
import {
  orderId,
  parseAmendment,
  parseHistory,
  record,
  challengeExpiry,
} from "../src/live-orders.js";

import { ProviderBusy, waitForProviderSlot } from "./provider-budget.js";

const BASE = "https://api.jup.ag/trigger/v2";
const SESSION = "fomo_trigger_session",
  CHALLENGE = "fomo_trigger_challenge";
type Session = {
  kind: "session";
  wallet: string;
  token: string;
  csrf: string;
  expires: number;
};
type Challenge = {
  kind: "challenge";
  wallet: string;
  message: string;
  expires: number;
};
type Envelope = Session | Challenge;
class HttpError extends Error {
  upstreamStatus?: number;
  constructor(
    readonly status: number,
    message: string,
    readonly code = "request_failed",
  ) {
    super(message);
  }
}
// Stateless, authenticated encryption works across Vercel instances. Key rotation
// intentionally invalidates sessions. Tokens never enter HTML, JSON, or storage APIs.
function seal(value: Envelope, secret: string): string {
  const iv = randomBytes(12),
    key = createHash("sha256")
      .update(`fomo-trigger-cookie-v1\0${secret}`)
      .digest();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  return Buffer.concat([
    iv,
    cipher.update(JSON.stringify(value)),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64url");
}
function unseal(value: string | undefined, secret: string): Envelope | null {
  if (!value || value.length > 3900) return null;
  try {
    const bytes = Buffer.from(value, "base64url");
    const key = createHash("sha256")
      .update(`fomo-trigger-cookie-v1\0${secret}`)
      .digest();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      bytes.subarray(0, 12),
    );
    decipher.setAuthTag(bytes.subarray(-16));
    const data = JSON.parse(
      Buffer.concat([
        decipher.update(bytes.subarray(12, -16)),
        decipher.final(),
      ]).toString(),
    ) as Envelope;
    return data.expires > Date.now() && isMint(data.wallet) ? data : null;
  } catch {
    return null;
  }
}
function cookies(req: IncomingMessage): Map<string, string> {
  const pairs = (req.headers.cookie || "")
    .split(";")
    .map((item) => item.trim().split("="));
  return new Map(pairs.map(([key, value]) => [key, value]));
}
function cookie(name: string, value: string, seconds: number): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${process.env.VERCEL || process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}
function equal(a: unknown, b: string): boolean {
  return (
    typeof a === "string" &&
    a.length === b.length &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
function mutationOrigin(req: IncomingMessage) {
  const origin = req.headers.origin;
  if (
    !origin ||
    req.headers["x-fomo-request"] !== "1" ||
    req.headers["content-type"]?.split(";")[0].trim() !== "application/json"
  )
    throw new HttpError(403, "Open this action from Fub.");
  try {
    const url = new URL(origin);
    if (
      !/^(https?:)$/.test(url.protocol) ||
      url.host !== req.headers.host ||
      (url.protocol !== "https:" &&
        !["localhost", "127.0.0.1"].includes(url.hostname)) ||
      (req.headers["sec-fetch-site"] &&
        req.headers["sec-fetch-site"] !== "same-origin")
    )
      throw new Error();
  } catch {
    throw new HttpError(403, "Open this action from Fub.");
  }
}
async function readBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  // Vercel may supply parsed JSON; Vite and native Node supply a readable stream.
  const parsed = (req as IncomingMessage & { body?: unknown }).body;
  if (parsed !== undefined) {
    if (Buffer.byteLength(JSON.stringify(parsed)) > 16000)
      throw new HttpError(413, "Request is too large.");
    return record(typeof parsed === "string" ? JSON.parse(parsed) : parsed);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const data = Buffer.from(chunk);
    size += data.length;
    if (size > 16000) throw new HttpError(413, "Request is too large.");
    chunks.push(data);
  }
  return record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}
function exactKeys(body: Record<string, unknown>, allowed: string[]) {
  if (
    Object.keys(body).length !== allowed.length ||
    Object.keys(body).some((key) => !allowed.includes(key))
  )
    throw new HttpError(400, "Unexpected request fields.");
}
async function provider(
  path: string,
  key: string | undefined,
  token?: string,
  body?: unknown,
  method = body ? "POST" : "GET",
) {
  try {
    if (!key) await waitForProviderSlot();
    const response = await fetch(`${BASE}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: {
        ...(key ? { "x-api-key": key } : {}),
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403)
        throw new HttpError(
          401,
          "Authorization expired or was refused. Reconnect to Jupiter.",
          "authorization_required",
        );
      if (response.status === 429)
        throw new HttpError(
          429,
          "Jupiter is busy. Wait a minute before trying again.",
        );
      if (
        response.status === 400 ||
        response.status === 404 ||
        response.status === 409
      ) {
        const error = new HttpError(
          409,
          "Jupiter refused the request. Refresh orders and check the current order state.",
          "provider_rejected",
        );
        error.upstreamStatus = response.status;
        throw error;
      }
      throw new HttpError(502, "Jupiter is unavailable. Try again shortly.");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 2000000) {
        await reader.cancel();
        throw new Error();
      }
      chunks.push(chunk.value);
    }
    return record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch (error) {
    if (error instanceof ProviderBusy)
      throw new HttpError(429, error.message, "provider_busy");
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      502,
      "Jupiter did not return a usable response. Refresh before repeating a change.",
      "provider_unknown",
    );
  }
}

export function createTriggerHandler() {
  let minute = 0,
    calls = 0,
    inFlight = 0;
  return async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    key = process.env.JUPITER_API_KEY,
  ) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Vary", "Cookie");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.end(JSON.stringify(body));
    };
    const secret = process.env.TRIGGER_SESSION_SECRET || key;
    const keyless =
      process.env.JUPITER_KEYLESS_ENABLED === "true" &&
      !!process.env.DATABASE_URL &&
      (process.env.TRIGGER_SESSION_SECRET?.length || 0) >= 43;
    const configured = !!secret && (!!key || keyless);
    let acquired = false;
    try {
      const url = new URL(req.url || "/", "https://local.invalid");
      if (
        [...url.searchParams.keys()].some((name) => name !== "action") ||
        url.searchParams.getAll("action").length !== 1
      )
        throw new HttpError(400, "Choose one action.");
      const action = url.searchParams.get("action");
      const walletOnlyAction = action?.startsWith("copy-") || action === "fomo-profile";
      const localCandidate = walletOnlyAction ? readWalletSession(req) : null;
      const localSession = localCandidate && (equal(req.headers["x-fomo-csrf"],localCandidate.csrf) || !cookies(req).has(SESSION)) ? localCandidate : null;
      const actions = [
        "session",
        "fomo-profile",
        "challenge",
        "verify",
        "logout",
        "history",
        "amend",
        "token-info",
        "funding-balance",
        "funding-prepare",
        "funding-submit",
        "funding-list",
        "funding-events",
        "copy-list",
        "copy-controls",
        "copy-native-history",
        "copy-native-limits",
        "copy-native-prepare",
        "copy-native-approve",
        "copy-native-inventory",
        "copy-native-inventory-review",
        "copy-native-inventory-apply",
        "copy-inventory",
        "copy-inventory-review",
        "copy-inventory-apply",
        "copy-pause",
        "copy-stop",
        "copy-history",
        "copy-recover",
        "copy-save",
        "copy-archive",
        "copy-feed",
        "copy-scan",
        "copy-monitor",
        "funding-reconcile",
        "funding-abandon",
        "funding-renew",
      ];
      if (!actions.includes(action || ""))
        throw new HttpError(400, "Unsupported action.");
      if (req.method !== (action === "session" ? "GET" : "POST")) {
        res.setHeader("Allow", action === "session" ? "GET" : "POST");
        throw new HttpError(405, "Method not allowed.");
      }
      if (action !== "session") mutationOrigin(req);
      const clear = () =>
        res.setHeader("Set-Cookie", [
          cookie(SESSION, "", 0),
          cookie(CHALLENGE, "", 0),
        ]);
      if (action === "logout") {
        const body = await readBody(req);
        exactKeys(body, body.wallet === undefined ? [] : ["wallet"]);
        if (
          body.wallet !== undefined &&
          (typeof body.wallet !== "string" || !isMint(body.wallet))
        )
          throw new HttpError(400, "Invalid wallet.");
        if (body.wallet && secret) {
          // A delayed disconnect for wallet A must not clear wallet B's session.
          const jar = cookies(req);
          const matching = [SESSION, CHALLENGE].filter(
            (name) => unseal(jar.get(name), secret!)?.wallet === body.wallet,
          );
          const cleared = [...matching.map((name) => cookie(name, "", 0)), ...walletLogoutCookies(req, body.wallet as string)];
          if (cleared.length)
            res.setHeader(
              "Set-Cookie",
              cleared,
            );
        } else res.setHeader("Set-Cookie", [cookie(SESSION,"",0),cookie(CHALLENGE,"",0),...walletLogoutCookies(req)]);
        send(200, { configured, address: null });
        return;
      }
      if (!configured && !(walletOnlyAction && walletSessionConfigured())) {
        if (action === "session") {
          clear();
          send(200, { configured: false, address: null });
          return;
        }
        throw new HttpError(
          503,
          "Live orders are waiting for the Jupiter connection.",
          "unconfigured",
        );
      }
      const jar = cookies(req),
        unpacked = unseal(jar.get(SESSION), secret!);
      const session: Session | null = localSession ? {kind:"session",wallet:localSession.wallet,csrf:localSession.csrf,expires:localSession.expiresAt,token:""} : unpacked?.kind === "session" ? unpacked : null;
      if (action === "session") {
        if (!session) clear();
        send(200, {
          configured: true,
          funding: !!key && fundingConfigured(),
          recovery: !!key && fundingInfrastructureConfigured(),
          address: session?.wallet || null,
          ...(session
            ? { expiresAt: session.expires, csrf: session.csrf }
            : {}),
        });
        return;
      }
      const body = await readBody(req);
      if (typeof body.wallet !== "string" || !isMint(body.wallet))
        throw new HttpError(400, "Choose a Solana wallet.");
      if (action !== "challenge" && action !== "verify") {
        if (!session || session.wallet !== body.wallet)
          throw new HttpError(
            401,
            "Sign in with this wallet first.",
            "authorization_required",
          );
        if (!equal(req.headers["x-fomo-csrf"], session.csrf))
          throw new HttpError(
            403,
            "Session changed. Refresh before continuing.",
          );
      }
      const window = Math.floor(Date.now() / 60000);
      if (window !== minute) {
        minute = window;
        calls = 0;
      }
      // Per-instance bound, not a distributed account quota. Never auto-retry mutations.
      if (calls >= 60 || inFlight >= 4)
        throw new HttpError(
          429,
          "Too many requests. Wait a minute and try again.",
        );
      calls++;
      inFlight++;
      acquired = true;
      if (action === "fomo-profile") {
        exactKeys(body, ["wallet"]);
        // The address comes from our signed session, never from the index.
        // A returned username is attribution, not a Fomo login or a grant.
        let profiles;
        try { profiles = await lookupFomoProfiles(session!.wallet); }
        catch { throw new HttpError(503, "Fomo profile lookup is unavailable. Your wallet remains connected. Try again later."); }
        if (session!.expires <= Date.now()) throw new HttpError(401, "Sign-in expired. Verify your wallet again.", "authorization_required");
        send(200, { wallet: session!.wallet, proof: "wallet-signature", expiresAt: session!.expires, profiles });
        return;
      }
      if (action?.startsWith("copy-")) {
        if (!process.env.DATABASE_URL)
          throw new HttpError(
            503,
            "Wallet backups are not available yet.",
            "unconfigured",
          );
        const store = copyStore();
        try {
          if(action==='copy-native-prepare'){
            exactKeys(body,['wallet','id','limits']);
            send(200,await nativeCopyApproval(process.env.DATABASE_URL!).prepare(body.wallet,body.id as string,body.limits as NativeCopyLimits));return;
          }
          if(action==='copy-native-approve'){
            exactKeys(body,['wallet','scope','signature']);
            if(typeof body.signature!=='string'||body.signature.length>100)throw new CopyValidation('Invalid approval signature.');
            const approval=await nativeCopyApproval(process.env.DATABASE_URL!).accept(body.wallet,body.scope as Token22Permission,body.signature);
            send(200,{...approval,executionConfigured:process.env.COPY_EXECUTION_ENABLED==='true'&&process.env.COPY_NATIVE_EXECUTION_ENABLED==='true'});return;
          }
          if (action === "copy-native-history") {
            exactKeys(body, ["wallet", "id"]);
            const history = await token22History(
              process.env.DATABASE_URL!,
              body.wallet,
              body.id as string,
            );
            if (!history)
              throw new HttpError(404, "This copy plan was not found.");
            send(200, history);
            return;
          }
          if (action === "copy-native-limits") {
            exactKeys(body, ["wallet"]);
            send(
              200,
              await nativeCopyReport(process.env.DATABASE_URL!, body.wallet),
            );
            return;
          }
          const inventoryAction = action.replace(
            "copy-native-inventory",
            "copy-inventory",
          );
          if (
            inventoryAction === "copy-inventory" ||
            inventoryAction === "copy-inventory-review" ||
            inventoryAction === "copy-inventory-apply"
          ) {
            exactKeys(
              body,
              inventoryAction === "copy-inventory"
                ? ["wallet"]
                : inventoryAction === "copy-inventory-review"
                  ? ["wallet", "mint"]
                  : ["wallet", "id", "allocations"],
            );
            const inventory = (
              action.startsWith("copy-native-")
                ? token22Reconciliation
                : copyReconciliation
            )(
              process.env.DATABASE_URL!,
              () => copyReadRpc(),
              async () => {
                if (!(await reserveCopyScan(process.env.DATABASE_URL!)))
                  throw new HttpError(
                    429,
                    "Balance checks are busy. Try again shortly.",
                  );
              },
            );
            send(
              200,
              inventoryAction === "copy-inventory"
                ? await inventory.report(body.wallet)
                : inventoryAction === "copy-inventory-review"
                  ? await inventory.review(body.wallet, body.mint as string)
                  : await inventory.apply(
                      body.wallet,
                      body.id as string,
                      body.allocations,
                    ),
            );
            return;
          }
          if (action === "copy-controls") {
            exactKeys(body, ["wallet"]);
            send(
              200,
              await copyControls(process.env.DATABASE_URL!).report(body.wallet),
            );
            return;
          }
          if (action === "copy-pause" || action === "copy-stop") {
            exactKeys(
              body,
              action === "copy-pause"
                ? ["wallet", "requestId", "id", "version"]
                : ["wallet", "requestId"],
            );
            send(
              200,
              await copyControls(process.env.DATABASE_URL!).stop(
                body.wallet,
                body.requestId as string,
                action === "copy-pause"
                  ? { id: body.id as string, version: body.version as number }
                  : undefined,
              ),
            );
            return;
          }
          if (action === "copy-recover") {
            exactKeys(body, ["wallet", "id"]);
            if (!operationId(body.id))
              throw new HttpError(400, "Invalid copy trade.");
            const attempt = await copyLedger(process.env.DATABASE_URL!).get(
              body.wallet,
              body.id,
            );
            if (!attempt) throw new HttpError(404, "Copy trade not found.");
            if (
              ["submitting", "unknown"].includes(attempt.state) &&
              !(await reserveCopyScan(process.env.DATABASE_URL!))
            )
              throw new HttpError(
                429,
                "Confirmation checks are busy. Try again shortly.",
              );
            try {
              const result = await copyExecution({
                url: process.env.DATABASE_URL!,
                rpc: copyReadRpc(),
                blockRecoveryRpc: blockRecoveryRpc(),
              }).recover(body.wallet, body.id);
              if (!result) throw new HttpError(404, "Copy trade not found.");
              send(200, { id: result.id, state: result.state });
            } catch (error) {
              if (error instanceof HttpError) throw error;
              throw new HttpError(
                503,
                "Confirmation could not be verified. The trade remains locked.",
              );
            }
            return;
          }
          if (action === "copy-history") {
            exactKeys(body, ["wallet", "id"]);
            if (!operationId(body.id))
              throw new HttpError(400, "Invalid copy plan.");
            const report = await copyHistory(
              process.env.DATABASE_URL!,
              body.wallet,
              body.id,
            );
            if (!report) throw new HttpError(404, "Copy plan not found.");
            send(200, report);
            return;
          }
          if (action === "copy-monitor") {
            exactKeys(body, ["wallet", "id", "version", "revision", "enabled"]);
            if (!operationId(body.id))
              throw new HttpError(400, "Invalid copy plan.");
            const feeds = copyFeedStore(process.env.DATABASE_URL!);
            if (!(await feeds.report(body.wallet, body.id)))
              throw new HttpError(404, "Copy plan not found.");
            await copyMonitorStore(process.env.DATABASE_URL!).set(
              body.wallet,
              body.id,
              body.version as number,
              body.revision as number,
              body.enabled as boolean,
            );
            send(200, await feeds.report(body.wallet, body.id));
            return;
          }
          if (action === "copy-feed" || action === "copy-scan") {
            exactKeys(body, ["wallet", "id"]);
            if (!operationId(body.id))
              throw new HttpError(400, "Invalid copy plan.");
            const feeds = copyFeedStore(process.env.DATABASE_URL!);
            const report = await feeds.report(body.wallet, body.id);
            if (!report) throw new HttpError(404, "Copy plan not found.");
            if (action === "copy-feed") {
              send(200, report);
              return;
            }
            if (!(await reserveCopyScan(process.env.DATABASE_URL!)))
              throw new HttpError(
                429,
                "Activity checks are busy. Try again shortly.",
                "copy_busy",
              );
            send(
              200,
              await scanCopyFeed(feeds, copyReadRpc(), body.wallet, body.id),
            );
            return;
          }
          if (action === "copy-list") {
            exactKeys(body, ["wallet"]);
            send(200, {
              wallet: body.wallet,
              plans: await store.list(body.wallet),
            });
            return;
          }
          if (action === "copy-save") {
            exactKeys(body, ["wallet", "id", "version", "draft"]);
            send(
              200,
              await store.save(body.wallet, {
                id: body.id,
                version: body.version,
                draft: body.draft,
              }),
            );
            return;
          }
          exactKeys(body, ["wallet", "id", "version"]);
          send(
            200,
            await store.archive(
              body.wallet,
              body.id as string,
              body.version as number,
            ),
          );
          return;
        } catch (error) {
          if (error instanceof HttpError) throw error;
          if (error instanceof NativeApprovalConflict)
            throw new HttpError(409, error.message, "native_approval_"+error.reason);
          if (error instanceof CopyConflict)
            throw new HttpError(409, error.message, "copy_conflict");
          if (error instanceof CopyValidation)
            throw new HttpError(400, error.message, "invalid_copy_plan");
          if (
            action.startsWith("copy-inventory") ||
            action.startsWith("copy-native-inventory")
          )
            throw new HttpError(
              503,
              "Token positions could not be verified. Refresh positions or retry the same correction.",
              "copy_inventory_unavailable",
            );
          throw new HttpError(
            503,
            "Wallet backups could not be saved or loaded. Refresh backups before retrying.",
            "copy_storage_unavailable",
          );
        }
      }
      if (action === "funding-balance") {
        exactKeys(body, ["wallet", "mint"]);
        if (typeof body.mint !== "string" || !isMint(body.mint))
          throw new HttpError(400, "Use an exact token contract.");
        const readRpc = (method: string, params: unknown[]) =>
          rpcRequest(
            method,
            params,
            process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
          );
        send(200, await readFundingBalance(body.wallet, body.mint, readRpc));
        return;
      }
      if (action === "token-info") {
        exactKeys(body, ["wallet", "mint"]);
        if (typeof body.mint !== "string" || !isMint(body.mint))
          throw new HttpError(400, "Use an exact token contract.");
        send(200, await tokenInfo(body.mint, rpcRequest));
        return;
      }
      if (action?.startsWith("funding-")) {
        if (!process.env.DATABASE_URL)
          throw new HttpError(
            503,
            "Order recovery is not available yet.",
            "unconfigured",
          );
        const store = fundingStore();
        if (action === "funding-list") {
          exactKeys(body, ["wallet"]);
          send(200, { operations: await store.list(body.wallet) });
          return;
        }
        if (!operationId(body.id))
          throw new HttpError(400, "Invalid funding request.");
        if (action === "funding-events") {
          exactKeys(body, ["wallet", "id"]);
          if (!(await store.get(body.wallet, body.id)))
            throw new HttpError(404, "Funding request not found.");
          send(200, {
            wallet: body.wallet,
            id: body.id,
            events: await store.events(body.wallet, body.id),
          });
          return;
        }
        if (action === "funding-abandon") {
          exactKeys(body, ["wallet", "id"]);
          const existing = await store.get(body.wallet, body.id);
          if (
            !existing ||
            existing.kind !== "create" ||
            existing.state !== "prepared"
          )
            throw new HttpError(
              409,
              "Only an unsubmitted deposit can be discarded.",
            );
          send(
            200,
            await store.update(body.wallet, body.id, ["prepared"], {
              state: "abandoned",
              message: "Unsubmitted deposit discarded. No submission was made.",
            }),
          );
          return;
        }
        if (!key || !fundingInfrastructureConfigured())
          throw new HttpError(
            503,
            "The funding connection is not available yet.",
            "unconfigured",
          );
        if (action !== "funding-reconcile" && !fundingConfigured())
          throw new HttpError(
            503,
            "New funding requests are paused. Recovery checks remain available.",
            "execution_paused",
          );
        const service = createFundingService(
          store,
          (path, data, method) =>
            provider(path, key, session!.token, data, method),
          rpcRequest,
        );
        if (action === "funding-renew") {
          exactKeys(body, ["wallet", "id", "newId"]);
          if (!operationId(body.newId))
            throw new HttpError(400, "Invalid renewal request.");
          send(200, await service.renew(body.wallet, body.id, body.newId));
          return;
        }
        if (action === "funding-prepare") {
          exactKeys(
            body,
            body.kind === "create"
              ? ["wallet", "id", "kind", "plan"]
              : ["wallet", "id", "kind", "orderId"],
          );
          send(200, await service.prepare(body.wallet, body));
          return;
        }
        if (action === "funding-submit") {
          exactKeys(body, ["wallet", "id", "signedTransaction"]);
          if (
            typeof body.signedTransaction !== "string" ||
            body.signedTransaction.length > 1644
          )
            throw new HttpError(400, "Invalid signed transaction.");
          send(
            200,
            await service.submit(body.wallet, body.id, body.signedTransaction),
          );
          return;
        }
        if (action === "funding-reconcile") {
          exactKeys(body, ["wallet", "id"]);
          send(200, await service.reconcile(body.wallet, body.id));
          return;
        }
      }
      if (action === "challenge") {
        exactKeys(body, ["wallet"]);
        const data = await provider("/auth/challenge", key, undefined, {
          type: "message",
          walletPubkey: body.wallet,
        });
        const expires = challengeExpiry(data.challenge, body.wallet);
        if (data.type !== "message" || !expires)
          throw new HttpError(
            502,
            "Jupiter returned an unrecognized sign-in message.",
          );
        const sealed = seal(
          {
            kind: "challenge",
            wallet: body.wallet,
            message: data.challenge as string,
            expires,
          },
          secret!,
        );
        if (sealed.length > 3800)
          throw new HttpError(
            502,
            "Jupiter's sign-in message could not be stored safely.",
          );
        res.setHeader("Set-Cookie", cookie(CHALLENGE, sealed, 300));
        send(200, {
          wallet: body.wallet,
          message: data.challenge,
          expiresAt: expires,
        });
        return;
      }
      if (action === "verify") {
        exactKeys(body, ["wallet", "signature"]);
        const pending = unseal(jar.get(CHALLENGE), secret!);
        if (pending?.kind !== "challenge" || pending.wallet !== body.wallet)
          throw new HttpError(401, "Sign-in expired. Request a new message.");
        if (
          typeof body.signature !== "string" ||
          !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(body.signature)
        )
          throw new HttpError(400, "Invalid wallet signature.");
        const signature = bs58.decode(body.signature);
        const pubkey = createPublicKey({
          key: Buffer.concat([
            Buffer.from("302a300506032b6570032100", "hex"),
            bs58.decode(body.wallet),
          ]),
          format: "der",
          type: "spki",
        });
        if (
          signature.length !== 64 ||
          !verify(null, Buffer.from(pending.message), pubkey, signature)
        )
          throw new HttpError(
            401,
            "The signature does not match this wallet and message.",
          );
        const data = await provider("/auth/verify", key, undefined, {
          type: "message",
          walletPubkey: body.wallet,
          signature: body.signature,
        });
        if (
          typeof data.token !== "string" ||
          data.token.length > 2400 ||
          !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(data.token)
        )
          throw new HttpError(502, "Jupiter returned an invalid session.");
        let expires = Date.now() + 24 * 60 * 60000;
        try {
          const claims = JSON.parse(
            Buffer.from(data.token.split(".")[1], "base64url").toString(),
          );
          if (
            !Number.isSafeInteger(claims.exp) ||
            claims.exp * 1000 <= Date.now()
          )
            throw new Error();
          expires = Math.min(expires, claims.exp * 1000);
        } catch {
          throw new HttpError(
            502,
            "Jupiter returned an expired or invalid session.",
          );
        }
        const next: Session = {
          kind: "session",
          wallet: body.wallet,
          token: data.token,
          csrf: randomBytes(24).toString("hex"),
          expires,
        };
        res.setHeader("Set-Cookie", [
          cookie(
            SESSION,
            seal(next, secret!),
            Math.floor((expires - Date.now()) / 1000),
          ),
          cookie(CHALLENGE, "", 0),
        ]);
        send(200, {
          configured: true,
          address: next.wallet,
          funding: !!key && fundingConfigured(),
          recovery: !!key && fundingInfrastructureConfigured(),
          expiresAt: expires,
          csrf: next.csrf,
        });
        return;
      }
      if (action === "history") {
        exactKeys(body, ["wallet", "state", "offset"]);
        if (
          !["active", "past"].includes(String(body.state)) ||
          !Number.isSafeInteger(body.offset) ||
          (body.offset as number) < 0 ||
          (body.offset as number) > 10000 ||
          (body.offset as number) % 20
        )
          throw new HttpError(400, "Invalid history page.");
        const data = await provider(
          `/orders/history?state=${body.state}&limit=20&offset=${body.offset}&sort=updated_at&dir=desc`,
          key,
          session!.token,
        );
        try {
          send(200, parseHistory(data, session!.wallet, body.offset as number));
        } catch {
          throw new HttpError(
            502,
            "Jupiter returned incomplete order history. No balances or statuses were inferred.",
          );
        }
        return;
      }
      if (action === "amend") {
        exactKeys(body, ["wallet", "id", "changes"]);
        if (!orderId(body.id)) throw new HttpError(400, "Invalid order.");
        const changes = parseAmendment(body.changes);
        const data = await provider(
          `/orders/price/${body.id}`,
          key,
          session!.token,
          changes,
          "PATCH",
        );
        if (data.id !== body.id)
          throw new HttpError(
            502,
            "The update could not be confirmed. Refresh before trying again.",
            "provider_unknown",
          );
        send(200, { id: data.id });
        return;
      }
    } catch (error) {
      const failure =
        error instanceof HttpError
          ? error
          : new HttpError(400, "Check the request fields and try again.");
      if (failure.status === 429)
        res.setHeader(
          "Retry-After",
          failure.code === "provider_busy" ? "3" : "60",
        );
      if (failure.code === "authorization_required")
        res.setHeader("Set-Cookie", cookie(SESSION, "", 0));
      send(failure.status, { message: failure.message, code: failure.code });
    } finally {
      if (acquired) inFlight--;
    }
  };
}
export const handleTrigger = createTriggerHandler();
