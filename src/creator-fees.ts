// A planning calculation, never a treasury balance or authorization to trade.
export function creatorFeeAllocation(sol: string, percentage: string) {
  if (!/^(0|[1-9]\d{0,8})(\.\d{1,9})?$/.test(sol))
    throw Error("Enter collected fees in SOL, with up to nine decimal places.");
  if (!/^(0|[1-9]\d?|100)$/.test(percentage))
    throw Error("Enter a whole percentage from 0 to 100.");
  const [whole, fraction = ""] = sol.split(".");
  const received =
    BigInt(whole) * 1000000000n + BigInt(fraction.padEnd(9, "0"));
  const buyback = (received * BigInt(percentage)) / 100n;
  return { received, buyback, retained: received - buyback };
}
export function formatSol(raw: bigint) {
  return `${raw / 1000000000n}.${(raw % 1000000000n).toString().padStart(9, "0")}`.replace(
    /\.?0+$/,
    "",
  );
}
