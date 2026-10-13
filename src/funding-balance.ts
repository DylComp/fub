import { isMint } from "./assets";
export type FundingBalance = {
  wallet: string;
  mint: string;
  source: string;
  decimals: number;
  rawAmount: string;
  frozen: boolean;
  fetchedAt: number;
};
export function validateFundingBalance(
  value: FundingBalance,
  wallet: string,
  mint: string,
) {
  if (
    !value ||
    value.wallet !== wallet ||
    value.mint !== mint ||
    !isMint(value.source) ||
    !Number.isInteger(value.decimals) ||
    value.decimals < 0 ||
    value.decimals > 18 ||
    typeof value.rawAmount !== "string" ||
    !/^(0|[1-9]\d{0,19})$/.test(value.rawAmount) ||
    BigInt(value.rawAmount) > 18446744073709551615n ||
    typeof value.frozen !== "boolean" ||
    (value.frozen && value.rawAmount !== "0") ||
    !Number.isSafeInteger(value.fetchedAt) ||
    value.fetchedAt > Date.now() + 1000 ||
    Date.now() - value.fetchedAt > 30000
  )
    throw new Error(
      "The wallet balance could not be verified. Check it again.",
    );
}
