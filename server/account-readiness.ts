import { createHash } from "node:crypto";
import bs58 from "bs58";
import { isMint } from "../src/assets.js";
import { TOKEN_PROGRAM, USDC, WSOL } from "../src/funding-model.js";
import { associated } from "../src/transaction-review.js";
import { PUMP_AMM_PROGRAM, SYSTEM_PROGRAM } from "../src/copy-pumpswap.js";
import { record } from "../src/live-orders.js";
import { pumpAddress } from "./copy-pumpswap.js";
import { verifyEmptyWrappedAccount } from "./copy-intermediate.js";
import { TOKEN_2022 } from "./jupiter-routes.js";
import {
  inspectToken2022Mint,
  verifyToken2022Account,
  TokenSetupUnsupported,
} from "./token2022-setup.js";
import type { TokenSetupConfig } from "../src/account-readiness.js";
import type { Rpc } from "./funding.js";
import type {
  AccountReadiness,
  ReadinessAccount,
} from "../src/account-readiness.js";

const invalid = (): never => {
  throw new Error("Trading account evidence is unavailable or invalid.");
};
function rawAccount(value: unknown, owner: string, size: number) {
  const a = record(value),
    data = a.data;
  if (
    a.owner !== owner ||
    a.executable !== false ||
    !Number.isSafeInteger(a.lamports) ||
    (a.lamports as number) < 1 ||
    !Array.isArray(data) ||
    data.length !== 2 ||
    data[1] !== "base64" ||
    typeof data[0] !== "string" ||
    data[0].length !== Math.ceil(size / 3) * 4
  )
    return invalid();
  const b = Buffer.from(data[0], "base64");
  if (b.length !== size || b.toString("base64") !== data[0]) return invalid();
  return b;
}
const key = (b: Buffer, n: number) => bs58.encode(b.subarray(n, n + 32));

