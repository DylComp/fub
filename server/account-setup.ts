import {
  address,
  blockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getTransactionEncoder,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import type { Instruction } from "@solana/kit";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import bs58 from "bs58";
import { parseSetupRequest } from "../src/account-setup.js";
import type {
  SetupRequest,
  SetupCheck,
  SetupKind,
} from "../src/account-setup.js";
import {
  associated,
  ATA_PROGRAM,
  fromBase64,
  toBase64,
} from "../src/transaction-review.js";
import { TOKEN_PROGRAM, USDC, WSOL } from "../src/funding-model.js";
import { PUMP_AMM_PROGRAM, SYSTEM_PROGRAM } from "../src/copy-pumpswap.js";
import { record } from "../src/live-orders.js";
import { isMint } from "../src/assets.js";
import { readAccountReadiness } from "./account-readiness.js";
import { pumpAddress } from "./copy-pumpswap.js";
import type { Rpc } from "./funding.js";
import type { TokenSetupConfig } from "../src/account-readiness.js";
import { TOKEN_2022 } from "./jupiter-routes.js";
import { verifyToken2022Account } from "./token2022-setup.js";

const COMPUTE = "ComputeBudget111111111111111111111111111111";
const MAX_RENT = 10_000_000n,
  MAX_FEE = 50_000n;
export class SetupCheckError extends Error {}
const fail = (): never => {
  throw new SetupCheckError(
    "Setup evidence changed or could not be verified. Check again.",
  );
};
type Lifetime = {
  blockhash: string;
  lastValidBlockHeight: number;
  slot: number;
};
export type PreparedAccountSetup = {
  tokenSetup?: TokenSetupConfig;
  request: SetupRequest;
  lifetime: Lifetime;
  unsigned: string;
  expiresAt: number;
  feeLamports: string;
  rentLamports: string;
  accounts: { kind: SetupKind; address: string; rentLamports: string }[];
};
const integer = (v: unknown, min = 0): v is number =>
  Number.isSafeInteger(v) && (v as number) >= min;
const amount = (v: string) => {
  if (!/^(0|[1-9]\d{0,15})$/.test(v)) return fail();
  return BigInt(v);
};
const context = (v: unknown, minSlot: number) => {
  const r = record(v),
    slot = record(r.context).slot;
  if (!integer(slot, minSlot)) return fail();
  return { value: r.value, slot };
};

// Deterministic instructions only. Setup has its own explicit selection and cost
// review. Copy permissions never authorize this operation. No signer or sender.
export async function compileAccountSetup(
  request: SetupRequest,
  lifetime: Lifetime,
  tokenSetup?: TokenSetupConfig,
) {
  if (
    tokenSetup &&
    (Object.keys(tokenSetup).sort().join() !==
      "accountSize,extensions,mintHash,program,transferFee" ||
      tokenSetup.program !== TOKEN_2022 ||
      typeof tokenSetup.transferFee !== "boolean" ||
      tokenSetup.accountSize !== (tokenSetup.transferFee ? 182 : 170) ||
      !/^[0-9a-f]{64}$/.test(tokenSetup.mintHash) ||
      !Array.isArray(tokenSetup.extensions) ||
      tokenSetup.extensions.some((k) => ![1, 18, 19].includes(k)) ||
      new Set(tokenSetup.extensions).size !== tokenSetup.extensions.length ||
      tokenSetup.extensions.includes(1) !== tokenSetup.transferFee)
  )
    return fail();
  const r = parseSetupRequest(request);
  if (
    !isMint(lifetime.blockhash) ||
    !integer(lifetime.slot, 1) ||
    !integer(lifetime.lastValidBlockHeight, 1)
  )
    return fail();
  const instructions: Instruction[] = [
    {
      programAddress: address(COMPUTE),
      data: new Uint8Array([2, 64, 13, 3, 0]),
    },
  ]; // 200,000 CU, no priority fee
  const accounts: { kind: SetupKind; address: string }[] = [];
  for (const kind of r.accounts) {
    const program =
      kind === "token" && tokenSetup ? tokenSetup.program : TOKEN_PROGRAM;
    const target =
      kind === "pump-rewards"
        ? await pumpAddress("user_volume_accumulator", [r.wallet])
        : await associated(
            r.wallet,
            kind === "usdc" ? USDC : kind === "wrapped-sol" ? WSOL : r.mint,
            program,
          );
    accounts.push({ kind, address: target });
    if (kind === "pump-rewards") {
      instructions.push({
        programAddress: address(PUMP_AMM_PROGRAM),
        accounts: [
          { address: address(r.wallet), role: 3 },
          { address: address(r.wallet), role: 0 },
          { address: address(target), role: 1 },
          { address: address(SYSTEM_PROGRAM), role: 0 },
          {
            address: address(await pumpAddress("__event_authority", [])),
            role: 0,
          },
          { address: address(PUMP_AMM_PROGRAM), role: 0 },
        ],
        data: new Uint8Array([94, 6, 202, 115, 255, 96, 232, 183]),
      });
    } else
      instructions.push({
        programAddress: address(ATA_PROGRAM),
        accounts: [
          { address: address(r.wallet), role: 3 },
          { address: address(target), role: 1 },
          { address: address(r.wallet), role: 0 },
          {
            address: address(
              kind === "usdc" ? USDC : kind === "wrapped-sol" ? WSOL : r.mint,
            ),
            role: 0,
          },
          { address: address(SYSTEM_PROGRAM), role: 0 },
          { address: address(program), role: 0 },
        ],
        data: new Uint8Array([1]),
      }); // idempotent ATA creation, no wrap/transfer/close
  }
  const tx = compileTransaction(
    appendTransactionMessageInstructions(
      instructions,
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash(lifetime.blockhash),
          lastValidBlockHeight: BigInt(lifetime.lastValidBlockHeight),
        },
        setTransactionMessageFeePayer(
          address(r.wallet),
          createTransactionMessage({ version: 0 }),
        ),
      ),
    ),
  );
  const unsigned = toBase64(new Uint8Array(getTransactionEncoder().encode(tx)));
  fromBase64(unsigned);
  return { unsigned, accounts };
}

