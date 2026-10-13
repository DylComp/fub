import {nativeBuyBound} from './native-buy-bound.js';
import {type CurveReview,curveReviewHash,verifyCurveReview,verifyCurveBalances} from './pump-curve-execution.js';
// Internal recovery boundary for the verified, single-pool Raydium probe.
// This module neither grants authority nor signs, submits or activates a trade.
import { createHash, createPublicKey, verify } from "node:crypto";
import bs58 from "bs58";
import {
  getTransactionDecoder,
  getTransactionEncoder,
  getCompiledTransactionMessageDecoder,
} from "@solana/kit";
import { isMint } from "../src/assets.js";
import { record } from "../src/live-orders.js";
import { TOKEN_PROGRAM, WSOL } from "../src/funding-model.js";
import { tokenUnits } from "../src/token-fees.js";
import { TOKEN_2022 } from "./jupiter-routes.js";
import {
  verifyRaydium22TokenSettlement,
  type Raydium22SettlementAccounts,
} from "./token2022-settlement.js";
import type { Rpc } from "./funding.js";

export type Raydium22ExecutionReview = {
  version: 1 | 2 | 3 | 4 | 5;
  curve?: CurveReview;
  pumpTracker?: {account:string;rent:number};
  unsigned: string;
  messageHash: string;
  accounts: Raydium22SettlementAccounts;
  minContextSlot: number;
  lastValidBlockHeight: number;
  reviewedAt: number;
  expiresAt: number;
  feeLamports: number;
  wrappedCreated: boolean;
  tokenCreated: boolean;
  wrappedReserve: string;
  vaultReserve: string;
  tokenRent: number;
};
export type Raydium22SignedExecution = {
  version: 1;
  reviewHash: string;
  signed: string;
  signature: string;
};
const invalid = (): never => {
  throw Error("Token-2022 execution evidence does not match the saved review.");
};
const integer = (n: unknown): n is number =>
  Number.isSafeInteger(n) && (n as number) >= 0;
const hash = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");
function decode(encoded: string) {
  if (typeof encoded !== "string" || encoded.length > 1644) return invalid();
  const bytes = Buffer.from(encoded, "base64");
  if (
    !bytes.length ||
    bytes.length > 1232 ||
    bytes.toString("base64") !== encoded
  )
    return invalid();
  const tx = getTransactionDecoder().decode(bytes);
  if (!Buffer.from(getTransactionEncoder().encode(tx)).equals(bytes))
    return invalid();
  return tx;
}

