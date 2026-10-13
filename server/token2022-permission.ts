import { createHash, createPublicKey, verify } from "node:crypto";
import bs58 from "bs58";
import {
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from "@solana/kit";
import { COPY_SWAP_PROGRAM, decodeCopyRoute } from "../src/copy-swap.js";
import { tokenUnits } from "../src/token-fees.js";
import { TOKEN_PROGRAM } from "../src/funding-model.js";
import type { Raydium22ExecutionReview } from "./token2022-recovery.js";

export {parseToken22Permission,token22PermissionMessage} from "../src/native-copy-permission.js";
export type {Token22Permission} from "../src/native-copy-permission.js";
import {parseToken22Permission,token22PermissionMessage,nativePermissionSellLimit,type Token22Permission} from "../src/native-copy-permission.js";
export function verifyToken22Permission(
  scope: Token22Permission,
  signature: string,
) {
  const message = token22PermissionMessage(scope),
    bytes = bs58.decode(signature);
  if (
    bytes.length !== 64 ||
    !verify(
      null,
      Buffer.from(message),
      createPublicKey({
        key: Buffer.concat([
          Buffer.from("302a300506032b6570032100", "hex"),
          bs58.decode(scope.wallet),
        ]),
        format: "der",
        type: "spki",
      }),
      bytes,
    )
  )
    throw Error("Invalid native-SOL permission signature.");
  return createHash("sha256").update(message).digest("hex");
}
export function token22ReviewCost(r: Raydium22ExecutionReview) {
  const rent =
    (r.wrappedCreated ? tokenUnits(r.wrappedReserve) : 0n) +
    BigInt(r.tokenRent) + BigInt(r.pumpTracker?.rent??0) + BigInt(r.curve?.trackerRent??0)+BigInt(r.curve?.curveRent??0);
  return {
    rent,
    maximum:
      rent +
      BigInt(r.feeLamports) +
      (r.accounts.direction === "buy" ? tokenUnits(r.accounts.inputRaw) : 0n),
  };
}
export function assertToken22PermissionReview(
  s: Token22Permission,
  r: Raydium22ExecutionReview,
) {
  parseToken22Permission(s);
  if (!((r.version === 1 && r.accounts.tokenProgram === undefined) ||
    (r.version === 2 && r.accounts.tokenProgram === TOKEN_PROGRAM) ||
    (s.version>=9 && r.version===4 && !!r.curve) ||
    (s.version>=7 && ((r.version===3 && r.accounts.pumpFees?.length===3)||(r.version===5 && r.accounts.pumpV4===true && r.accounts.pumpFees?.length===1)) && r.accounts.tokenProgram===TOKEN_PROGRAM)))
    throw Error("Unsupported native review token program.");
  if(s.version<=4&&(r.version!==1||r.accounts.tokenProgram!==undefined))throw Error("This permission does not authorize standard SPL native execution.");
  if(r.version===4){if(!r.curve||r.curve.request.slippageBps>s.slippageBps)throw Error('Curve trade exceeds the slippage permission.');}
  else {
  const tx = getTransactionDecoder().decode(Buffer.from(r.unsigned, "base64")),
    message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (message.version !== 0) throw Error("Unsupported reviewed message.");
  const ix = message.instructions.at(-1);
  if (
    !ix?.data ||
    message.staticAccounts[ix.programAddressIndex] !== COPY_SWAP_PROGRAM
  )
    throw Error("Missing reviewed swap.");
  const route = decodeCopyRoute(new Uint8Array(ix.data));
  if (
    route.slippageBps > s.slippageBps ||
    route.input !== tokenUnits(r.accounts.inputRaw) ||
    route.kind !== "direct" ||
    route.steps.length !== 1 ||
    ([3,5].includes(r.version) ? s.version<7||route.steps[0].variant!==(r.version===5?(r.accounts.direction==='buy'?193:194):(r.accounts.direction==='buy'?99:100)) : route.steps[0].variant !== 40 && !(s.version>=5&&r.version===2&&route.steps[0].variant===26)) ||
    (route.output * BigInt(10000 - route.slippageBps)) / 10000n !==
      tokenUnits(r.accounts.minimum)
  )
    throw Error("Swap does not match permission.");
  }
  if (
    ((s.version===2||s.version===4||s.version===6||s.version===8||s.version===10) && r.accounts.mint!==s.mint) ||
    r.accounts.wallet !== s.wallet ||
    r.reviewedAt < s.issuedAt ||
    r.expiresAt > s.expiresAt ||
    BigInt(r.feeLamports) > tokenUnits(s.maxFeeLamports) ||
    token22ReviewCost(r).rent > tokenUnits(s.maxRentLamports) ||
    (r.accounts.direction === "buy"
      ? r.accounts.inputRaw !== s.buyLamports
      : !s.copySells || tokenUnits(r.accounts.inputRaw)>nativePermissionSellLimit(s))
  )
    throw Error("Trade is outside the native-SOL permission.");
}
