import { address, getProgramDerivedAddress } from "@solana/kit";
import { isMint } from "./assets.js";
import { record } from "./live-orders.js";
import { TOKEN_PROGRAM, USDC, WSOL } from "./funding-model.js";
import { associated, ATA_PROGRAM } from "./transaction-review.js";
import { PUMP_AMM_PROGRAM, checkPumpSegment } from "./copy-pumpswap.js";
import layouts from "../docs/jupiter-swap-layouts.json" with { type: "json" };

export const COPY_SWAP_PROGRAM = layouts.program;
export const COMPUTE_PROGRAM = "ComputeBudget111111111111111111111111111111";
export const COPY_COMPUTE_UNITS = 1_400_000;
export const WHIRLPOOL_PROGRAM = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
export type CopyWhirlpool = {
  pool: string;
  inputMint: string;
  outputMint: string;
  aToB: boolean;
};
export type CopySwapIntent = {
  wallet: string;
  inputMint: string;
  outputMint: string;
  inputRaw: string;
  minOutputRaw: string;
  slippageBps: number;
  maxNetworkFeeLamports: string;
  expiresAt: number;
};
export type SwapInstruction = {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
};
export function swapRaw(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d{0,19}$/.test(value) ||
    BigInt(value) > 18446744073709551615n
  )
    throw new Error("Invalid swap amount.");
  return BigInt(value);
}
export function validateSwapIntent(intent: CopySwapIntent, now = Date.now()) {
  if (
    ![intent.wallet, intent.inputMint, intent.outputMint].every(isMint) ||
    intent.inputMint === intent.outputMint ||
    ![intent.inputMint, intent.outputMint].includes(USDC) ||
    [intent.inputMint, intent.outputMint].includes(WSOL) ||
    !Number.isInteger(intent.slippageBps) ||
    intent.slippageBps < 10 ||
    intent.slippageBps > 500 ||
    !Number.isSafeInteger(intent.expiresAt) ||
    intent.expiresAt <= now ||
    intent.expiresAt > now + 30_000
  )
    throw new Error("Invalid or expired copy swap intent.");
  swapRaw(intent.inputRaw);
  swapRaw(intent.minOutputRaw);
  if (swapRaw(intent.maxNetworkFeeLamports) > 5_000_000n)
    throw new Error("Copy network fee cap is too high.");
}
export function instructionBytes(value: unknown): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length > 1644 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new Error("Invalid swap instruction encoding.");
  const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  if (btoa(String.fromCharCode(...bytes)) !== value)
    throw new Error("Noncanonical swap instruction.");
  return bytes;
}
export function swapInstruction(
  value: unknown,
  wallet: string,
): SwapInstruction {
  const ix = record(value);
  if (
    typeof ix.programId !== "string" ||
    !isMint(ix.programId) ||
    !Array.isArray(ix.accounts) ||
    ix.accounts.length > 128
  )
    throw new Error("Invalid swap instruction accounts.");
  instructionBytes(ix.data);
  for (const entry of ix.accounts) {
    const a = record(entry);
    if (
      typeof a.pubkey !== "string" ||
      !isMint(a.pubkey) ||
      typeof a.isSigner !== "boolean" ||
      typeof a.isWritable !== "boolean" ||
      (a.isSigner && a.pubkey !== wallet)
    )
      throw new Error("Unexpected swap signer or account.");
  }
  const data = instructionBytes(ix.data);
  const direct = layouts.instructions[1].discriminator.every(
    (b, i) => data[i] === b,
  );
  const permissions = new Map<string, string>();
  for (const entry of ix.accounts) {
    const a = record(entry),
      key = a.pubkey as string,
      role = `${a.isSigner}:${a.isWritable}`;
    if (
      ix.programId === COPY_SWAP_PROGRAM &&
      permissions.has(key) &&
      permissions.get(key) !== role &&
      // Direct routes repeat the transfer authority. The exact segment validator
      // below limits writable/signing repetitions to reviewed PumpSwap positions.
      !(direct && key === wallet)
    )
      throw new Error("Conflicting swap account permissions.");
    permissions.set(key, role);
  }
  return ix as unknown as SwapInstruction;
}