export async function prepareAccountSetup(
  value: unknown,
  rpc: Rpc,
): Promise<PreparedAccountSetup> {
  const request = parseSetupRequest(value),
    report = await readAccountReadiness(request.wallet, request.mint, rpc);
  if (report.accounts.find((a) => a.kind === "token")?.status === "blocked")
    throw new SetupCheckError(
      "The selected token is not supported by account setup.",
    );
  const accounts = request.accounts.map((kind) => {
    const a = report.accounts.find((a) => a.kind === kind)!;
    if (a.status !== "missing")
      throw new SetupCheckError(
        "A selected account already exists or needs attention. Refresh the account check.",
      );
    return { kind, address: a.address, rentLamports: a.rentLamports };
  });
  const rent = accounts.reduce((sum, a) => sum + amount(a.rentLamports), 0n);
  if (rent <= 0n || rent > MAX_RENT) return fail();
  const latest = context(
      await rpc("getLatestBlockhash", [
        { commitment: "finalized", minContextSlot: report.slot },
      ]),
      report.slot,
    ),
    v = record(latest.value);
  const lifetime = {
    blockhash: String(v.blockhash),
    lastValidBlockHeight: v.lastValidBlockHeight as number,
    slot: latest.slot,
  };
  const { unsigned } = await compileAccountSetup(
    request,
    lifetime,
    report.tokenSetup,
  );
  const tx = getTransactionDecoder().decode(fromBase64(unsigned));
  const fee = context(
    await rpc("getFeeForMessage", [
      toBase64(new Uint8Array(tx.messageBytes)),
      { commitment: "finalized", minContextSlot: lifetime.slot },
    ]),
    lifetime.slot,
  ).value;
  if (!integer(fee, 1) || BigInt(fee) > MAX_FEE) return fail();
  if (BigInt(report.balanceLamports) < rent + BigInt(fee))
    throw new SetupCheckError(
      "This wallet does not have enough SOL for the selected accounts and network fee.",
    );
  return {
    ...(report.tokenSetup ? { tokenSetup: report.tokenSetup } : {}),
    request,
    lifetime,
    unsigned,
    accounts,
    rentLamports: String(rent),
    feeLamports: String(fee),
    expiresAt: Date.now() + 60_000,
  };
}

