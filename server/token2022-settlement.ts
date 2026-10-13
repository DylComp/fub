import { isMint } from "../src/assets.js";
import { TOKEN_PROGRAM, WSOL } from "../src/funding-model.js";
import { record } from "../src/live-orders.js";
import { swapRaw } from "../src/copy-swap.js";
import { tokenUnits } from "../src/token-fees.js";
import { TOKEN_2022 } from "./jupiter-routes.js";
export type Raydium22SettlementAccounts = {
  tokenProgram?: typeof TOKEN_PROGRAM;
  pumpV4?: true;
  pumpFees?: {account:string;owner:string;reserve:string}[];
  wallet: string;
  mint: string;
  decimals: number;
  direction: "buy" | "sell";
  source: string;
  destination: string;
  inputVault: string;
  outputVault: string;
  pool: string;
  inputRaw: string;
  minimum: string;
};
const invalid = (): never => {
  throw Error(
    "Token-2022 settlement does not match the reviewed accounts and net amounts.",
  );
};
// Exact token-account settlement core. A caller must separately bind the signed
// message, finalized status, native costs and the saved route/account review.
// No present-day mint read is used to invent a historical transfer-fee schedule.
export function verifyRaydium22TokenSettlement(
  review: Raydium22SettlementAccounts,
  meta: Record<string, unknown>,
  keys: readonly string[],
) {
  const {
    wallet,
    mint,
    source,
    destination,
    inputVault,
    outputVault,
    pool,
    decimals,
    direction,
  } = review;
  const buy = direction === "buy";
  const tokenProgram=review.tokenProgram??TOKEN_2022;
  if(review.tokenProgram!==undefined&&review.tokenProgram!==TOKEN_PROGRAM)return invalid();
  const fees=review.pumpFees??[];
  if(review.pumpV4!==undefined&&(review.pumpV4!==true||review.pumpFees===undefined))return invalid();
  if(review.pumpFees!==undefined&&(tokenProgram!==TOKEN_PROGRAM||fees.length!==(review.pumpV4===true?1:3)||fees.some(f=>!isMint(f.account)||!isMint(f.owner)||tokenUnits(f.reserve)<1n)||new Set([wallet,source,destination,inputVault,outputVault,pool,...fees.flatMap(f=>[f.account,f.owner])]).size!==(review.pumpV4===true?8:12)))return invalid();
  if (
    !["buy", "sell"].includes(direction) ||
    ![wallet, mint, source, destination, inputVault, outputVault, pool].every(
      isMint,
    ) ||
    mint === WSOL ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 18 ||
    new Set([wallet, source, destination, inputVault, outputVault, pool])
      .size !== 6 ||
    keys[0] !== wallet ||
    ![mint, WSOL, pool].every((key) => keys.includes(key)) ||
    keys.length > 128 ||
    new Set(keys).size !== keys.length ||
    keys.some((k) => !isMint(k))
  )
    return invalid();
  const input = swapRaw(review.inputRaw),
    minimum = swapRaw(review.minimum),
    pre = meta.preBalances,
    post = meta.postBalances;
  if (
    meta.err !== null ||
    ![pre, post].every(
      (v) =>
        Array.isArray(v) &&
        v.length === keys.length &&
        v.every((n) => Number.isSafeInteger(n) && n >= 0),
    )
  )
    return invalid();
  const beforeSol = pre as number[],
    afterSol = post as number[];
  const expected = new Map([
    [
      source,
      {
        owner: wallet,
        mint: buy ? WSOL : mint,
        program: buy ? TOKEN_PROGRAM : tokenProgram,
        decimals: buy ? 9 : decimals,
      },
    ],
    [
      destination,
      {
        owner: wallet,
        mint: buy ? mint : WSOL,
        program: buy ? tokenProgram : TOKEN_PROGRAM,
        decimals: buy ? decimals : 9,
      },
    ],
    [
      inputVault,
      {
        owner: pool,
        mint: buy ? WSOL : mint,
        program: buy ? TOKEN_PROGRAM : tokenProgram,
        decimals: buy ? 9 : decimals,
      },
    ],
    [
      outputVault,
      {
        owner: pool,
        mint: buy ? mint : WSOL,
        program: buy ? tokenProgram : TOKEN_PROGRAM,
        decimals: buy ? decimals : 9,
      },
    ],
  ]);
  for(const f of fees)expected.set(f.account,{owner:f.owner,mint:WSOL,program:TOKEN_PROGRAM,decimals:9});
  for (const key of expected.keys()) {
    const index = keys.indexOf(key);
    if (
      index < 1 ||
      afterSol[index] <= 0 ||
      ((key === inputVault ||
        key === outputVault ||
        (!buy && key === source) || fees.some(f=>f.account===key)) &&
        beforeSol[index] <= 0)
    )
      return invalid();
  }
  function balances(value: unknown, after: boolean) {
    if (!Array.isArray(value) || value.length > 4+fees.length) return invalid();
    const amounts = new Map<string, bigint>(),
      indexes = new Set<number>();
    for (const entry of value) {
      const row = record(entry),
        ui = record(row.uiTokenAmount),
        index = row.accountIndex;
      if (
        !Number.isSafeInteger(index) ||
        (index as number) < 0 ||
        (index as number) >= keys.length ||
        indexes.has(index as number)
      )
        return invalid();
      indexes.add(index as number);
      const key = keys[index as number],
        e = expected.get(key);
      if (
        !e ||
        (!after && beforeSol[index as number] === 0) ||
        row.owner !== e.owner ||
        row.mint !== e.mint ||
        row.programId !== e.program ||
        ui.decimals !== e.decimals
      )
        return invalid();
      amounts.set(key, tokenUnits(ui.amount));
    }
    for (const key of expected.keys())
      if (!amounts.has(key)) {
        const canCreate = key === destination || (buy && key === source);
        if (!after && canCreate && beforeSol[keys.indexOf(key)] === 0)
          amounts.set(key, 0n);
        else return invalid();
      }
    return amounts;
  }
  const before = balances(meta.preTokenBalances, false),
    after = balances(meta.postTokenBalances, true);
  const received = after.get(destination)! - before.get(destination)!,
    poolInput = after.get(inputVault)! - before.get(inputVault)!,
    poolOutput = before.get(outputVault)! - after.get(outputVault)!;
  let nativeFees=0n;
  for(const f of fees){
    const delta=after.get(f.account)!-before.get(f.account)!,i=keys.indexOf(f.account),reserve=tokenUnits(f.reserve);
    if(delta<0n||BigInt(afterSol[i])-BigInt(beforeSol[i])!==delta||BigInt(beforeSol[i])-before.get(f.account)! !== reserve||BigInt(afterSol[i])-after.get(f.account)! !== reserve)return invalid();
    nativeFees+=delta;
  }
  if (
    received < minimum ||
    (buy
      ? before.get(source) !== after.get(source) || poolInput+nativeFees !== input
      : before.get(source)! - after.get(source)! !== input ||
        poolOutput !== received+nativeFees)
  )
    return invalid();
  const tokenGross = buy ? poolOutput : input,
    tokenNet = buy ? received : poolInput;
  if (tokenGross <= 0n || tokenNet <= 0n || tokenNet > tokenGross || (tokenProgram===TOKEN_PROGRAM&&tokenGross!==tokenNet))
    return invalid();
  return {
    before,
    after,
    received,
    input,
    tokenGross,
    tokenNet,
    observedTokenFee: tokenGross - tokenNet,
    nativeFees,
  };
}
