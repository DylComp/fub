export type ReadinessAccount = {
  kind: "usdc" | "token" | "wrapped-sol" | "pump-rewards";
  address: string;
  status: "ready" | "missing" | "blocked";
  detail: string;
  rentLamports: string;
};
export type TokenSetupConfig = {
  program: string;
  accountSize: 170 | 182;
  transferFee: boolean;
  extensions: number[];
  mintHash: string;
};
export type AccountReadiness = {
  tokenSetup?: TokenSetupConfig;
  wallet: string;
  mint: string;
  slot: number;
  fetchedAt: number;
  accounts: ReadinessAccount[];
  balanceLamports: string;
  setupRentLamports: string;
  buyTokenRentLamports: string;
  sellTokenRentLamports: string;
  tradeRentLimitLamports: string;
  buyRentWithinLimit: boolean;
  sellRentWithinLimit: boolean;
  rewardConsentRequired: boolean;
};
