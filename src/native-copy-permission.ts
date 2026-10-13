import {isFubProductionOrigin, type FubWebOrigin} from './fub-origin.js';
import {isMint} from "./assets.js";
import {WSOL,operationId} from "./funding-model.js";
import {tokenUnits} from "./token-fees.js";
// A separate, explicit native-SOL policy. No old USDC signature can authorize it.
export const NATIVE_COPY_MAX_BUY_LAMPORTS = '100000000000';
type Token22PermissionBase = {
  origin: FubWebOrigin;
  network: "solana:mainnet";
  id: string;
  planId: string;
  planVersion: number;
  wallet: string;
  leader: string;
  buyLamports: string;
  dailySpendLamports: string;
  maxFeeLamports: string;
  maxRentLamports: string;
  copySells: boolean;
  slippageBps: number;
  issuedAt: number;
  acceptBy: number;
  expiresAt: number;
};
export type Token22Permission = Token22PermissionBase & (({policy:"raydium-token22-sol-v1"}&({version:1|3;mint?:never}|{version:2|4;mint:string}))|({policy:"raydium-native-sol-v2"}&({version:5;mint?:never}|{version:6;mint:string}))|({policy:"native-sol-venues-v3"}&({version:7;mint?:never}|{version:8;mint:string}))|({policy:"native-sol-venues-v4"}&({version:9;mint?:never}|{version:10;mint:string})));
export function parseToken22Permission(value: Token22Permission) {
  const s = value,
    fields =
      "version,policy,origin,network,id,planId,planVersion,wallet,leader,buyLamports,dailySpendLamports,maxFeeLamports,maxRentLamports,copySells,slippageBps,issuedAt,acceptBy,expiresAt" + ((s?.version===2||s?.version===4||s?.version===6||s?.version===8||s?.version===10) ? ",mint" : "");
  if (
    !s ||
    Object.keys(s).sort().join() !== fields.split(",").sort().join() ||
    ![1,2,3,4,5,6,7,8,9,10].includes(s.version) ||
    ((s.version===2||s.version===4||s.version===6||s.version===8||s.version===10) && (!isMint(s.mint)||s.mint===WSOL||s.mint===s.wallet)) ||
    s.policy !== (s.version<=4?"raydium-token22-sol-v1":s.version<=6?"raydium-native-sol-v2":s.version<=8?"native-sol-venues-v3":"native-sol-venues-v4") ||
    !isFubProductionOrigin(s.origin) ||
    s.network !== "solana:mainnet" ||
    !operationId(s.id) ||
    !operationId(s.planId) ||
    !isMint(s.wallet) ||
    !isMint(s.leader) ||
    s.wallet === s.leader ||
    !Number.isSafeInteger(s.planVersion) ||
    s.planVersion < 1 ||
    s.planVersion > 2147483647 ||
    typeof s.copySells !== "boolean" ||
    !Number.isInteger(s.slippageBps) ||
    s.slippageBps < 10 ||
    s.slippageBps > 500 ||
    ![s.issuedAt, s.acceptBy, s.expiresAt].every(Number.isSafeInteger) ||
    s.issuedAt < 1 ||
    s.acceptBy !== s.issuedAt + 300000 ||
    s.expiresAt < s.acceptBy ||
    s.expiresAt > s.issuedAt + 86400000 ||
    tokenUnits(s.buyLamports) < 1n ||
    tokenUnits(s.buyLamports) > BigInt(NATIVE_COPY_MAX_BUY_LAMPORTS) ||
    tokenUnits(s.maxFeeLamports) < 1n ||
    tokenUnits(s.maxFeeLamports) > 50000n ||
    tokenUnits(s.maxRentLamports) > 5000000n ||
    tokenUnits(s.dailySpendLamports) > 1000000000000n ||
    tokenUnits(s.dailySpendLamports) <
      tokenUnits(s.buyLamports) +
        tokenUnits(s.maxFeeLamports) +
        tokenUnits(s.maxRentLamports)
  )
    throw Error("Invalid native-SOL copy permission.");
  return s;
}
export function token22PermissionMessage(value: Token22Permission) {
  const s = parseToken22Permission(value);
  return [
    s.version===1 ? "Fomo Orders native SOL copy permission v1" : s.version===2 ? "Fub token-restricted SOL copy permission v2" : s.version===3 ? "Fub proportional SOL copy permission v3" : s.version===4 ? "Fub token-restricted proportional SOL copy permission v4" : s.version===5 ? "Fub standard SPL and Token-2022 SOL copy permission v5" : s.version===6 ? "Fub token-restricted standard SPL and Token-2022 SOL copy permission v6" : s.version===7 ? "Fub native SOL venue copy permission v7" : s.version===8 ? "Fub token-restricted native SOL venue copy permission v8" : s.version===9 ? "Fub native SOL and Pump curve copy permission v9" : "Fub token-restricted native SOL and Pump curve copy permission v10",
    `Website: ${s.origin}`,
    `Network: ${s.network}`,
    `Wallet: ${s.wallet}`,
    `Leader: ${s.leader}`,
    ...((s.version===2||s.version===4||s.version===6||s.version===8||s.version===10) ? [`Only token: ${s.mint}`, "Other tokens are not authorized for buys or sells."] : []),
    `Plan: ${s.planId}`,
    `Plan version: ${s.planVersion}`,
    `Policy: ${s.policy}`,
    `Buy input: ${s.buyLamports} lamports of fresh SOL`,
    `Daily SOL spending cap: ${s.dailySpendLamports} lamports per UTC day, including buy input, network fees and new account rent`,
    `Network fee cap: ${s.maxFeeLamports} lamports per transaction`,
    `New account rent cap: ${s.maxRentLamports} lamports per transaction`,
    `Slippage cap: ${s.slippageBps} basis points`,
    `Proportional sells: ${s.copySells ? (s.version<=2 ? "allowed, only this plan's acquired tokens, at most 1000000 raw units per trade" : "allowed, only this plan's credited acquired tokens, at most the fraction sold by the leader; never more than the remaining wallet balance") : "not allowed"}`,
    s.version<=4 ? "Routes: one reviewed Raydium CLMM pool between wrapped SOL and supported Token-2022 tokens" : s.version<=6 ? "Routes: one reviewed Raydium CLMM pool between wrapped SOL and standard SPL or supported Token-2022 tokens" : s.version<=8 ? "Routes: one reviewed Raydium CLMM pool for standard SPL or supported Token-2022 tokens, or one reviewed PumpSwap pool for standard SPL tokens, against wrapped SOL" : "Routes: reviewed Raydium CLMM and standard SPL PumpSwap pools, or supported standard SPL and Token-2022 Pump bonding curves",
    s.version<=8 ? "Transfer fees reduce net tokens received. Sell proceeds remain wrapped SOL and never refill the daily spending cap." : "Transfer fees reduce net tokens received. Pool sales return wrapped SOL; Pump curve sales return native SOL to this same wallet. Sale proceeds never refill the daily spending cap.",
    "Existing wrapped SOL stays untouched on buys. Account closure and withdrawals are not authorized.",
    `Issued: ${new Date(s.issuedAt).toISOString()}`,
    `Sign before: ${new Date(s.acceptBy).toISOString()}`,
    `Permission expires: ${new Date(s.expiresAt).toISOString()}`,
    `Request: ${s.id}`,
    "Editing, pausing, stopping or revoking blocks new signing. Submitted trades can still settle.",
    "This approves application rules only. It does not provide access to my wallet or replace a supported signing connection.",
  ].join("\n");
}

// Keep the limit promised by legacy signatures. New proportional permissions
// still require credited inventory and the observed leader sell fraction.
export function nativePermissionSellLimit(s:Token22Permission){
  parseToken22Permission(s);return s.version<=2?1000000n:18446744073709551615n;
}