// Public, read-only account preparation report. One finalized snapshot binds all
// account states. A ready row is not wallet ownership, trading permission or a
// funded route simulation. No transaction is built, signed or sent here.
export async function readAccountReadiness(
  wallet: string,
  mint: string,
  rpc: Rpc,
  minContextSlot?: number,
  tokenProgram = TOKEN_PROGRAM,
): Promise<AccountReadiness> {
  if (![TOKEN_PROGRAM, TOKEN_2022].includes(tokenProgram)) return invalid();
  if (
    minContextSlot !== undefined &&
    (!Number.isSafeInteger(minContextSlot) || minContextSlot < 1)
  )
    return invalid();
  if (!isMint(wallet) || !isMint(mint) || [USDC, WSOL].includes(mint))
    throw new Error("Choose a memecoin contract and a public Solana wallet.");
  const [usdc, token, middle, rewards] = await Promise.all([
    associated(wallet, USDC),
    associated(wallet, mint, tokenProgram),
    associated(wallet, WSOL),
    pumpAddress("user_volume_accumulator", [wallet]),
  ]);
  const addresses = [wallet, USDC, mint, usdc, token, middle, rewards];
  const [resultValue, tokenRent, rewardRent] = await Promise.all([
    rpc("getMultipleAccounts", [
      addresses,
      {
        encoding: "base64",
        commitment: "finalized",
        ...(minContextSlot ? { minContextSlot } : {}),
      },
    ]),
    rpc("getMinimumBalanceForRentExemption", [
      165,
      { commitment: "finalized" },
    ]),
    rpc("getMinimumBalanceForRentExemption", [
      137,
      { commitment: "finalized" },
    ]),
  ]);
  const result = record(resultValue),
    slot = record(result.context).slot;
  if (
    !Number.isSafeInteger(slot) ||
    (slot as number) < (minContextSlot || 1) ||
    !Array.isArray(result.value) ||
    result.value.length !== addresses.length ||
    result.value.some(
      (v) => v !== null && (!v || typeof v !== "object" || Array.isArray(v)),
    ) ||
    [tokenRent, rewardRent].some(
      (v) =>
        !Number.isSafeInteger(v) ||
        (v as number) < 1 ||
        (v as number) > 2500000,
    )
  )
    return invalid();
  const values = result.value,
    owner = values[0] === null ? null : record(values[0]);
  // Resolve the actual program from chain data, then bind the correct ATA and
  // mint in a fresh finalized snapshot. Never substitute a legacy-program ATA.
  if (record(values[2]).owner === TOKEN_2022 && tokenProgram === TOKEN_PROGRAM)
    return readAccountReadiness(wallet, mint, rpc, slot as number, TOKEN_2022);
  if (tokenProgram === TOKEN_2022 && record(values[2]).owner !== TOKEN_2022)
    return invalid();
  let tokenSetup: TokenSetupConfig | undefined,
    tokenProblem = "",
    selectedRent = tokenRent as number;
  if (tokenProgram === TOKEN_2022) {
    try {
      tokenSetup = inspectToken2022Mint(values[2], mint);
    } catch (error) {
      tokenProblem =
        error instanceof TokenSetupUnsupported
          ? error.message
          : "Token extensions could not be verified.";
    }
    if (tokenSetup) {
      const rent = await rpc("getMinimumBalanceForRentExemption", [
        tokenSetup.accountSize,
        { commitment: "finalized" },
      ]);
      if (
        !Number.isSafeInteger(rent) ||
        (rent as number) < 1 ||
        (rent as number) > 2500000
      )
        return invalid();
      selectedRent = rent as number;
    }
  }
  if (
    owner &&
    (owner.owner !== SYSTEM_PROGRAM ||
      owner.executable !== false ||
      !Number.isSafeInteger(owner.lamports) ||
      (owner.lamports as number) < 0)
  )
    return invalid();
  function supportedMint(n: number) {
    try {
      const b = rawAccount(values[n], TOKEN_PROGRAM, 82);
      return b[45] === 1 && b[44] <= 18;
    } catch {
      return false;
    }
  }
  const row = (
    kind: ReadinessAccount["kind"],
    address: string,
    n: number,
    sizeRent: number,
    check: () => void,
    missing: string,
    blocked: string,
  ): ReadinessAccount => {
    if (values[n] === null)
      return {
        kind,
        address,
        status: "missing",
        detail: missing,
        rentLamports: String(sizeRent),
      };
    try {
      check();
      return {
        kind,
        address,
        status: "ready",
        detail: "Account is available.",
        rentLamports: "0",
      };
    } catch {
      return {
        kind,
        address,
        status: "blocked",
        detail: blocked,
        rentLamports: "0",
      };
    }
  };
  function tokenRow(
    kind: "usdc" | "token",
    address: string,
    n: number,
    asset: string,
    mintIndex: number,
  ) {
    if (kind === "token" && tokenProgram === TOKEN_2022) {
      if (!tokenSetup)
        return {
          kind,
          address,
          status: "blocked" as const,
          detail: tokenProblem,
          rentLamports: "0",
        };
      return row(
        kind,
        address,
        n,
        selectedRent,
        () => {
          verifyToken2022Account(values[n], wallet, mint, tokenSetup!);
        },
        "This wallet does not have the Token-2022 associated account. Copy execution for this token is not supported yet.",
        "The Token-2022 account is frozen, delegated or has unsupported extensions or authority.",
      );
    }
    if (!supportedMint(mintIndex))
      return {
        kind,
        address,
        status: "blocked" as const,
        detail:
          "This mint could not be verified as a supported standard SPL token.",
        rentLamports: "0",
      };
    return row(
      kind,
      address,
      n,
      tokenRent as number,
      () => {
        const b = rawAccount(values[n], TOKEN_PROGRAM, 165),
          close = b.readUInt32LE(129);
        if (
          key(b, 0) !== asset ||
          key(b, 32) !== wallet ||
          b[108] !== 1 ||
          b.readUInt32LE(72) !== 0 ||
          b.readUInt32LE(109) !== 0 ||
          b.readBigUInt64LE(121) !== 0n ||
          (close !== 0 && (close !== 1 || key(b, 133) !== wallet))
        )
          return invalid();
      },
      "This wallet does not have the associated token account.",
      "The account is frozen, delegated, reassigned or has an unsupported authority.",
    );
  }
  const accounts = [
    tokenRow("usdc", usdc, 3, USDC, 1),
    tokenRow("token", token, 4, mint, 2),
    row(
      "wrapped-sol",
      middle,
      5,
      tokenRent as number,
      () => verifyEmptyWrappedAccount(values[5], wallet),
      "An empty wrapped SOL account is needed for routes through SOL.",
      "This wrapped SOL account is funded, has unsynchronized SOL or has unsupported permissions. Existing funds will not be swept.",
    ),
    row(
      "pump-rewards",
      rewards,
      6,
      rewardRent as number,
      () => {
        const b = rawAccount(values[6], PUMP_AMM_PROGRAM, 137),
          disc = createHash("sha256")
            .update("account:UserVolumeAccumulator")
            .digest()
            .subarray(0, 8);
        if (
          !b.subarray(0, 8).equals(disc) ||
          key(b, 8) !== wallet ||
          b[40] > 1 ||
          b[73] > 1
        )
          return invalid();
      },
      "PumpSwap buys require this account. Creating it needs separate owner approval.",
      "The PumpSwap reward account could not be verified for this wallet.",
    ),
  ];
  const rent = (kind: ReadinessAccount["kind"]) =>
    BigInt(accounts.find((a) => a.kind === kind)!.rentLamports);
  const buy = rent("token") + rent("wrapped-sol"),
    sell = rent("usdc") + rent("wrapped-sol");
  return {
    ...(tokenSetup ? { tokenSetup } : {}),
    wallet,
    mint,
    slot: slot as number,
    fetchedAt: Date.now(),
    accounts,
    balanceLamports: String(owner?.lamports ?? 0),
    setupRentLamports: accounts
      .reduce((sum, a) => sum + BigInt(a.rentLamports), 0n)
      .toString(),
    buyTokenRentLamports: buy.toString(),
    sellTokenRentLamports: sell.toString(),
    tradeRentLimitLamports: "2500000",
    buyRentWithinLimit: buy <= 2500000n,
    sellRentWithinLimit: sell <= 2500000n,
    rewardConsentRequired: accounts[3].status === "missing",
  };
}