async function inspect(prepared: PreparedAccountSetup) {
  if (
    !integer(prepared.expiresAt) ||
    prepared.expiresAt <= Date.now() ||
    prepared.expiresAt > Date.now() + 60_000
  )
    return fail();
  const compiled = await compileAccountSetup(
    prepared.request,
    prepared.lifetime,
    prepared.tokenSetup,
  );
  if (
    compiled.unsigned !== prepared.unsigned ||
    !Array.isArray(prepared.accounts) ||
    prepared.accounts.length !== compiled.accounts.length ||
    compiled.accounts.some(
      (a, i) =>
        a.kind !== prepared.accounts[i].kind ||
        a.address !== prepared.accounts[i].address,
    )
  )
    return fail();
  const rent = prepared.accounts.reduce((sum, a) => {
    const n = amount(a.rentLamports);
    if (n <= 0n || n > 2_500_000n) return fail();
    return sum + n;
  }, 0n);
  if (
    rent !== amount(prepared.rentLamports) ||
    rent > MAX_RENT ||
    amount(prepared.feeLamports) < 1n ||
    amount(prepared.feeLamports) > MAX_FEE
  )
    return fail();
  return getCompiledTransactionMessageDecoder().decode(
    getTransactionDecoder().decode(fromBase64(prepared.unsigned)).messageBytes,
  );
}

// Require same-bank native deltas plus post-account bytes. A successful RPC
// simulation alone is not sufficient evidence of owner, amount or rent safety.
export async function verifyAccountSetupSimulation(
  prepared: PreparedAccountSetup,
  response: unknown,
): Promise<SetupCheck> {
  const message = await inspect(prepared),
    reply = context(response, prepared.lifetime.slot),
    sim = record(reply.value);
  if (
    message.version !== 0 ||
    (message.addressTableLookups?.length || 0) !== 0 ||
    message.header.numSignerAccounts !== 1 ||
    message.staticAccounts[0] !== prepared.request.wallet
  )
    return fail();
  const keys = message.staticAccounts.map(String),
    pre = sim.preBalances,
    post = sim.postBalances;
  if (
    sim.err !== null ||
    sim.replacementBlockhash != null ||
    !integer(sim.unitsConsumed, 1) ||
    sim.unitsConsumed > 200000 ||
    !integer(sim.fee, 1) ||
    String(sim.fee) !== prepared.feeLamports ||
    !Array.isArray(pre) ||
    !Array.isArray(post) ||
    pre.length !== keys.length ||
    post.length !== keys.length ||
    [...pre, ...post].some((v) => !integer(v)) ||
    !Array.isArray(sim.accounts) ||
    sim.accounts.length !== prepared.accounts.length + 1
  )
    return fail();
  const selected = new Set(prepared.accounts.map((a) => a.address));
  for (let i = 1; i < keys.length; i++)
    if (!selected.has(keys[i]) && pre[i] !== post[i]) return fail();
  const total = amount(prepared.rentLamports) + BigInt(sim.fee);
  if (BigInt(pre[0]) - BigInt(post[0]) !== total) return fail();
  const payer = record(sim.accounts[0]);
  if (
    payer.owner !== SYSTEM_PROGRAM ||
    payer.executable !== false ||
    payer.lamports !== post[0] ||
    !Array.isArray(payer.data) ||
    payer.data[0] !== "" ||
    payer.data[1] !== "base64"
  )
    return fail();
  for (const [i, expected] of prepared.accounts.entries()) {
    const n = keys.indexOf(expected.address),
      a = record(sim.accounts[i + 1]),
      size =
        expected.kind === "pump-rewards"
          ? 137
          : expected.kind === "token" && prepared.tokenSetup
            ? prepared.tokenSetup.accountSize
            : 165;
    if (
      n < 1 ||
      pre[n] !== 0 ||
      BigInt(post[n]) !== amount(expected.rentLamports) ||
      a.lamports !== post[n] ||
      a.executable !== false ||
      a.owner !==
        (expected.kind === "pump-rewards"
          ? PUMP_AMM_PROGRAM
          : expected.kind === "token" && prepared.tokenSetup
            ? TOKEN_2022
            : TOKEN_PROGRAM) ||
      !Array.isArray(a.data) ||
      a.data.length !== 2 ||
      a.data[1] !== "base64" ||
      typeof a.data[0] !== "string" ||
      a.data[0].length !== Math.ceil(size / 3) * 4
    )
      return fail();
    const b = Buffer.from(a.data[0], "base64"),
      key = (offset: number) => bs58.encode(b.subarray(offset, offset + 32));
    if (b.length !== size || b.toString("base64") !== a.data[0]) return fail();
    if (expected.kind === "token" && prepared.tokenSetup) {
      verifyToken2022Account(
        a,
        prepared.request.wallet,
        prepared.request.mint,
        prepared.tokenSetup,
        true,
      );
      continue;
    }
    if (expected.kind === "pump-rewards") {
      const disc = createHash("sha256")
        .update("account:UserVolumeAccumulator")
        .digest()
        .subarray(0, 8);
      if (
        !b.subarray(0, 8).equals(disc) ||
        key(8) !== prepared.request.wallet ||
        b.subarray(40).some((v) => v !== 0)
      )
        return fail();
    } else {
      const native = expected.kind === "wrapped-sol";
      const mint =
        expected.kind === "usdc" ? USDC : native ? WSOL : prepared.request.mint;
      if (
        key(0) !== mint ||
        key(32) !== prepared.request.wallet ||
        b.readBigUInt64LE(64) !== 0n ||
        b.readUInt32LE(72) !== 0 ||
        b[108] !== 1 ||
        b.readBigUInt64LE(121) !== 0n ||
        b.readUInt32LE(129) !== 0 ||
        b.readUInt32LE(109) !== (native ? 1 : 0) ||
        (native && b.readBigUInt64LE(113) !== BigInt(a.lamports as number))
      )
        return fail();
    }
  }
  if (prepared.expiresAt <= Date.now()) return fail();
  return {
    ...prepared.request,
    status: "simulated",
    slot: reply.slot,
    checkedAt: Date.now(),
    expiresAt: prepared.expiresAt,
    feeLamports: prepared.feeLamports,
    rentLamports: prepared.rentLamports,
    totalLamports: String(total),
    accountAddresses: prepared.accounts.map((a) => a.address),
  };
}

