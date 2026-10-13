import {FUB_CANONICAL_ORIGIN, isFubProductionOrigin, type FubWebOrigin} from './fub-origin.js';
import { isMint } from "./assets.js";
export type PayHistoryAuthorization = { wallet: string; nonce: string; issuedAt: number; expiresAt: number } & ({version: 1; origin?: never} | {version: 2; origin: FubWebOrigin});
export function payHistoryMessage(a: PayHistoryAuthorization, now = Date.now()) {
  if (!a || Object.keys(a).sort().join() !== (a.version === 2 ? "expiresAt,issuedAt,nonce,origin,version,wallet" : "expiresAt,issuedAt,nonce,version,wallet") || ![1,2].includes(a.version) || (a.version === 2 && !isFubProductionOrigin(a.origin)) || !isMint(a.wallet) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(a.nonce) ||
      !Number.isSafeInteger(a.issuedAt) || !Number.isSafeInteger(a.expiresAt) || a.issuedAt <= 0 || a.issuedAt > now + 30000 ||
      a.expiresAt <= now || a.expiresAt <= a.issuedAt || a.expiresAt - a.issuedAt > 300000) throw Error("Sign a fresh card history request.");
  return ["Fub", "Read my private card purchase and authorization history.", "This does not issue a card, approve token access or transfer funds.",
    `Site: ${a.version === 1 ? "https://fomo-pay.vercel.app" : a.origin}`, `Wallet: ${a.wallet}`, `Request: ${a.nonce}`, `Issued: ${a.issuedAt}`, `Expires: ${a.expiresAt}`].join("\n");
}
export function payHistoryAuthorization(wallet: string): PayHistoryAuthorization {
  const now = Date.now(); return { version: 2, origin: FUB_CANONICAL_ORIGIN, wallet, nonce: crypto.randomUUID(), issuedAt: now, expiresAt: now + 300000 };
}
