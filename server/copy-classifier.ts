import {PUMP_CURVE,observePumpCurve} from './pump-curve-observation.js';
import bs58 from "bs58";
import { isMint } from "../src/assets.js";
import { TOKEN_PROGRAM, USDC, WSOL } from "../src/funding-model.js";
import { record } from "../src/live-orders.js";
import type { FeedDecision, LeaderSignature } from "../src/copy-feed.js";
import { leaderFormatEvidence } from "./copy-format.js";
import { DFLOW, decodeDflowRoute } from "./dflow-routes.js";
import { PUMPSWAP, decodePumpSwapRoute } from "./pumpswap-routes.js";

import {
  decodeJupiterRoute,
  JUPITER_V6,
  TOKEN_2022,
  supportedTokenProgram,
} from "./jupiter-routes.js";
import { nativeLifecycle, parsedAta, parsedInfo, ATA } from "./copy-native.js";
import { separateNativeTransfers } from "./copy-native-transfers.js";
export { JUPITER_V6 } from "./jupiter-routes.js";
const COMPUTE = "ComputeBudget111111111111111111111111111111";
export class MissingEvidence extends Error {}
const bad = () => {
  throw new MissingEvidence(
    "Transaction evidence is incomplete or inconsistent.",
  );
};
const ignored = (reason: string): FeedDecision => ({ kind: "ignored", reason });
function raw(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > 18446744073709551615n
  )
    return bad();
  return BigInt(value);
}
export function signatureValid(value: unknown): value is string {
  try {
    return (
      typeof value === "string" &&
      /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value) &&
      bs58.decode(value).length === 64
    );
  } catch {
    return false;
  }
}
export function parseLeaderSignatures(
  value: unknown,
  limit: number,
): LeaderSignature[] {
  if (!Array.isArray(value) || value.length > limit) return bad();
  const seen = new Set<string>();
  let lastSlot = Number.MAX_SAFE_INTEGER;
  return value.map((entry) => {
    const row = record(entry);
    if (
      !signatureValid(row.signature) ||
      !Number.isSafeInteger(row.slot) ||
      (row.slot as number) < 0 ||
      (row.slot as number) > lastSlot ||
      seen.has(row.signature) ||
      row.confirmationStatus !== "finalized" ||
      !("err" in row) ||
      (row.blockTime !== null &&
        (!Number.isSafeInteger(row.blockTime) || (row.blockTime as number) < 0))
    )
      return bad();
    seen.add(row.signature);
    lastSlot = row.slot as number;
    return {
      signature: row.signature,
      slot: row.slot as number,
      blockTime: row.blockTime as number | null,
      failed: row.err !== null,
    };
  });
}
type Balance = {
  owner: string;
  mint: string;
  amount: bigint;
  decimals: number;
  program: string;
};
export function classifyLeaderSwap(
  value: unknown,
  leader: string,
  expected: LeaderSignature,
): FeedDecision {
  if (!isMint(leader) || !signatureValid(expected.signature)) return bad();
  const body = record(value),
    tx = record(body.transaction),
    message = record(tx.message),
    meta = record(body.meta);
  if (
    body.slot !== expected.slot ||
    body.blockTime !== expected.blockTime ||
    !Array.isArray(tx.signatures) ||
    tx.signatures[0] !== expected.signature ||
    !Array.isArray(message.accountKeys) ||
    !Array.isArray(message.instructions) ||
    !("err" in meta)
  )
    return bad();
  if ((meta.err !== null) !== expected.failed) return bad();
  const format = leaderFormatEvidence(body);
  if (meta.err !== null) return ignored("Transaction failed.");
  const keys = message.accountKeys.map((value) => record(value));
  if (
    keys.length > 256 ||
    new Set(keys.map((k) => k.pubkey)).size !== keys.length ||
    keys.some((k) => !isMint(String(k.pubkey)) || typeof k.signer !== "boolean")
  )
    return bad();
  if (!keys.some((k) => k.pubkey === leader && k.signer))
    return ignored("The leader did not sign this transaction.");
  if (expected.blockTime === null)
    return ignored("Transaction time is unavailable.");
  const instructions = message.instructions.map(record);
  if(instructions.some(ix=>ix.programId===PUMP_CURVE)){
    const decision=observePumpCurve(instructions,keys.map(k=>String(k.pubkey)),meta,leader);
    return decision.kind==="swap"?{...decision,...format}:decision;
  }
  const routes = instructions
    .map((ix, index) => ({ ix, index }))
    .filter(({ ix }) => [JUPITER_V6, DFLOW, PUMPSWAP].includes(String(ix.programId)));
  if (routes.length !== 1) return ignored("No single supported swap route.");
  const { ix, index } = routes[0];
  const pump = ix.programId === PUMPSWAP ? decodePumpSwapRoute(ix) : null;
  let route = pump || decodeJupiterRoute(ix);
  const dflow = ix.programId === DFLOW ? decodeDflowRoute(ix) : null;
  if (!route && !dflow) return ignored("Unsupported swap instruction.");
  if ((route || dflow)!.authority !== leader)
    return ignored("Unsupported route authority.");
  function balances(value: unknown) {
    if (!Array.isArray(value)) return bad();
    const rows = new Map<string, Balance>();
    for (const v of value) {
      const r = record(v),
        amount = record(r.uiTokenAmount),
        n = r.accountIndex;
      if (
        !Number.isInteger(n) ||
        (n as number) < 0 ||
        (n as number) >= keys.length
      )
        return bad();
      const account = String(keys[n as number].pubkey);
      if (
        rows.has(account) ||
        !isMint(String(r.owner)) ||
        !isMint(String(r.mint)) ||
        !Number.isInteger(amount.decimals) ||
        (amount.decimals as number) < 0 ||
        (amount.decimals as number) > 255
      )
        return bad();
      rows.set(account, {
        owner: String(r.owner),
        mint: String(r.mint),
        amount: raw(amount.amount),
        decimals: amount.decimals as number,
        program: String(r.programId),
      });
    }
    return rows;
  }
  const pre = balances(meta.preTokenBalances),
    post = balances(meta.postTokenBalances);
  // Some Fomo transactions add a separate USDC transfer after the swap. Keep
  // that exact observed debit separate; its recipient is not a verified fee
  // collector, and this transfer must never become a copy instruction.
  const separate = new Map<number, { source: string; amount: bigint }>();
  for (const [n, other] of instructions.entries()) {
    if (n <= index || other.programId !== TOKEN_PROGRAM) continue;
    if (!other.parsed) continue;
    const parsed = record(other.parsed);
    if (parsed.type !== "transferChecked") continue;
    const info = record(parsed.info),
      amount = record(info.tokenAmount);
    if (
      info.authority !== leader ||
      info.mint !== USDC ||
      amount.decimals !== 6 ||
      typeof info.source !== "string" ||
      typeof info.destination !== "string" ||
      info.source === info.destination
    )
      continue;
    const from = pre.get(info.source),
      to = post.get(info.destination);
    if (
      from?.owner !== leader ||
      from.mint !== USDC ||
      from.program !== TOKEN_PROGRAM ||
      from.decimals !== 6 ||
      !to ||
      to.owner === leader ||
      pre.get(info.destination)?.owner === leader ||
      to.mint !== USDC ||
      to.program !== TOKEN_PROGRAM ||
      to.decimals !== 6
    )
      continue;
    const units = raw(amount.amount);
    if (units > 0n) separate.set(n, { source: info.source, amount: units });
  }
  if (separate.size > 4) return ignored("Too many separate quote transfers.");
  const separateFor = (account: string) =>
    [...separate.values()]
      .filter((t) => t.source === account)
      .reduce((sum, t) => sum + t.amount, 0n);
  if (dflow) {
    const changed = [...new Set([...pre.keys(), ...post.keys()])].flatMap(
      (account) => {
        const p = pre.get(account),
          q = post.get(account);
        if (p?.owner !== leader && q?.owner !== leader) return [];
        const delta =
          (q?.amount || 0n) - (p?.amount || 0n) + separateFor(account);
        return delta ? [{ account, delta, token: q || p! }] : [];
      },
    );
    const input = changed.find((t) => t.delta < 0n),
      output = changed.find((t) => t.delta > 0n);
    if (
      changed.length !== 2 ||
      !input ||
      !output ||
      !dflow.accounts.includes(input.account) ||
      !dflow.accounts.includes(output.account) ||
      (dflow.destination &&
        (dflow.destination !== output.account ||
          dflow.destinationAuthority !== leader ||
          dflow.outputMint !== output.token.mint))
    )
      return ignored(
        "DFlow endpoints cannot be established from wallet balances.",
      );
    route = {
      name: dflow.name,
      authority: dflow.authority,
      source: input.account,
      destination: output.account,
      inputMint: input.token.mint,
      outputMint: output.token.mint,
      inputProgram: input.token.program,
      outputProgram: output.token.program,
      token2022: undefined,
    };
  }
  if (!route) return ignored("Swap endpoints are unavailable.");
  const { source, destination } = route;
  if (!isMint(source) || !isMint(destination) || source === destination)
    return bad();
  function routeToken(
    account: string,
    side: "input" | "output",
  ): Balance | undefined {
    const found = side === "input" ? pre.get(account) : post.get(account);
    if (found) return found;
    const existing = pre.get(account) || post.get(account);
    if (existing?.mint === WSOL) return existing;
    const setup = instructions
      .map(parsedAta)
      .find((ata) => ata?.account === account);
    if (
      setup?.mint === WSOL &&
      setup.owner === leader &&
      setup.program === TOKEN_PROGRAM
    )
      return {
        owner: leader,
        mint: WSOL,
        amount: 0n,
        decimals: 9,
        program: TOKEN_PROGRAM,
      };
    return undefined;
  }
  const input = routeToken(source, "input"),
    output = routeToken(destination, "output");
  if (!input || !output || input.owner !== leader || output.owner !== leader)
    return ignored("Route token ownership cannot be established.");
  if (
    !supportedTokenProgram(input.program) ||
    !supportedTokenProgram(output.program) ||
    input.decimals > 18 ||
    output.decimals > 18
  )
    return ignored("Unsupported token program or precision.");
  if (
    route.outputMint !== output.mint ||
    (route.inputMint && route.inputMint !== input.mint)
  )
    return bad();
  if (route.outputProgram) {
    if (
      route.inputProgram !== input.program ||
      route.outputProgram !== output.program
    )
      return bad();
  } else if (
    route.inputProgram !== TOKEN_PROGRAM ||
    ([input, output].some((t) => t.program === TOKEN_2022) &&
      route.token2022 !== TOKEN_2022)
  )
    return ignored("Unsupported token program for this route.");
  const native = new Map<
    string,
    NonNullable<ReturnType<typeof nativeLifecycle>>
  >();
  for (const [account, token] of [
    [source, input],
    [destination, output],
  ] as const) {
    if (token.mint !== WSOL) continue;
    const hasLifecycle = instructions.some((other) => {
      const i = parsedInfo(other).info;
      return i.account === account || i.destination === account;
    });
    if (!hasLifecycle && pre.has(account) && post.has(account)) continue;
    const lifecycle = nativeLifecycle({
      account,
      leader,
      routeIndex: index,
      instructions,
      pre: pre.get(account),
      post: post.get(account),
      keys,
      meta,
    });
    if (!lifecycle)
      return ignored("Native SOL setup or return could not be verified.");
    native.set(account, lifecycle);
  }
  const nativeTransfers = separateNativeTransfers({
    leader, instructions, keys, meta,
    excluded: new Set([source, destination, ...pre.keys(), ...post.keys()]),
  });
  // Separately reconciled payments are observed but never copied or sized as trades.
  for (const [otherIndex, other] of instructions.entries()) {
    if (
      other === ix ||
      other.programId === COMPUTE ||
      nativeTransfers.has(otherIndex) ||
      (separate.has(otherIndex) &&
        [source, destination].includes(separate.get(otherIndex)!.source)) ||
      [...native.values()].some((n) => n.allowed.has(otherIndex))
    )
      continue;
    const setup = parsedAta(other);
    const token =
      setup?.account === source
        ? input
        : setup?.account === destination
          ? output
          : undefined;
    if (
      setup &&
      token &&
      otherIndex < index &&
      setup.owner === leader &&
      setup.mint === token.mint &&
      setup.program === token.program
    )
      continue;
    if (other.programId === ATA && Array.isArray(other.accounts)) {
      let bytes: Uint8Array;
      try {
        bytes = bs58.decode(String(other.data));
      } catch {
        return bad();
      }
      const a = other.accounts;
      if (
        (bytes.length === 0 || (bytes.length === 1 && bytes[0] === 1)) &&
        otherIndex < index &&
        a[1] === destination &&
        a[2] === leader &&
        a[3] === output.mint &&
        a[5] === output.program
      )
        continue;
    }
    return ignored("Mixed instructions require a separate decoder.");
  }
  const owned = new Map<string, Balance>(),
    deltas = new Map<string, bigint>(),
    before = new Map<string, bigint>();
  for (const account of new Set([...pre.keys(), ...post.keys()])) {
    const p = pre.get(account),
      q = post.get(account);
    if (p?.owner !== leader && q?.owner !== leader) continue;
    if (
      p &&
      q &&
      (p.owner !== q.owner ||
        p.mint !== q.mint ||
        p.decimals !== q.decimals ||
        p.program !== q.program)
    )
      return ignored("Token ownership or precision changed.");
    const token = q || p!;
    if (!supportedTokenProgram(token.program))
      return ignored("Unsupported token program.");
    if (
      [...owned.values()].some(
        (t) => t.mint === token.mint && t.decimals !== token.decimals,
      )
    )
      return bad();
    owned.set(account, token);
    deltas.set(
      token.mint,
      (deltas.get(token.mint) || 0n) + (q?.amount || 0n) - (p?.amount || 0n),
    );
    before.set(token.mint, (before.get(token.mint) || 0n) + (p?.amount || 0n));
  }
  for (const [account, token] of [
    [source, input],
    [destination, output],
  ] as const)
    if (!owned.has(account)) owned.set(account, token);
  // Swap transfers must originate inside this invocation, not another route.
  if (!Array.isArray(meta.innerInstructions)) return bad();
  const groups = meta.innerInstructions
    .map(record)
    .filter((g) => g.index === index);
  if (groups.length !== 1 || !Array.isArray(groups[0].instructions))
    return bad();
  const flows = new Map<string, bigint>();
  for (const value of groups[0].instructions) {
    const inner = record(value);
    if (!supportedTokenProgram(String(inner.programId))) continue;
    const parsed = record(inner.parsed),
      info = record(parsed.info);
    if (!["transfer", "transferChecked"].includes(String(parsed.type))) {
      if (
        Object.values(info).some((v) => typeof v === "string" && owned.has(v))
      )
        return ignored("Unsupported token mutation inside the route.");
      continue;
    }
    const from = owned.get(String(info.source)),
      to = owned.get(String(info.destination));
    if (!from && !to) continue;
    if (
      (from && from.program !== inner.programId) ||
      (to && to.program !== inner.programId)
    )
      return bad();
    if (inner.programId === TOKEN_2022 && parsed.type !== "transferChecked")
      return ignored("Unsupported Token 2022 transfer instruction.");
    const units = raw(
      parsed.type === "transferChecked"
        ? record(info.tokenAmount).amount
        : info.amount,
    );
    for (const [account, token, sign] of [
      [info.source, from, -1n],
      [info.destination, to, 1n],
    ] as const) {
      if (!token) continue;
      if (
        parsed.type === "transferChecked" &&
        (info.mint !== token.mint ||
          record(info.tokenAmount).decimals !== token.decimals)
      )
        return bad();
      flows.set(
        String(account),
        (flows.get(String(account)) || 0n) + sign * units,
      );
    }
  }
  for (const account of owned.keys()) {
    const flow = flows.get(account) || 0n,
      lifecycle = native.get(account);
    if (lifecycle) {
      const remaining = lifecycle.before + lifecycle.deposits + flow;
      if (
        remaining < 0n ||
        remaining > 18446744073709551615n ||
        (!lifecycle.closed && remaining !== lifecycle.postAmount)
      )
        return ignored("Native SOL flows do not match the wrapping lifecycle.");
    } else if (
      flow - separateFor(account) !==
      (post.get(account)?.amount || 0n) - (pre.get(account)?.amount || 0n)
    )
      return ignored(
        "Route transfers do not explain the wallet balance changes. Transfer-fee tokens require separate verification.",
      );
  }
  // Use the native route flow, not the wallet SOL delta (which also includes rent and fees).
  if (native.size) {
    deltas.set(
      WSOL,
      [...owned]
        .filter(([, t]) => t.mint === WSOL)
        .reduce((sum, [a]) => sum + (flows.get(a) || 0n), 0n),
    );
  }
  const separateQuoteTransferRaw = [...separate.values()].reduce(
    (sum, t) => sum + t.amount,
    0n,
  );
  if (separateQuoteTransferRaw)
    deltas.set(USDC, (deltas.get(USDC) || 0n) + separateQuoteTransferRaw);
  const changes = [...deltas].filter(([, n]) => n !== 0n);
  if (
    changes.length !== 2 ||
    !(deltas.get(input.mint)! < 0n) ||
    !(deltas.get(output.mint)! > 0n)
  )
    return ignored("The route is not one token exchanged for another.");
  const inputQuote = [USDC, WSOL].includes(input.mint),
    outputQuote = [USDC, WSOL].includes(output.mint);
  if (inputQuote === outputQuote)
    return ignored(
      "Only SOL, wrapped SOL or USDC against a spot token is supported.",
    );
  const token = inputQuote ? output : input,
    quote = inputQuote ? input : output;
  if (
    (quote.mint === USDC && quote.decimals !== 6) ||
    (quote.mint === WSOL && quote.decimals !== 9)
  )
    return bad();
  const absolute = (n: bigint) => (n < 0n ? -n : n);
  const separateNativeTransferLamports = [...nativeTransfers.values()].reduce(
    (sum, amount) => sum + amount, 0n,
  );
  if (pump && !pump.accepts(-deltas.get(input.mint)!, deltas.get(output.mint)!))
    return ignored("PumpSwap amounts do not match the instruction limits.");
  return {
    kind: "swap",
    tokenProgram: token.program,
    quoteMode:
      quote.mint === WSOL && [...native.values()].some((n) => n.native)
        ? "native"
        : "token",
    route: route.name,
    decoderVersion: nativeTransfers.size ? 6 : pump ? 5 : dflow || separate.size ? 4 : format ? 3 : 2,
    ...(separateNativeTransferLamports
      ? { separateNativeTransferLamports: String(separateNativeTransferLamports) }
      : {}),
    ...(separateQuoteTransferRaw
      ? { separateQuoteTransferRaw: String(separateQuoteTransferRaw) }
      : {}),
    ...format,
    side: inputQuote ? "buy" : "sell",
    mint: token.mint,
    quoteMint: quote.mint,
    tokenRaw: String(absolute(deltas.get(token.mint)!)),
    quoteRaw: String(absolute(deltas.get(quote.mint)!)),
    tokenDecimals: token.decimals,
    quoteDecimals: quote.decimals,
    leaderTokenBeforeRaw: String(before.get(token.mint) || 0n),
  };
}