// Every payload is decoded before advancing to its weight and node indexes.
// Hooks and extra account slices remain unsupported, including on known DEXes.
export function decodeCopyRoute(data: Uint8Array) {
  const shared = layouts.instructions[0].discriminator.every(
    (b, i) => data[i] === b,
  );
  const direct = layouts.instructions[1].discriminator.every(
    (b, i) => data[i] === b,
  );
  // route_v2 omits the shared authority's one-byte id. Every subsequent field
  // moves by one byte; never interpret one layout using the other's offsets.
  const shift = shared ? 1 : 0;
  const header = 34 + shift;
  if ((!shared && !direct) || data.length < header)
    throw new Error("Unsupported Jupiter swap instruction.");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = view.getUint32(30 + shift, true);
  if (count < 1 || count > 8 || data.length > header + 8 * 11)
    throw new Error("Invalid Jupiter route length.");
  let cursor = header;
  const take = (length: number) => {
    if (cursor + length > data.length)
      throw new Error("Truncated Jupiter route payload.");
    const offset = cursor;
    cursor += length;
    return offset;
  };
  const boolean = () => {
    const value = data[take(1)];
    if (value > 1) throw new Error("Invalid Jupiter route boolean.");
    return value === 1;
  };
  const noRemaining = () => {
    if (view.getUint32(take(4), true) !== 0)
      throw new Error("Extra Jupiter route accounts are unsupported.");
  };
  const steps = Array.from({ length: count }, () => {
    const variant = data[take(1)];
    if (!layouts.swaps.some((s) => s.index === variant))
      throw new Error("Unsupported Jupiter swap variant.");
    let aToB: boolean | undefined;
    if (variant === 17 || variant === 47) aToB = boolean();
    if (variant === 47 && boolean()) noRemaining();
    if (variant === 75) noRemaining();
    if ((variant === 193 || variant === 194) && boolean())
      throw new Error("PumpSwap volume account closure is unsupported.");
    const offset = take(4);
    const step = {
      variant,
      ...(aToB === undefined ? {} : { aToB }),
      bps: view.getUint16(offset, true),
      input: data[offset + 2],
      output: data[offset + 3],
    };
    if (
      step.bps < 1 ||
      step.bps > 10000 ||
      step.input >= step.output ||
      step.output > 8
    )
      throw new Error("Unsupported or cyclic Jupiter route.");
    return step;
  });
  if (cursor !== data.length) throw new Error("Trailing Jupiter route bytes.");
  const seen = new Set([0]),
    outgoing = new Map<number, number>();
  for (const step of steps) {
    if (!seen.has(step.input)) throw new Error("Disconnected Jupiter route.");
    seen.add(step.output);
    outgoing.set(step.input, (outgoing.get(step.input) || 0) + step.bps);
  }
  const terminal = Math.max(...seen);
  for (const node of seen) {
    if (node !== terminal && outgoing.get(node) !== 10000)
      throw new Error("Jupiter route does not allocate its full input.");
  }
  if (direct && seen.size > 3)
    throw new Error(
      "Direct copy routes support at most one intermediate wallet account.",
    );
  if (view.getUint16(26 + shift, true) || view.getUint16(28 + shift, true))
    throw new Error("Unexpected Jupiter platform or surplus fee.");
  return {
    kind: shared ? ("shared" as const) : ("direct" as const),
    id: shared ? data[8] : 0,
    input: view.getBigUint64(8 + shift, true),
    output: view.getBigUint64(16 + shift, true),
    slippageBps: view.getUint16(24 + shift, true),
    steps,
    terminal,
    intermediateNode: direct
      ? [...seen].find((n) => n !== 0 && n !== terminal)
      : undefined,
  };
}

export const RAYDIUM_CLMM_PROGRAM =
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";