export async function preflightAccountSetup(
  prepared: PreparedAccountSetup,
  rpc: Rpc,
): Promise<SetupCheck> {
  // Copy caller data before awaiting. Later mutation must not change what is checked.
  const p = structuredClone(prepared);
  await inspect(p);
  const fresh = await readAccountReadiness(
    p.request.wallet,
    p.request.mint,
    rpc,
    p.lifetime.slot,
  );
  if (
    !isDeepStrictEqual(fresh.tokenSetup, p.tokenSetup) ||
    fresh.accounts.find((a) => a.kind === "token")?.status === "blocked" ||
    p.accounts.some((a) => {
      const current = fresh.accounts.find((v) => v.kind === a.kind);
      return (
        !current ||
        current.status !== "missing" ||
        current.address !== a.address ||
        current.rentLamports !== a.rentLamports
      );
    })
  )
    return fail();
  const valid = context(
    await rpc("isBlockhashValid", [
      p.lifetime.blockhash,
      { commitment: "finalized", minContextSlot: fresh.slot },
    ]),
    fresh.slot,
  );
  if (valid.value !== true || p.expiresAt <= Date.now()) return fail();
  const simulation = await rpc("simulateTransaction", [
    p.unsigned,
    {
      encoding: "base64",
      sigVerify: false,
      replaceRecentBlockhash: false,
      commitment: "finalized",
      minContextSlot: valid.slot,
      accounts: {
        encoding: "base64",
        addresses: [p.request.wallet, ...p.accounts.map((a) => a.address)],
      },
    },
  ]);
  if (context(simulation, valid.slot).slot < valid.slot) return fail();
  return verifyAccountSetupSimulation(p, simulation);
}
