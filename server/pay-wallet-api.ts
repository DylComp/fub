import type { IncomingMessage, ServerResponse } from "node:http";
import { isMint } from "../src/assets.js";
import { validMerchantId } from "../src/card-allowance.js";
import { copyReadRpc } from "./copy-rpc.js";
import { cardWalletSnapshot } from "./bridge-card-wallet.js";
import type { Rpc } from "./funding.js";
export function payWalletHandler(config: { rpc: () => Rpc; merchantId: () => string | undefined }) {
  const pending = new Map<string, Promise<unknown>>(); let windowAt = 0, requests = 0;
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("Content-Type", "application/json");
    const send = (status: number, body: unknown) => { res.statusCode = status; res.end(JSON.stringify(body)); };
    if (req.method !== "GET") { res.setHeader("Allow", "GET"); return send(405, { message: "This endpoint only reads wallet funding." }); }
    const url = new URL(req.url || "/", "http://local"), wallet = url.searchParams.get("wallet");
    if (!wallet || !isMint(wallet) || [...url.searchParams.keys()].join(",") !== "wallet") return send(400, { message: "Enter one Solana wallet address." });
    const merchantId = config.merchantId() || null;
    if (merchantId !== null && !validMerchantId(merchantId)) return send(503, { message: "Card program configuration is unavailable." });
    if (Date.now() - windowAt >= 60000) { windowAt = Date.now(); requests = 0; }
    const key = `${merchantId}:${wallet}`; let job = pending.get(key);
    if (!job) {
      if (requests >= 20 || pending.size >= 3) { res.setHeader("Retry-After", "60"); return send(429, { message: "Wallet checks are busy. Try again in a minute." }); }
      requests++;
      job = cardWalletSnapshot(wallet, merchantId, config.rpc()).finally(() => pending.delete(key)); pending.set(key, job);
    }
    try { return send(200, await job); }
    catch { return send(503, { message: "The wallet balance could not be verified. Try again shortly." }); }
  };
}
export const handlePayWallet = payWalletHandler({ rpc: () => copyReadRpc(), merchantId: () => process.env.BRIDGE_CARD_MERCHANT_ID });
