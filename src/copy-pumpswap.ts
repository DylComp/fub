import { TOKEN_PROGRAM } from "./funding-model.js";
import { ATA_PROGRAM } from "./transaction-review.js";
import type { SwapInstruction } from "./copy-swap.js";

export const PUMP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const PUMP_FEE_PROGRAM = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";

// Jupiter PumpSwapBuyV3/SellV3, captured September 24, 2026. A second wallet
// reference pays CPI costs. Its privilege is accepted only in these positions.
// Cashback/claim variants and extra remaining accounts are deliberately excluded.
export function checkPumpSegment(
  a: SwapInstruction["accounts"],
  wallet: string,
  input: string,
  output: string,
  buy: boolean,
  v4 = false,
) {
  if (v4) {
    const fixed = new Map([[0,PUMP_AMM_PROGRAM],[2,wallet],[3,"ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw"],[6,buy?output:input],[7,buy?input:output],[10,TOKEN_PROGRAM],[11,TOKEN_PROGRAM],[12,SYSTEM_PROGRAM],[16,"GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR"],[17,PUMP_AMM_PROGRAM],[18,wallet]]);
    const writable = new Set([1,2,6,7,8,9,13,15,18]);
    if(a.length!==19 || a.some((v,i)=>v.isSigner!==(i===18)||v.isWritable!==writable.has(i)||(fixed.has(i)&&fixed.get(i)!==v.pubkey)||(v.pubkey===wallet&&i!==2&&i!==18)))
      throw new Error("PumpSwap V4 account identity or permission changed.");
    return;
  }
  const shift = buy ? 2 : 0;
  const fixed = new Map([
    [0, PUMP_AMM_PROGRAM],
    [2, wallet],
    [3, "ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw"],
    [6, buy ? output : input],
    [7, buy ? input : output],
    [12, TOKEN_PROGRAM],
    [13, TOKEN_PROGRAM],
    [14, SYSTEM_PROGRAM],
    [15, ATA_PROGRAM],
    [16, "GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR"],
    [17, PUMP_AMM_PROGRAM],
    [21 + shift, PUMP_FEE_PROGRAM],
    [22 + shift, wallet],
  ]);
  const writable = new Set([
    1,
    2,
    6,
    7,
    8,
    9,
    11,
    18,
    22 + shift,
    25 + shift,
    ...(buy ? [20, 21] : []),
  ]);
  if (
    a.length !== 26 + shift ||
    a.some(
      (v, i) =>
        v.isSigner !== (i === 22 + shift) ||
        v.isWritable !== writable.has(i) ||
        (fixed.has(i) && fixed.get(i) !== v.pubkey) ||
        (v.pubkey === wallet && i !== 2 && i !== 22 + shift),
    )
  )
    throw new Error("PumpSwap account identity or permission changed.");
}
