import { isAddress, isOffCurveAddress } from "@solana/kit";

export type SignerExecutionScope = {
  mode: "disabled" | "pilot" | "public";
  walletCount: number;
  allows(wallet: string): boolean;
};

// A trade flag alone must never open signing to every enrolled wallet.
// Recovery and owner revocation remain independent of this admission rule.
export function signerExecutionScope(env: Record<string, string | undefined>): SignerExecutionScope {
  const mode = env.SIGNER_EXECUTION_SCOPE || "disabled";
  if (!["disabled", "pilot", "public"].includes(mode)) throw Error("Invalid signing scope.");
  const raw = env.SIGNER_PILOT_WALLETS || "";
  const wallets = raw ? raw.split(",").map(value => value.trim()) : [];
  if (wallets.length > 5 || new Set(wallets).size !== wallets.length ||
    wallets.some(value => !isAddress(value) || isOffCurveAddress(value)))
    throw Error("Pilot scope requires one to five distinct signing wallets.");
  if (mode === "pilot" && wallets.length === 0) throw Error("Pilot wallets are required.");
  if (mode !== "pilot" && wallets.length > 0) throw Error("Pilot wallets require pilot scope.");
  if (mode === "disabled" && (env.SIGNER_EXECUTION_ENABLED === "true" || env.SIGNER_NATIVE_EXECUTION_ENABLED === "true"))
    throw Error("An explicit signing scope is required before execution.");
  if (env.SIGNER_NATIVE_EXECUTION_ENABLED === "true" && env.SIGNER_EXECUTION_ENABLED !== "true")
    throw Error("Native signing also requires the main signing gate.");
  const allowed = new Set(wallets);
  return {
    mode: mode as SignerExecutionScope["mode"], walletCount: wallets.length,
    allows(wallet) {
      return mode !== "disabled" && isAddress(wallet) && !isOffCurveAddress(wallet) && (mode === "public" || allowed.has(wallet));
    },
  };
}