// Only seal reviews emitted by the successful simulation pipeline. Persist this
// digest in the trusted journal BEFORE asking a provider to sign. A client-supplied
// review plus its own digest is not authorization or a substitute for inspection.
export function raydium22ReviewHash(r: Raydium22ExecutionReview) {
  const a = r.accounts;
  return hash(
    JSON.stringify([
      r.version,
      r.unsigned,
      r.messageHash,
      a.wallet,
      a.mint,
      a.decimals,
      a.direction,
      a.source,
      a.destination,
      a.inputVault,
      a.outputVault,
      a.pool,
      a.inputRaw,
      a.minimum,
      r.minContextSlot,
      r.lastValidBlockHeight,
      r.reviewedAt,
      r.expiresAt,
      r.feeLamports,
      r.wrappedCreated,
      r.tokenCreated,
      r.wrappedReserve,
      r.vaultReserve,
      r.tokenRent,
      ...(r.version>=2?[a.tokenProgram]:[]),
      ...([3,5].includes(r.version)?[a.pumpFees?.map(f=>[f.account,f.owner,f.reserve])]:[]),
      ...(r.version===5?[a.pumpV4]:[]),
      ...(r.pumpTracker?[[r.pumpTracker.account,r.pumpTracker.rent]]:[]),
      ...(r.version===4?[r.curve?curveReviewHash(r.curve):null]:[]),
    ]),
  );
}
function inspectReview(r: Raydium22ExecutionReview, savedHash: string, maxSellRaw = '1000000', maxBuyRaw = '10000000') {
  if(r.version===4){
    if(!r.curve||r.pumpTracker!==undefined||r.accounts.pumpFees!==undefined||raydium22ReviewHash(r)!==savedHash)return invalid();
    const {keys}=verifyCurveReview(r.curve,maxBuyRaw),expected=curveExecutionReview(r.curve);
    if(Object.keys(r).sort().join()!==Object.keys(expected).sort().join()||Object.keys(expected).some(k=>k!=='accounts'&&k!=='curve'&&r[k as keyof typeof r]!==expected[k as keyof typeof expected])||Object.keys(r.accounts).sort().join()!==Object.keys(expected.accounts).sort().join()||Object.entries(expected.accounts).some(([k,v])=>r.accounts[k as keyof typeof r.accounts]!==v)||BigInt(r.accounts.inputRaw)>(r.accounts.direction==='buy'?nativeBuyBound(maxBuyRaw):tokenUnits(maxSellRaw)))return invalid();
    return{tx:decode(r.unsigned),keys};
  }
  if(r.curve!==undefined)return invalid();
  if (
    ![1,2,3,5].includes(r.version) ||
    (r.version===1?r.accounts.tokenProgram!==undefined:r.accounts.tokenProgram!==TOKEN_PROGRAM) ||
    ([3,5].includes(r.version)?(!Array.isArray(r.accounts.pumpFees)||r.accounts.pumpFees.length!==(r.version===5?1:3)):r.accounts.pumpFees!==undefined) ||
    (r.version===5?r.accounts.pumpV4!==true:r.accounts.pumpV4!==undefined) ||
    !/^[a-f0-9]{64}$/.test(savedHash) ||
    raydium22ReviewHash(r) !== savedHash ||
    ![
      r.minContextSlot,
      r.lastValidBlockHeight,
      r.reviewedAt,
      r.expiresAt,
      r.feeLamports,
      r.tokenRent,
    ].every(integer) ||
    r.minContextSlot < 1 ||
    r.lastValidBlockHeight < 1 ||
    r.expiresAt <= r.reviewedAt ||
    r.expiresAt - r.reviewedAt > 60000 ||
    r.feeLamports < 1 ||
    r.feeLamports > 50000 ||
    typeof r.wrappedCreated !== "boolean" ||
    typeof r.tokenCreated !== "boolean" ||
    (r.tokenCreated && r.accounts.direction !== "buy") ||
    (r.tokenCreated
      ? r.tokenRent < 1 || r.tokenRent > 2500000
      : r.tokenRent !== 0)
  )
    return invalid();
  const tx = decode(r.unsigned),
    message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes),
    keys = message.staticAccounts.map(String),
    a = r.accounts;
  if(message.version!==0)return invalid();
  if(r.pumpTracker){
    const t=r.pumpTracker,ix=message.instructions.at(-1),indices=ix?.accountIndices;
    if(!([3,5].includes(r.version))||(r.version===3&&a.direction!=='buy')||!isMint(t.account)||!integer(t.rent)||t.rent<1||t.rent>2500000||!indices||indices.length!==(r.version===5?30:39)||keys[indices[r.version===5?23:31]]!==t.account||keys.indexOf(t.account)<1)return invalid();
  } else if(r.pumpTracker!==undefined)return invalid();
  if(a.pumpFees?.some(f=>!isMint(f.account)||!isMint(f.owner)||!keys.includes(f.account)||(r.version!==5&&!keys.includes(f.owner))||tokenUnits(f.reserve)<1n)||a.pumpFees&&new Set([a.wallet,a.source,a.destination,a.inputVault,a.outputVault,a.pool,...a.pumpFees.flatMap(f=>[f.account,f.owner])]).size!==(r.version===5?8:12))return invalid();
  if (
    message.version !== 0 ||
    message.header.numSignerAccounts !== 1 ||
    message.header.numReadonlySignerAccounts !== 0 ||
    (message.addressTableLookups?.length ?? 0) !== 0 ||
    Object.keys(tx.signatures).length !== 1 ||
    Object.values(tx.signatures).some((v) => v !== null) ||
    keys[0] !== a.wallet ||
    new Set(keys).size !== keys.length ||
    ![
      a.wallet,
      a.mint,
      a.source,
      a.destination,
      a.inputVault,
      a.outputVault,
      a.pool,
      WSOL,
    ].every((k) => isMint(k) && keys.includes(k)) ||
    new Set([
      a.wallet,
      a.source,
      a.destination,
      a.inputVault,
      a.outputVault,
      a.pool,
    ]).size !== 6 ||
    a.mint === WSOL ||
    !["buy", "sell"].includes(a.direction) ||
    !integer(a.decimals) ||
    a.decimals > 18 ||
    hash(new Uint8Array(tx.messageBytes)) !== r.messageHash ||
    tokenUnits(a.inputRaw) < 1n ||
    tokenUnits(a.minimum) < 1n ||
    tokenUnits(a.inputRaw) > (a.direction === "buy" ? nativeBuyBound(maxBuyRaw) : tokenUnits(maxSellRaw)) ||
    tokenUnits(r.wrappedReserve) < 1n ||
    tokenUnits(r.wrappedReserve) > 2500000n ||
    tokenUnits(r.vaultReserve) < 1n
  )
    return invalid();
  return { tx, keys };
}
export function verifyRaydium22Review(
  r: Raydium22ExecutionReview,
  savedHash: string,
  maxSellRaw?: string,
  maxBuyRaw?: string,
) {
  inspectReview(r, savedHash, maxSellRaw,maxBuyRaw);
}
function inspectSigned(
  r: Raydium22ExecutionReview,
  savedHash: string,
  signed: string,
  maxSellRaw?: string,
  maxBuyRaw?: string,
) {
  const { tx: unsigned, keys } = inspectReview(r, savedHash, maxSellRaw,maxBuyRaw),
    tx = decode(signed);
  const signatures = Object.entries(tx.signatures),
    signature = signatures[0]?.[1];
  if (
    !Buffer.from(tx.messageBytes).equals(Buffer.from(unsigned.messageBytes)) ||
    signatures.length !== 1 ||
    signatures[0][0] !== r.accounts.wallet ||
    !signature ||
    !verify(
      null,
      Buffer.from(tx.messageBytes),
      createPublicKey({
        key: Buffer.concat([
          Buffer.from("302a300506032b6570032100", "hex"),
          bs58.decode(r.accounts.wallet),
        ]),
        format: "der",
        type: "spki",
      }),
      Buffer.from(signature),
    )
  )
    return invalid();
  return { keys, signature: bs58.encode(signature) };
}

