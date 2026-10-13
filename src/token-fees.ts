// Raw token units remain strings at the API boundary and bigint in arithmetic.
export type TransferFee = {
  epoch: string;
  basisPoints: number;
  maximumRaw: string;
};
export type TokenFeeReport = {
  mint: string;
  slot: number;
  epoch: string;
  decimals: number;
  fetchedAt: number;
  mintHash: string;
  canChange: boolean;
  current: TransferFee;
  scheduled?: TransferFee;
};
export function tokenUnits(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > 18446744073709551615n
  )
    throw Error("Invalid raw token amount.");
  return BigInt(value);
}
export function transferAmounts(grossRaw: string, fee: TransferFee) {
  const gross = tokenUnits(grossRaw),
    cap = tokenUnits(fee.maximumRaw);
  tokenUnits(fee.epoch);
  if (
    !Number.isInteger(fee.basisPoints) ||
    fee.basisPoints < 0 ||
    fee.basisPoints > 10000
  )
    throw Error("Invalid transfer fee.");
  const rounded = (gross * BigInt(fee.basisPoints) + 9999n) / 10000n;
  const withheld = rounded < cap ? rounded : cap;
  return {
    grossRaw: gross.toString(),
    feeRaw: withheld.toString(),
    netRaw: (gross - withheld).toString(),
  };
}
// Smallest gross amount that delivers the requested net, including ceiling rounding.
export function grossForNet(netRaw: string, fee: TransferFee) {
  const net = tokenUnits(netRaw),
    cap = tokenUnits(fee.maximumRaw);
  transferAmounts("0", fee);
  if (net === 0n || fee.basisPoints === 0) return transferAmounts(netRaw, fee);
  const gross =
    fee.basisPoints === 10000
      ? net + cap
      : (() => {
          const uncapped =
            (net * 10000n + BigInt(9999 - fee.basisPoints)) /
            BigInt(10000 - fee.basisPoints);
          return uncapped - net >= cap ? net + cap : uncapped;
        })();
  return transferAmounts(gross.toString(), fee);
}
export function decimalTokenUnits(value: string, decimals: number) {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 18 ||
    value.length > 40 ||
    !/^(0|[1-9]\d*)(\.\d+)?$/.test(value)
  )
    throw Error("Enter a token amount.");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals)
    throw Error(`Use at most ${decimals} decimal places.`);
  return tokenUnits(
    (
      BigInt(whole) * 10n ** BigInt(decimals) +
      BigInt(fraction.padEnd(decimals, "0") || "0")
    ).toString(),
  ).toString();
}