// Pinned RaydiumClmm (26) and PumpSwap (99/100) CPI layouts. Direct routes
// expose the wallet authority, so require the entire account sequence.
export function directCopySegments(
  swap: SwapInstruction,
  intermediate?: string,
) {
  const route = decodeCopyRoute(instructionBytes(swap.data));
  if (route.kind !== "direct") return [];
  if (route.steps.some((s) => ![26, 99, 100].includes(s.variant)))
    throw new Error("Direct copy exchange layout has not been verified.");
  const nodes = new Map([
    [0, swap.accounts[1].pubkey],
    [route.terminal, swap.accounts[2].pubkey],
  ]);
  if (route.intermediateNode !== undefined && intermediate)
    nodes.set(route.intermediateNode, intermediate);
  const segments: SwapInstruction["accounts"][] = [];
  let start = 10;
  for (let n = 10; n < swap.accounts.length; n++) {
    if (swap.accounts[n].pubkey !== COPY_SWAP_PROGRAM) continue;
    const section = swap.accounts.slice(start, n);
    const end = swap.accounts[n];
    if (
      end.isSigner ||
      end.isWritable ||
      section.length < 11 ||
      section.length > 28
    )
      throw new Error("Invalid direct pool account boundary.");
    const step = route.steps[segments.length];
    if (!step || !nodes.has(step.input) || !nodes.has(step.output))
      throw new Error("Direct route token account is missing.");
    if (step.variant === 99 || step.variant === 100) {
      checkPumpSegment(
        section,
        swap.accounts[0].pubkey,
        nodes.get(step.input)!,
        nodes.get(step.output)!,
        step.variant === 99,
      );
    } else {
      if (section.length > 20)
        throw new Error("Invalid direct pool account boundary.");
      const fixed = new Map([
        [0, RAYDIUM_CLMM_PROGRAM],
        [1, swap.accounts[0].pubkey],
        [4, nodes.get(step.input)!],
        [5, nodes.get(step.output)!],
        [9, TOKEN_PROGRAM],
      ]);
      if (
        section.some(
          (a, i) =>
            a.isSigner ||
            a.isWritable !== ![0, 1, 2, 9].includes(i) ||
            (fixed.has(i) && a.pubkey !== fixed.get(i)),
        )
      )
        throw new Error("Direct pool account identity or permission changed.");
    }
    segments.push(section);
    start = n + 1;
  }
  if (start !== swap.accounts.length || segments.length !== route.steps.length)
    throw new Error("Direct pool accounts do not match the route steps.");
  return segments;
}

