import type { IncomingMessage, ServerResponse } from "node:http";
import { parseSetupRequest } from "../src/account-setup.js";
import type { SetupCheck } from "../src/account-setup.js";
import {
  prepareAccountSetup,
  preflightAccountSetup,
  SetupCheckError,
} from "./account-setup.js";
import { rpcRequest } from "./funding.js";

const pending = new Map<string, Promise<SetupCheck>>();
let windowStart = 0,
  requests = 0;
// Public unsigned simulation only. Do not expose a send method or return signed
// or signable bytes. A result is not ownership proof or approval to create.
export async function handleAccountSetup(
  req: IncomingMessage,
  res: ServerResponse,
  endpoint: string,
) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  const send = (status: number, body: unknown) => {
    res.statusCode = status;
    res.end(JSON.stringify(body));
  };
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return send(405, { message: "GET required." });
  }
  const p = new URL(req.url || "/", "http://localhost").searchParams;
  let request;
  try {
    if (
      p.get("action") !== "setup" ||
      ["action", "address", "mint", "accounts"].some(
        (k) => p.getAll(k).length !== 1,
      ) ||
      [...p.keys()].some(
        (k) => !["action", "address", "mint", "accounts"].includes(k),
      )
    )
      throw Error();
    request = parseSetupRequest({
      wallet: p.get("address"),
      mint: p.get("mint"),
      accounts: (p.get("accounts") || "").split(","),
    });
  } catch {
    return send(400, {
      message: "Choose a wallet, token and distinct accounts to check.",
    });
  }
  const key = JSON.stringify(request);
  let job = pending.get(key);
  if (!job) {
    if (Date.now() - windowStart >= 60000) {
      windowStart = Date.now();
      requests = 0;
    }
    if (requests >= 8 || pending.size >= 2) {
      res.setHeader("Retry-After", "60");
      return send(429, {
        message: "Setup checks are busy. Try again shortly.",
      });
    }
    requests++;
    const rpc = (method: string, params: unknown[]) =>
      rpcRequest(method, params, endpoint);
    job = prepareAccountSetup(request, rpc)
      .then((prepared) => preflightAccountSetup(prepared, rpc))
      .finally(() => pending.delete(key));
    pending.set(key, job);
  }
  try {
    return send(200, await job);
  } catch (error) {
    return send(error instanceof SetupCheckError ? 422 : 503, {
      message:
        error instanceof SetupCheckError
          ? error.message
          : "Setup checks are unavailable. Try again shortly.",
    });
  }
}