// Journal late signer replies even after expiry. This proves message identity
// only and must never be used as permission to send an expired transaction.
export function verifyRaydium22SignedMessage(
  r: Raydium22ExecutionReview,
  savedHash: string,
  signed: string,
  maxSellRaw?: string,
  maxBuyRaw?: string,
) {
  return inspectSigned(r, savedHash, signed, maxSellRaw,maxBuyRaw).signature;
}

// Fresh finalized block height is supplied by the caller. This is signature
// validation only; production consent, durable journal and send claims are separate.
export function bindRaydium22Signed(
  r: Raydium22ExecutionReview,
  savedHash: string,
  signed: string,
  currentBlockHeight: number,
  now = Date.now(),
  maxSellRaw?: string,
  maxBuyRaw?: string,
): Raydium22SignedExecution {
  if (
    !integer(now) ||
    now < r.reviewedAt ||
    now >= r.expiresAt ||
    !integer(currentBlockHeight) ||
    currentBlockHeight < 1 ||
    currentBlockHeight > r.lastValidBlockHeight
  )
    return invalid();
  const { signature } = inspectSigned(r, savedHash, signed, maxSellRaw,maxBuyRaw);
  return { version: 1, reviewHash: savedHash, signed, signature };
}
function inspectExecution(
  r: Raydium22ExecutionReview,
  savedHash: string,
  e: Raydium22SignedExecution,
  maxSellRaw?: string,
  maxBuyRaw?: string,
) {
  if (e.version !== 1 || e.reviewHash !== savedHash) return invalid();
  const checked = inspectSigned(r, savedHash, e.signed, maxSellRaw,maxBuyRaw);
  if (checked.signature !== e.signature) return invalid();
  return checked;
}

