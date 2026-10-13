import { TOKEN_PROGRAM } from "../src/funding-model.js";
import { isMint } from "../src/assets.js";
import { record } from "../src/live-orders.js";
import { tokenUnits } from "../src/token-fees.js";
import { intermediateRent } from "./copy-intermediate.js";
import type { ReviewedCopySwap } from "./copy-swap.js";
const invalid = (): never => {
  throw Error(
    "Copy token settlement does not match the reviewed accounts and amounts.",
  );
};
const raw = tokenUnits;
// The same endpoint rules apply to pre-signing simulation and finalized recovery.
// Current scope remains standard SPL; this does not authorize Token-2022 swaps.
export function verifyCopyTokenSettlement(
  review: ReviewedCopySwap,
  sim: Record<string, unknown>,
  keys: readonly string[],
  bounds: { inputDecimals: number; outputDecimals: number },
) {
  const source = keys.indexOf(review.source),
    destination = keys.indexOf(review.destination);
  const pre = sim.preBalances,
    post = sim.postBalances;
  if (
    keys[0] !== review.intent.wallet ||
    source < 1 ||
    destination < 1 ||
    source === destination ||
    !Array.isArray(pre) ||
    !Array.isArray(post) ||
    pre.length !== keys.length ||
    post.length !== keys.length ||
    [...pre, ...post].some((n) => !Number.isSafeInteger(n) || n < 0) ||
    pre[source] <= 0 ||
    post[source] <= 0 ||
    post[destination] <= 0 ||
    [bounds.inputDecimals, bounds.outputDecimals].some(
      (n) => !Number.isInteger(n) || n < 0 || n > 18,
    )
  )
    return invalid();
  const destinationRent = BigInt(post[destination]) - BigInt(pre[destination]);
  intermediateRent(review.intermediate, review.intent.wallet, keys, sim);
  type Token = {
    mint: string;
    owner: string;
    program: string;
    decimals: number;
    amount: bigint;
  };
  function balances(value: unknown) {
    if (!Array.isArray(value) || value.length > keys.length) return invalid();
    const rows = new Map<number, Token>();
    for (const v of value) {
      const b = record(v),
        amount = record(b.uiTokenAmount),
        n = b.accountIndex;
      if (
        !Number.isSafeInteger(n) ||
        (n as number) < 0 ||
        (n as number) >= keys.length ||
        rows.has(n as number) ||
        !isMint(String(b.mint)) ||
        !isMint(String(b.owner)) ||
        !isMint(String(b.programId)) ||
        !Number.isInteger(amount.decimals) ||
        (amount.decimals as number) < 0 ||
        (amount.decimals as number) > 255
      )
        return invalid();
      rows.set(n as number, {
        mint: String(b.mint),
        owner: String(b.owner),
        program: String(b.programId),
        decimals: amount.decimals as number,
        amount: raw(amount.amount),
      });
    }
    return rows;
  }
  const before = balances(sim.preTokenBalances),
    after = balances(sim.postTokenBalances);
  for (const n of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(n),
      b = after.get(n);
    if (a?.owner !== review.intent.wallet && b?.owner !== review.intent.wallet)
      continue;
    if (
      a &&
      b &&
      (a.owner !== b.owner ||
        a.mint !== b.mint ||
        a.program !== b.program ||
        a.decimals !== b.decimals)
    )
      return invalid();
    if (
      n !== source &&
      n !== destination &&
      keys[n] !== review.intermediate?.address &&
      (!a || !b || a.amount !== b.amount || pre[n] !== post[n])
    )
      return invalid();
  }
  const inputBefore = before.get(source),
    inputAfter = after.get(source),
    outputBefore = before.get(destination),
    outputAfter = after.get(destination);
  function matches(token: Token | undefined, mint: string, decimals: number) {
    return (
      token &&
      token.owner === review.intent.wallet &&
      token.program === TOKEN_PROGRAM &&
      token.mint === mint &&
      token.decimals === decimals
    );
  }
  if (
    !matches(inputBefore, review.intent.inputMint, bounds.inputDecimals) ||
    !matches(inputAfter, review.intent.inputMint, bounds.inputDecimals) ||
    !matches(outputAfter, review.intent.outputMint, bounds.outputDecimals)
  )
    return invalid();
  if (
    outputBefore
      ? !matches(
          outputBefore,
          review.intent.outputMint,
          bounds.outputDecimals,
        ) || destinationRent !== 0n
      : !review.createsDestination ||
        pre[destination] !== 0 ||
        destinationRent <= 0n
  )
    return invalid();
  const spent = inputBefore!.amount - inputAfter!.amount;
  const received = outputAfter!.amount - (outputBefore?.amount || 0n);
  if (
    spent !== raw(review.intent.inputRaw) ||
    received < raw(review.minimum) ||
    received < raw(review.intent.minOutputRaw)
  )
    return invalid();

  return {
    source,
    destination,
    inputAfter: inputAfter!,
    outputAfter: outputAfter!,
    spent,
    received,
  };
}