export async function reviewCopyBuild(
  value: unknown,
  intent: CopySwapIntent,
  now = Date.now(),
) {
  validateSwapIntent(intent, now);
  const build = record(value),
    amount = swapRaw(build.inAmount),
    output = swapRaw(build.outAmount),
    providerMinimum = swapRaw(build.otherAmountThreshold);
  // Provider JSON rounds up by an atomic unit. Use the conservative floor of
  // the encoded output/slippage contract when enforcing our own ledger minimum.
  const numerator = output * BigInt(10000 - intent.slippageBps),
    minimum = numerator / 10000n;
  if (
    build.inputMint !== intent.inputMint ||
    build.outputMint !== intent.outputMint ||
    build.swapMode !== "ExactIn" ||
    amount !== swapRaw(intent.inputRaw) ||
    build.slippageBps !== intent.slippageBps ||
    (providerMinimum !== minimum &&
      providerMinimum !== (numerator + 9999n) / 10000n) ||
    minimum < swapRaw(intent.minOutputRaw)
  )
    throw new Error("Swap quote does not match the spending limits.");
  const swap = swapInstruction(build.swapInstruction, intent.wallet);
  if (swap.programId !== COPY_SWAP_PROGRAM)
    throw new Error("Unexpected swap program.");
  const route = decodeCopyRoute(instructionBytes(swap.data));
  if (
    route.input !== amount ||
    route.output !== output ||
    route.slippageBps !== intent.slippageBps
  )
    throw new Error("Swap bytes disagree with the quote.");
  const [source, destination, [authority]] = await Promise.all([
    associated(intent.wallet, intent.inputMint),
    associated(intent.wallet, intent.outputMint),
    getProgramDerivedAddress({
      programAddress: address(COPY_SWAP_PROGRAM),
      seeds: [
        new TextEncoder().encode("authority"),
        new Uint8Array([route.id]),
      ],
    }),
  ]);
  const [programSource, programDestination] = await Promise.all([
    associated(authority, intent.inputMint),
    associated(authority, intent.outputMint),
  ]);
  const expected =
    route.kind === "direct"
      ? [
          intent.wallet,
          source,
          destination,
          intent.inputMint,
          intent.outputMint,
          TOKEN_PROGRAM,
          TOKEN_PROGRAM,
          COPY_SWAP_PROGRAM, // Absent optional destination account (Anchor sentinel).
          "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf",
          COPY_SWAP_PROGRAM,
        ]
      : [
          authority,
          intent.wallet,
          source,
          programSource,
          programDestination,
          destination,
          intent.inputMint,
          intent.outputMint,
          TOKEN_PROGRAM,
          TOKEN_PROGRAM,
          "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf",
          COPY_SWAP_PROGRAM,
        ];
  if (
    swap.accounts.length <= expected.length ||
    expected.some((key, i) => {
      const a = swap.accounts[i];
      return (
        !a ||
        a.pubkey !== key ||
        a.isSigner !== (i === (route.kind === "direct" ? 0 : 1)) ||
        a.isWritable !==
          (route.kind === "direct" ? [1, 2] : [2, 3, 4, 5]).includes(i)
      );
    })
  )
    throw new Error(
      "Swap authority, token program or receiving account changed.",
    );
  // Direct routes reuse the wallet's exact source/destination in pool CPIs.
  // Exact segment checks bind each direct-route permission below. Shared routes
  // continue to exclude all follower accounts and signers from pool CPIs.
  if (
    route.kind === "shared" &&
    swap.accounts
      .slice(expected.length)
      .some(
        (a) =>
          a.isSigner || [intent.wallet, source, destination].includes(a.pubkey),
      )
  )
    throw new Error("Unexpected follower account in the pool route.");
  if (
    route.kind === "shared" &&
    route.steps.some((s) => s.variant === 99 || s.variant === 100)
  )
    throw new Error("Shared PumpSwap routes are unsupported.");
  if (
    !Array.isArray(build.routePlan) ||
    build.routePlan.length !== route.steps.length
  )
    throw new Error("Quote route is missing.");
  const intermediateAddress =
    route.kind === "direct" && route.intermediateNode !== undefined
      ? await associated(intent.wallet, WSOL)
      : undefined;
  const directSegments = directCopySegments(swap, intermediateAddress);
  const mints = new Map<number, string>([
    [0, intent.inputMint],
    [route.terminal, intent.outputMint],
  ]);
  const debits = new Map<number, bigint>(),
    credits = new Map<number, bigint>();
  const whirlpools: CopyWhirlpool[] = [];
  const labels: Record<number, string> = {
    7: "Raydium",
    17: "Whirlpool",
    19: "Meteora",
    26: "Raydium CLMM",
    38: "Meteora DLMM",
    40: "Raydium CLMM",
    46: "Raydium CP",
    47: "Whirlpool",
    75: "Meteora DLMM",
    77: "Meteora DAMM v2",
    99: "Pump.fun Amm",
    100: "Pump.fun Amm",
    105: "Raydium",
    108: "Meteora DAMM v2",
  };
  for (const [i, step] of route.steps.entries()) {
    const quote = record(build.routePlan[i]),
      info = record(quote.swapInfo);
    if (quote.bps !== step.bps) throw new Error("Quote route weight changed.");
    if (
      info.label !== labels[step.variant] ||
      (route.kind === "direct" &&
        directSegments[i][
          directSegments[i][0].pubkey === PUMP_AMM_PROGRAM ? 1 : 3
        ].pubkey !== info.ammKey) ||
      typeof info.ammKey !== "string" ||
      !isMint(info.ammKey) ||
      !swap.accounts
        .slice(expected.length)
        .some((a) => a.pubkey === info.ammKey && a.isWritable && !a.isSigner)
    )
      throw new Error("Quote pool or exchange does not match the swap route.");
    if (step.variant === 99 || step.variant === 100) {
      const a = directSegments[i],
        buy = step.variant === 99;
      if (
        a[4].pubkey !== (buy ? info.outputMint : info.inputMint) ||
        a[5].pubkey !== (buy ? info.inputMint : info.outputMint)
      )
        throw new Error("PumpSwap quote mint direction changed.");
    }
    for (const [node, mint] of [
      [step.input, info.inputMint],
      [step.output, info.outputMint],
    ] as const) {
      if (
        typeof mint !== "string" ||
        !isMint(mint) ||
        (mints.has(node) && mints.get(node) !== mint)
      )
        throw new Error("Quote route token changed.");
      mints.set(node, mint);
    }
    if (step.aToB !== undefined) {
      if (
        !swap.accounts
          .slice(expected.length)
          .some(
            (a) =>
              a.pubkey === WHIRLPOOL_PROGRAM && !a.isWritable && !a.isSigner,
          )
      )
        throw new Error("Whirlpool program is missing from the route.");
      whirlpools.push({
        pool: info.ammKey as string,
        inputMint: info.inputMint as string,
        outputMint: info.outputMint as string,
        aToB: step.aToB,
      });
    }
    debits.set(
      step.input,
      (debits.get(step.input) || 0n) + swapRaw(info.inAmount),
    );
    credits.set(
      step.output,
      (credits.get(step.output) || 0n) + swapRaw(info.outAmount),
    );
  }
  if (
    debits.get(0) !== amount ||
    credits.get(route.terminal) !== output ||
    [...mints.keys()].some(
      (node) =>
        node !== 0 &&
        node !== route.terminal &&
        debits.get(node) !== credits.get(node),
    )
  )
    throw new Error("Quote route amounts do not balance.");
  if (intermediateAddress && mints.get(route.intermediateNode!) !== WSOL)
    throw new Error("Only wrapped SOL can be an intermediate copy token.");
  // Preserve the intermediary instead of unwrapping the user's existing WSOL.
  // Validate the provider's optional close instruction, but never compile it.
  if (build.cleanupInstruction != null) {
    const close = swapInstruction(build.cleanupInstruction, intent.wallet);
    if (
      !intermediateAddress ||
      close.programId !== TOKEN_PROGRAM ||
      close.data !== "CQ==" ||
      close.accounts.length !== 3 ||
      close.accounts.some(
        (a, i) =>
          a.pubkey !== (i === 0 ? intermediateAddress : intent.wallet) ||
          a.isSigner !== (i === 2) ||
          a.isWritable !== (i !== 2),
      )
    )
      throw new Error("Unsupported swap cleanup.");
  }
  if (
    build.tipInstruction != null ||
    !Array.isArray(build.otherInstructions) ||
    build.otherInstructions.length
  )
    throw new Error("Extra swap instructions are not permitted.");
  if (
    !Array.isArray(build.setupInstructions) ||
    build.setupInstructions.length > (intermediateAddress ? 2 : 1)
  )
    throw new Error("Unsupported swap setup.");
  const setup = build.setupInstructions.map((ix) =>
    swapInstruction(ix, intent.wallet),
  );
  const setupAccounts = new Set<string>();
  for (const ix of setup) {
    const setupAddress = ix.accounts[1]?.pubkey;
    if (
      setupAccounts.has(setupAddress) ||
      (setupAddress !== destination && setupAddress !== intermediateAddress)
    )
      throw new Error("Unsupported or repeated swap setup account.");
    setupAccounts.add(setupAddress);
    const keys = [
      intent.wallet,
      setupAddress,
      intent.wallet,
      setupAddress === destination ? intent.outputMint : WSOL,
      "11111111111111111111111111111111",
      TOKEN_PROGRAM,
    ];
    if (
      ix.programId !== ATA_PROGRAM ||
      ix.data !== "AQ==" ||
      ix.accounts.length !== 6 ||
      ix.accounts.some(
        (a, i) =>
          a.pubkey !== keys[i] ||
          a.isSigner !== (i === 0) ||
          a.isWritable !== i < 2,
      )
    )
      throw new Error(
        "Only the follower's destination or wrapped SOL account may be created.",
      );
  }
  if (
    !Array.isArray(build.computeBudgetInstructions) ||
    build.computeBudgetInstructions.length > 2
  )
    throw new Error("Unsupported compute budget.");
  const seen = new Set<number>();
  let priority = 0n;
  for (const value of build.computeBudgetInstructions) {
    const ix = swapInstruction(value, intent.wallet),
      bytes = instructionBytes(ix.data),
      view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (
      ix.programId !== COMPUTE_PROGRAM ||
      ix.accounts.length ||
      seen.has(bytes[0])
    )
      throw new Error("Invalid compute budget.");
    seen.add(bytes[0]);
    if (bytes[0] === 3 && bytes.length === 9)
      priority = view.getBigUint64(1, true);
    else if (
      bytes[0] === 2 &&
      bytes.length === 5 &&
      view.getUint32(1, true) > 0 &&
      view.getUint32(1, true) <= COPY_COMPUTE_UNITS
    ) {
      /* replaced with the explicit fixed cap below */
    } else throw new Error("Unsupported compute budget instruction.");
  }
  const priorityFee =
    (priority * BigInt(COPY_COMPUTE_UNITS) + 999999n) / 1000000n;
  if (priorityFee + 5000n > swapRaw(intent.maxNetworkFeeLamports))
    throw new Error("Swap network fee exceeds the cap.");
  const limitBytes = new Uint8Array(5),
    priceBytes = new Uint8Array(9);
  limitBytes[0] = 2;
  new DataView(limitBytes.buffer).setUint32(1, COPY_COMPUTE_UNITS, true);
  priceBytes[0] = 3;
  new DataView(priceBytes.buffer).setBigUint64(1, priority, true);
  const compute = [limitBytes, priceBytes].map((bytes) => ({
    programId: COMPUTE_PROGRAM,
    accounts: [],
    data: btoa(String.fromCharCode(...bytes)),
  }));
  return {
    instructions: [...compute, ...setup, swap],
    source,
    destination,
    minimum: minimum.toString(),
    output: output.toString(),
    priorityFee: priorityFee.toString(),
    createsDestination: setupAccounts.has(destination),
    ...(intermediateAddress
      ? {
          intermediate: {
            address: intermediateAddress,
            mint: WSOL,
            createsAccount: setupAccounts.has(intermediateAddress),
          },
        }
      : {}),
    whirlpools,
  };
}
