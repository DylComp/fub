import { createHash } from "node:crypto";
import { address, getProgramDerivedAddress } from "@solana/kit";
import bs58 from "bs58";
import {
  PUMP_AMM_PROGRAM,
  PUMP_FEE_PROGRAM,
  SYSTEM_PROGRAM,
} from "../src/copy-pumpswap.js";
import type { SwapInstruction } from "../src/copy-swap.js";
import { TOKEN_PROGRAM, WSOL } from "../src/funding-model.js";
import { associated } from "../src/transaction-review.js";
import { record } from "../src/live-orders.js";
import type { Rpc } from "./funding.js";

const invalid = (): never => {
  throw new Error(
    "PumpSwap pool, fee or reward account evidence is unsupported or inconsistent.",
  );
};
const disc = (name: string) =>
  createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
const key = (b: Buffer, offset: number) =>
  bs58.encode(b.subarray(offset, offset + 32));
export async function pumpAddress(
  seed: string,
  keys: string[] = [],
  program = PUMP_AMM_PROGRAM,
) {
  return (
    await getProgramDerivedAddress({
      programAddress: address(program),
      seeds: [Buffer.from(seed), ...keys.map((k) => bs58.decode(k))],
    })
  )[0];
}

// Layouts pinned in docs/pumpswap-execution.md. This first execution subset
// excludes cashback, mayhem, boosted reserves, holder rewards and custom fees.
// Legacy routes require an existing tracker. Native callers may collect missing
// trackers for independently simulated, rent-bounded CPI creation.
export async function verifyPumpSegments(
  segments: SwapInstruction["accounts"][],
  wallet: string,
  rpc: Rpc,
  minContextSlot: number,
  missingUserTrackers?: Set<string>,
  v4?: { buy: boolean; poolBefore?: Buffer; feeOwner?: string },
) {
  if (!segments.length) return minContextSlot;
  if (v4 && (segments.length !== 1 || typeof v4.buy !== "boolean")) return invalid();
  if (!Number.isSafeInteger(minContextSlot) || minContextSlot < 1)
    return invalid();
  const addresses = [
    ...new Set(
      segments.flatMap((a) => {
        if(v4) {
          if(a.length!==19) return invalid();
          return [1,3,4,5,8,9,13,14,15].map(i=>a[i].pubkey);
        }
        const buy = a.length === 28,
          shift = buy ? 2 : 0;
        return [
          1,
          3,
          4,
          5,
          8,
          9,
          11,
          18,
          20 + shift,
          ...(buy ? [20, 21] : []),
          25 + shift,
        ].map((i) => a[i].pubkey);
      }),
    ),
  ];
  if (addresses.length > 100) return invalid();
  const result = record(
    await rpc("getMultipleAccounts", [
      addresses,
      { encoding: "base64", commitment: "finalized", minContextSlot },
    ]),
  );
  const slot = record(result.context).slot;
  if (
    !Number.isSafeInteger(slot) ||
    (slot as number) < minContextSlot ||
    !Array.isArray(result.value) ||
    result.value.length !== addresses.length
  )
    return invalid();
  const values = new Map(
    addresses.map((a, i) => [a, (result.value as unknown[])[i]]),
  );
  function bytes(k: string, owner: string, length: number) {
    const raw = values.get(k);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid();
    const v = record(raw),
      d = v.data;
    if (
      v.owner !== owner ||
      v.executable !== false ||
      !Number.isSafeInteger(v.lamports) ||
      (v.lamports as number) <= 0 ||
      !Array.isArray(d) ||
      d.length !== 2 ||
      d[1] !== "base64" ||
      typeof d[0] !== "string" ||
      d[0].length !== Math.ceil(length / 3) * 4
    )
      return invalid();
    const b = Buffer.from(d[0], "base64");
    if (b.length !== length || b.toString("base64") !== d[0]) return invalid();
    return b;
  }
  function state(
    k: string,
    name: string,
    length: number,
    owner = PUMP_AMM_PROGRAM,
  ) {
    const b = bytes(k, owner, length);
    if (!b.subarray(0, 8).equals(disc(name))) return invalid();
    return b;
  }
  async function vault(k: string, mint: string, owner: string) {
    if ((await associated(owner, mint)) !== k) return invalid();
    const b = bytes(k, TOKEN_PROGRAM, 165);
    if (
      key(b, 0) !== mint ||
      key(b, 32) !== owner ||
      b[108] !== 1 ||
      b.readUInt32LE(72) !== 0 ||
      b.readUInt32LE(129) !== 0 ||
      b.readBigUInt64LE(121) !== 0n
    )
      return invalid();
    if (
      mint === WSOL &&
      (b.readUInt32LE(109) !== 1 ||
        BigInt(record(values.get(k)).lamports as number) <
          b.readBigUInt64LE(113) + b.readBigUInt64LE(64))
    )
      return invalid();
  }
  for (const a of segments) {
    const buy = v4 ? v4.buy : a.length === 28,
      shift = buy ? 2 : 0;
    if (a.length !== (v4 ? 19 : 26 + shift)) return invalid();
    const pool = state(a[1].pubkey, "Pool", 301),
      config = state(a[3].pubkey, "GlobalConfig", 949);
    const base = key(pool, 43),
      quote = key(pool, 75),
      creator = key(pool, 211);
    const [poolPda, bump] = await getProgramDerivedAddress({
      programAddress: address(PUMP_AMM_PROGRAM),
      seeds: [
        Buffer.from("pool"),
        pool.subarray(9, 11),
        pool.subarray(11, 43),
        pool.subarray(43, 75),
        pool.subarray(75, 107),
      ],
    });
    if (
      poolPda !== a[1].pubkey ||
      bump !== pool[8] ||
      base !== a[4].pubkey ||
      quote !== a[5].pubkey ||
      quote !== WSOL ||
      base === quote ||
      creator === SYSTEM_PROGRAM ||
      key(pool, 139) !== a[8].pubkey ||
      key(pool, 171) !== a[9].pubkey ||
      (v4 ? (pool.subarray(243,245).some(v=>v!==0)||pool.subarray(261,271).some(v=>v!==0)||pool.subarray(287).some(v=>v!==0)) : pool.subarray(243).some((v) => v !== 0)) ||
      (config[56] & (buy ? 8 : 16)) !== 0 ||
      config[56] > 31
    )
      return invalid();
    if (
      (await pumpAddress("global_config")) !== a[3].pubkey ||
      (await pumpAddress("pool_lp_mint", [a[1].pubkey])) !== key(pool, 107) ||
      (!v4 && ((await pumpAddress("creator_vault", [creator])) !== a[19].pubkey ||
      (await pumpAddress("pool-v2", [base])) !== a[23 + shift].pubkey)) ||
      (await pumpAddress(
        "fee_config",
        [PUMP_AMM_PROGRAM],
        PUMP_FEE_PROGRAM,
      )) !== a[v4 ? 14 : 20 + shift].pubkey
    )
      return invalid();
    const protocol = Array.from({ length: 8 }, (_, i) =>
      key(config, 57 + i * 32),
    );
    const buyback = Array.from({ length: 8 }, (_, i) =>
      key(config, 643 + i * 32),
    );
    const buybackOwner = v4 ? key(bytes(a[15].pubkey,TOKEN_PROGRAM,165),32) : a[24+shift].pubkey;
    if (
      (!v4 && !protocol.includes(a[10].pubkey)) ||
      !buyback.includes(buybackOwner) || buybackOwner===SYSTEM_PROGRAM
    )
      return invalid();
    for (const mint of [base, quote]) {
      const m = bytes(mint, TOKEN_PROGRAM, 82);
      if (m[45] !== 1 || m[44] > 18) return invalid();
    }
    // FeeConfig is a variable-length schedule with reserved capacity. We bind
    // its PDA, program owner and discriminator, leaving pricing to the quote's
    // exact-input/minimum-output contract and the simulated wallet deltas.
    state(a[v4 ? 14 : 20 + shift].pubkey, "FeeConfig", 4097, PUMP_FEE_PROGRAM);
    if(v4) {
      await Promise.all([vault(a[8].pubkey,base,a[1].pubkey),vault(a[9].pubkey,quote,a[1].pubkey),vault(a[15].pubkey,quote,buybackOwner)]);
      const quoteVault=bytes(a[9].pubkey,TOKEN_PROGRAM,165);
      const buckets=pool.readBigUInt64LE(271)+pool.readBigUInt64LE(279);
      const virtual=pool.readBigUInt64LE(245)+(pool.readBigInt64LE(253)<<64n);
      // V2 removes retained fees from pricing via negative virtual reserves.
      // Requiring a zero net offset excludes positively boosted liquidity.
      if(virtual+buckets!==0n||buckets>quoteVault.readBigUInt64LE(64)) return invalid();
      if((await pumpAddress("user_volume_accumulator",[wallet]))!==a[13].pubkey) return invalid();
      if(values.get(a[13].pubkey)===null && missingUserTrackers) missingUserTrackers.add(a[13].pubkey);
      else {
        const user=state(a[13].pubkey,"UserVolumeAccumulator",137);
        if(key(user,8)!==wallet||user[40]>1||user[73]>1) return invalid();
      }
      v4.poolBefore=pool; v4.feeOwner=buybackOwner;
      continue;
    }
    await Promise.all([
      vault(a[8].pubkey, base, a[1].pubkey),
      vault(a[9].pubkey, quote, a[1].pubkey),
      vault(a[11].pubkey, quote, a[10].pubkey),
      vault(a[18].pubkey, quote, a[19].pubkey),
      vault(a[25 + shift].pubkey, quote, a[24 + shift].pubkey),
    ]);
    if (buy) {
      if (
        (await pumpAddress("global_volume_accumulator")) !== a[20].pubkey ||
        (await pumpAddress("user_volume_accumulator", [wallet])) !==
          a[21].pubkey
      )
        return invalid();
      state(a[20].pubkey, "GlobalVolumeAccumulator", 600);
      if(values.get(a[21].pubkey)===null && missingUserTrackers) {
        missingUserTrackers.add(a[21].pubkey);
      } else {
        const user = state(a[21].pubkey, "UserVolumeAccumulator", 137);
        if (key(user, 8) !== wallet || user[40] > 1 || user[73] > 1) return invalid();
      }
    }
  }
  return slot as number;
}