// Caller MUST obtain this reply with finalized commitment. Quote expiry is not
// checked here: submitted transactions must remain recoverable after expiry.
export function verifyRaydium22Landed(
  r: Raydium22ExecutionReview,
  savedHash: string,
  e: Raydium22SignedExecution,
  value: unknown,
  maxSellRaw?: string,
  maxBuyRaw?: string,
) {
  const { keys } = inspectExecution(r, savedHash, e, maxSellRaw,maxBuyRaw),
    reply = record(value);
  if (
    reply.version !== 0 ||
    !Array.isArray(reply.transaction) ||
    reply.transaction.length !== 2 ||
    reply.transaction[1] !== "base64" ||
    reply.transaction[0] !== e.signed
  )
    return invalid();
  return {
    ...verifyRaydium22Balances(r, keys, reply.slot, reply.meta),
    signature: e.signature,
  };
}

// Unsigned bank evidence is never a landed receipt and carries no signature.
export function verifyRaydium22Simulation(
  r: Raydium22ExecutionReview,
  savedHash: string,
  value: unknown,
  maxSellRaw?: string,
  maxBuyRaw?: string,
) {
  const { keys } = inspectReview(r, savedHash, maxSellRaw,maxBuyRaw),
    reply = record(value),
    meta = record(reply.value);
  if (meta.replacementBlockhash != null) return invalid();
  const checked = verifyRaydium22Balances(r, keys, record(reply.context).slot, {
    ...meta,
    loadedAddresses: meta.loadedAddresses ?? { readonly: [], writable: [] },
  });
  if (checked.kind !== "succeeded") return invalid();
  return { ...checked, kind: "simulated" as const };
}
function verifyRaydium22Balances(
  r: Raydium22ExecutionReview,
  keys: string[],
  slot: unknown,
  value: unknown,
) {
  const meta = record(value),
    pre = meta.preBalances,
    post = meta.postBalances,
    loaded = record(meta.loadedAddresses);
  if (
    !integer(slot) ||
    slot < r.minContextSlot ||
    !Array.isArray(loaded.readonly) ||
    loaded.readonly.length !== 0 ||
    !Array.isArray(loaded.writable) ||
    loaded.writable.length !== 0 ||
    !Array.isArray(pre) ||
    !Array.isArray(post) ||
    pre.length !== keys.length ||
    post.length !== keys.length ||
    ![...pre, ...post].every(integer) ||
    meta.fee !== r.feeLamports ||
    meta.err === undefined ||
    (meta.err !== null &&
      typeof meta.err !== "string" &&
      (typeof meta.err !== "object" || Array.isArray(meta.err)))
  )
    return invalid();
  if(r.version===4){
    if(!r.curve)return invalid();
    return{...verifyCurveBalances(r.curve,keys,meta),messageHash:r.messageHash,slot,...(meta.err===null?{observedTokenFeeRaw:'0'}:{})};
  }
  const identity = {
      messageHash: r.messageHash,
      slot,
      feeLamports: r.feeLamports.toString(),
    },
    a = r.accounts,
    buy = a.direction === "buy";
  if (meta.err !== null) {
    const before = pre;
    if (
      pre.some(
        (n, i) =>
          BigInt(n) - BigInt(post[i]) !==
          (i === 0 ? BigInt(r.feeLamports) : 0n),
      )
    )
      return invalid();
    const expected = new Map([
      [
        a.source,
        [
          a.wallet,
          buy ? WSOL : a.mint,
          buy ? TOKEN_PROGRAM : (a.tokenProgram??TOKEN_2022),
          buy ? 9 : a.decimals,
        ],
      ],
      [
        a.destination,
        [
          a.wallet,
          buy ? a.mint : WSOL,
          buy ? (a.tokenProgram??TOKEN_2022) : TOKEN_PROGRAM,
          buy ? a.decimals : 9,
        ],
      ],
      [
        a.inputVault,
        [
          a.pool,
          buy ? WSOL : a.mint,
          buy ? TOKEN_PROGRAM : (a.tokenProgram??TOKEN_2022),
          buy ? 9 : a.decimals,
        ],
      ],
      [
        a.outputVault,
        [
          a.pool,
          buy ? a.mint : WSOL,
          buy ? (a.tokenProgram??TOKEN_2022) : TOKEN_PROGRAM,
          buy ? a.decimals : 9,
        ],
      ],
    ]);
    for(const f of a.pumpFees??[])expected.set(f.account,[f.owner,WSOL,TOKEN_PROGRAM,9]);
    // Failed setup is rolled back too. Require full unchanged token evidence for
    // every pre-existing endpoint, with no unrelated accounts hidden in totals.
    function tokens(rows: unknown) {
      if (!Array.isArray(rows)) return invalid();
      const seen = new Set<number>();
      const result = rows.map((v) => {
        const row = record(v),
          ui = record(row.uiTokenAmount),
          i = row.accountIndex;
        if (!integer(i) || seen.has(i) || i >= keys.length || before[i] <= 0)
          return invalid();
        seen.add(i);
        const want = expected.get(keys[i]);
        if (
          !want ||
          row.owner !== want[0] ||
          row.mint !== want[1] ||
          row.programId !== want[2] ||
          ui.decimals !== want[3]
        )
          return invalid();
        return [i, tokenUnits(ui.amount).toString()];
      });
      for (const key of expected.keys()) {
        const i = keys.indexOf(key);
        if (before[i] > 0 && !seen.has(i)) return invalid();
        if (
          before[i] === 0 &&
          key !== a.destination &&
          !(buy && key === a.source)
        )
          return invalid();
      }
      return JSON.stringify(result.sort((x, y) => Number(x[0]) - Number(y[0])));
    }
    if (tokens(meta.preTokenBalances) !== tokens(meta.postTokenBalances))
      return invalid();
    return { ...identity, kind: "failed" as const };
  }
  const settled = verifyRaydium22TokenSettlement(a, meta, keys),
    wrapped = buy ? a.source : a.destination,
    vault = buy ? a.inputVault : a.outputVault,
    wi = keys.indexOf(wrapped),
    vi = keys.indexOf(vault),
    ti = keys.indexOf(buy ? a.destination : a.source),
    wrappedRent = r.wrappedCreated ? tokenUnits(r.wrappedReserve) : 0n,
    rent = wrappedRent + BigInt(r.tokenRent) + BigInt(r.pumpTracker?.rent??0);
  const trackerIndex=r.pumpTracker?keys.indexOf(r.pumpTracker.account):-1;
  if(r.pumpTracker&&(pre[trackerIndex]!==0||post[trackerIndex]!==r.pumpTracker.rent))return invalid();
  if (
    (pre[wi] === 0) !== r.wrappedCreated ||
    (pre[ti] === 0) !== r.tokenCreated ||
    BigInt(pre[0]) - BigInt(post[0]) !==
      BigInt(r.feeLamports) + rent + (buy ? settled.input : 0n) ||
    BigInt(post[wi]) - BigInt(pre[wi]) !==
      settled.after.get(wrapped)! -
        settled.before.get(wrapped)! +
        wrappedRent ||
    BigInt(post[vi]) - BigInt(pre[vi]) !==
      (buy ? settled.input-settled.nativeFees : -settled.received-settled.nativeFees) ||
    (r.tokenCreated && post[ti] !== r.tokenRent) ||
    keys.some(
      (_, i) =>
        ![0, wi, vi, ...(r.pumpTracker?[trackerIndex]:[]), ...(a.pumpFees??[]).map(f=>keys.indexOf(f.account)), ...(r.tokenCreated ? [ti] : [])].includes(i) &&
        pre[i] !== post[i],
    )
  )
    return invalid();
  for (const [key, reserve] of [
    [wrapped, r.wrappedReserve],
    [vault, r.vaultReserve],
  ]) {
    const i = keys.indexOf(key),
      reserveRaw = tokenUnits(reserve);
    if (
      BigInt(post[i]) - settled.after.get(key)! !== reserveRaw ||
      (pre[i] !== 0 && BigInt(pre[i]) - settled.before.get(key)! !== reserveRaw)
    )
      return invalid();
  }
  return {
    ...identity,
    kind: "succeeded" as const,
    inputRaw: settled.input.toString(),
    outputRaw: settled.received.toString(),
    rentLamports: rent.toString(),
    observedTokenFeeRaw: settled.observedTokenFee.toString(),
  };
}

