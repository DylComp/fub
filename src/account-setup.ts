import type { ReadinessAccount } from "./account-readiness.js";
import { isMint } from "./assets.js";
import { USDC, WSOL } from "./funding-model.js";
import { record } from "./live-orders.js";

export const SETUP_KINDS = [
  "usdc",
  "token",
  "wrapped-sol",
  "pump-rewards",
] as const;
export type SetupKind = ReadinessAccount["kind"];
export type SetupRequest = {
  wallet: string;
  mint: string;
  accounts: SetupKind[];
};
export type SetupCheck = SetupRequest & {
  status: "simulated";
  slot: number;
  checkedAt: number;
  expiresAt: number;
  feeLamports: string;
  rentLamports: string;
  totalLamports: string;
  accountAddresses: string[];
};
export function parseSetupRequest(value: unknown): SetupRequest {
  const r = record(value);
  if (
    Object.keys(r).sort().join() !== "accounts,mint,wallet" ||
    typeof r.wallet !== "string" ||
    !isMint(r.wallet) ||
    typeof r.mint !== "string" ||
    !isMint(r.mint) ||
    [USDC, WSOL].includes(r.mint) ||
    !Array.isArray(r.accounts) ||
    !r.accounts.length ||
    r.accounts.length > 4 ||
    r.accounts.some((k) => !SETUP_KINDS.includes(k as SetupKind)) ||
    new Set(r.accounts).size !== r.accounts.length
  )
    throw new Error("Choose a wallet, token and distinct accounts to check.");
  return {
    wallet: r.wallet,
    mint: r.mint,
    accounts: SETUP_KINDS.filter((k) => (r.accounts as unknown[]).includes(k)),
  };
}
