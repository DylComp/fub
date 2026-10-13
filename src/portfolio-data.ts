export type Holding = {
  mint: string;
  program: "SPL" | "Token 2022";
  rawAmount: string;
  frozenRawAmount: string;
  decimals: number;
  accounts: number;
  symbol?: string;
  name?: string;
  priceUsd?: number;
  image?: string;
};
export type HoldingsReply = {
  address: string;
  fetchedAt: number;
  nativeLamports: string | null;
  holdings: Holding[];
  missing: string[];
  truncated: boolean;
  metadataUnavailable: boolean;
};
export type WalletMovement = {
  mint: string; rawAmount: string; decimals: number; direction: "in" | "out";
  chain: "solana"; symbol?: string; name?: string; image?: string;
};
export type WalletTransaction = {
  kind?: "buy" | "sell" | "swap" | "receive" | "send" | "activity" | "failed";
  movements?: WalletMovement[];
  feeLamports?: string;
  detailsAvailable?: boolean;
  signature: string;
  slot: number;
  blockTime: number | null;
  failed: boolean;
  confirmation: "confirmed" | "finalized";
};
export type ActivityReply = {
  address: string;
  fetchedAt: number;
  transactions: WalletTransaction[];
};
export function exactAmount(raw: string, decimals: number): string {
  const padded = raw.padStart(decimals + 1, "0");
  const whole = decimals ? padded.slice(0, -decimals) : padded;
  const fraction = decimals ? padded.slice(-decimals).replace(/0+$/, "") : "";
  return (
    whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
    (fraction ? `.${fraction}` : "")
  );
}
export function decimalAmount(raw: string, decimals: number): string {
  return exactAmount(raw, decimals).replaceAll(",", "");
}
