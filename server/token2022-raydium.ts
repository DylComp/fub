// Engineering inspection only. No execution permission, signing or submission.
import { isMint } from "../src/assets.js";
import { record } from "../src/live-orders.js";
import { TOKEN_PROGRAM, WSOL } from "../src/funding-model.js";
import { associated } from "../src/transaction-review.js";
import {
  COPY_SWAP_PROGRAM,
  RAYDIUM_CLMM_PROGRAM,
  decodeCopyRoute,
  instructionBytes,
  swapInstruction,
  swapRaw,
} from "../src/copy-swap.js";
import type { SwapInstruction } from "../src/copy-swap.js";
import { TOKEN_2022 } from "./jupiter-routes.js";
import { verifyRaydiumPoolAccounts } from "./copy-direct-pools.js";
import type { Rpc } from "./funding.js";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const invalid = (): never => {
  throw Error(
    "Token-2022 Raydium route evidence is unsupported or inconsistent.",
  );
};
export type Raydium22Request = {
  wallet: string;
  mint: string;
  direction: "buy" | "sell";
  inputRaw: string;
  minOutputRaw: string;
  slippageBps: number;
};
// Reviews the swap only. Provider setup, cleanup, tips and lookup tables are
// deliberately not returned as executable instructions by this inspector.
async function inspectNativeRaydiumRoute(
  value: unknown,
  request: Raydium22Request,
  rpc: Rpc,
  minContextSlot: number,
  allowTransferFees = false,
  tokenProgram: string = TOKEN_2022,
) {
  const { wallet, mint, direction, slippageBps } = request;
  if (
    ![wallet, mint].every(isMint) ||
    mint === WSOL ||
    !["buy", "sell"].includes(direction) ||
    !Number.isInteger(slippageBps) ||
    slippageBps < 10 ||
    slippageBps > 500
  )
    return invalid();
  const buy = direction === "buy",
    inputMint = buy ? WSOL : mint,
    outputMint = buy ? mint : WSOL;
  const inputProgram = buy ? TOKEN_PROGRAM : tokenProgram,
    outputProgram = buy ? tokenProgram : TOKEN_PROGRAM;
  const build = record(value),
    input = swapRaw(request.inputRaw),
    output = swapRaw(build.outAmount),
    minimum = (output * BigInt(10000 - slippageBps)) / 10000n;
  const numerator = output * BigInt(10000 - slippageBps),
    providerMin = swapRaw(build.otherAmountThreshold);
  if (
    build.inputMint !== inputMint ||
    build.outputMint !== outputMint ||
    build.swapMode !== "ExactIn" ||
    swapRaw(build.inAmount) !== input ||
    build.slippageBps !== slippageBps ||
    minimum < swapRaw(request.minOutputRaw) ||
    (providerMin !== minimum && providerMin !== (numerator + 9999n) / 10000n)
  )
    return invalid();
  const swap = swapInstruction(build.swapInstruction, wallet),
    route = decodeCopyRoute(instructionBytes(swap.data));
  const v2 = route.steps.every(s => s.variant === 40);
  if (
    swap.programId !== COPY_SWAP_PROGRAM ||
    route.kind !== "direct" ||
    route.intermediateNode !== undefined ||
    (tokenProgram === TOKEN_2022 ? !v2 : (!v2 && route.steps.some(s => s.variant !== 26))) ||
    route.input !== input ||
    route.output !== output ||
    route.slippageBps !== slippageBps
  )
    return invalid();
  const [source, destination] = await Promise.all([
    associated(wallet, inputMint, inputProgram),
    associated(wallet, outputMint, outputProgram),
  ]);
  const expected = [
    wallet,
    source,
    destination,
    inputMint,
    outputMint,
    inputProgram,
    outputProgram,
    COPY_SWAP_PROGRAM,
    "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf",
    COPY_SWAP_PROGRAM,
  ];
  if (
    expected.some(
      (key, i) =>
        !swap.accounts[i] ||
        swap.accounts[i].pubkey !== key ||
        swap.accounts[i].isSigner !== (i === 0) ||
        swap.accounts[i].isWritable !== [1, 2].includes(i),
    )
  )
    return invalid();
  const segments: SwapInstruction["accounts"][] = [];
  let start = 10;
  for (let i = 10; i < swap.accounts.length; i++) {
    if (swap.accounts[i].pubkey !== COPY_SWAP_PROGRAM) continue;
    const segment = swap.accounts.slice(start, i),
      end = swap.accounts[i];
    if (
      end.isSigner ||
      end.isWritable ||
      segment.length < (v2 ? 15 : 11) ||
      segment.length > (v2 ? 24 : 20)
    )
      return invalid();
    const fixed = new Map([
      [0, RAYDIUM_CLMM_PROGRAM],
      [1, wallet],
      [4, source],
      [5, destination],
      [9, TOKEN_PROGRAM],

    ]);
    if(v2){fixed.set(10,TOKEN_2022);fixed.set(11,MEMO);fixed.set(12,inputMint);fixed.set(13,outputMint);}
    const readonly = v2 ? [0,1,2,9,10,11,12,13] : [0,1,2,9];
    if (
      segment.some(
        (a, n) =>
          a.isSigner ||
          a.isWritable !== !readonly.includes(n) ||
          (fixed.has(n) && a.pubkey !== fixed.get(n)),
      )
    )
      return invalid();
    // A pool cannot alias its authority, vaults, user accounts, observation or
    // tick arrays. Mint/program repeats occur only across separate segments.
    if (new Set(segment.map((a) => a.pubkey)).size !== segment.length)
      return invalid();
    segments.push(segment);
    start = i + 1;
  }
  if (
    start !== swap.accounts.length ||
    segments.length !== route.steps.length ||
    !Array.isArray(build.routePlan) ||
    build.routePlan.length !== segments.length ||
    new Set(segments.map((s) => s[3].pubkey)).size !== segments.length
  )
    return invalid();
  let debits = 0n,
    credits = 0n;
  for (const [i, step] of route.steps.entries()) {
    const quote = record(build.routePlan[i]),
      info = record(quote.swapInfo);
    if (
      step.input !== 0 ||
      step.output !== route.terminal ||
      quote.bps !== step.bps ||
      info.label !== "Raydium CLMM" ||
      info.ammKey !== segments[i][3].pubkey ||
      info.inputMint !== inputMint ||
      info.outputMint !== outputMint
    )
      return invalid();
    debits += swapRaw(info.inAmount);
    credits += swapRaw(info.outAmount);
  }
  if (debits !== input || credits !== output) return invalid();
  const slot = await verifyRaydiumPoolAccounts(
    swap,
    segments,
    rpc,
    minContextSlot,
    undefined,
    v2,
    allowTransferFees,
  );
  return {
    swap,
    segments,
    source,
    destination,
    minimum: minimum.toString(),
    output: output.toString(),
    slot,
  };
}

// Existing Token-2022 execution keeps its original, narrower route contract.
export function inspectRaydium22Route(value:unknown,request:Raydium22Request,rpc:Rpc,minContextSlot:number,allowTransferFees=false){
  return inspectNativeRaydiumRoute(value,request,rpc,minContextSlot,allowTransferFees,TOKEN_2022);
}
// Preparation-only SPL route validation. This does not widen existing signed
// copy permissions or turn a reviewed route into an executable transaction.
export function inspectStandardRaydiumRoute(value:unknown,request:Raydium22Request,rpc:Rpc,minContextSlot:number){
  return inspectNativeRaydiumRoute(value,request,rpc,minContextSlot,false,TOKEN_PROGRAM);
}