// A null or unavailable receipt is never evidence to release budget or credit a
// position. The adapter performs one finalized read, with no send/retry side effect.
export async function recoverRaydium22Execution(
  r: Raydium22ExecutionReview,
  savedHash: string,
  e: Raydium22SignedExecution,
  rpc: Rpc,
  maxSellRaw?: string,
  maxBuyRaw?: string,
) {
  try {
    inspectExecution(r, savedHash, e, maxSellRaw,maxBuyRaw);
  } catch {
    return { kind: "inconsistent" as const };
  }
  let value: unknown;
  try {
    value = await rpc("getTransaction", [
      e.signature,
      {
        encoding: "base64",
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      },
    ]);
  } catch {
    return { kind: "unavailable" as const };
  }
  if (value === null) return { kind: "pending" as const };
  try {
    return verifyRaydium22Landed(r, savedHash, e, value, maxSellRaw,maxBuyRaw);
  } catch {
    return { kind: "inconsistent" as const };
  }
}

// Version 4 explicitly represents native SOL curve proceeds; zero reserves are
// inapplicable fields, not WSOL accounts. Only the curve verifier handles it.
export function curveExecutionReview(c:CurveReview):Raydium22ExecutionReview{
 const buy=c.request.direction==='buy';
 return{version:4,curve:c,unsigned:c.unsigned,messageHash:c.messageHash,accounts:{...(c.tokenProgram===TOKEN_PROGRAM?{tokenProgram:TOKEN_PROGRAM}:{}),wallet:c.request.wallet,mint:c.request.mint,decimals:c.decimals,direction:c.request.direction,source:buy?c.request.wallet:c.tokenAccount,destination:buy?c.tokenAccount:c.request.wallet,inputVault:buy?c.curve:c.curveTokenAccount,outputVault:buy?c.curveTokenAccount:c.curve,pool:c.curve,inputRaw:c.request.inputRaw,minimum:c.minimumRaw},minContextSlot:c.minContextSlot,lastValidBlockHeight:c.lastValidBlockHeight,reviewedAt:c.reviewedAt,expiresAt:c.expiresAt,feeLamports:c.feeLamports,wrappedCreated:false,tokenCreated:c.tokenRent>0,wrappedReserve:'0',vaultReserve:'0',tokenRent:c.tokenRent};
}
export function curveNativeResult(s:{review:CurveReview;outcome:{outputRaw:string;rentLamports:string}}){
 const executionReview=curveExecutionReview(s.review);
 return{executionReview,executionReviewHash:raydium22ReviewHash(executionReview),receivedRaw:s.outcome.outputRaw,slot:s.review.minContextSlot,networkFeeLamports:s.review.feeLamports,rentLamports:Number(s.outcome.rentLamports),maximumSetupRentLamports:s.review.tokenRent+s.review.trackerRent+(s.review.curveRent??0)};
}
