import {nativeBuyBound} from './native-buy-bound.js';
// Public-state engineering probe. Never signs, submits or activates execution.
import {
  address,
  blockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getTransactionEncoder,
  getCompiledTransactionMessageDecoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import type { Instruction } from "@solana/kit";
import { createHash } from "node:crypto";
import {NATIVE_PRIORITY_MICROLAMPORTS} from './native-priority.js';
import bs58 from "bs58";
import { record } from "../src/live-orders.js";
import { isMint } from "../src/assets.js";
import { TOKEN_PROGRAM, WSOL } from "../src/funding-model.js";
import { ATA_PROGRAM, toBase64 } from "../src/transaction-review.js";
import {
  COMPUTE_PROGRAM,
  instructionBytes,
  swapRaw,
} from "../src/copy-swap.js";
import { TOKEN_2022 } from "./jupiter-routes.js";
import {
  inspectToken2022Mint,
  token2022Bytes,
  verifyToken2022Account,
  tokenExtensions,
} from "./token2022-setup.js";
import {inspectStandardNativeMint,standardNativeBytes,verifyStandardNativeAccount} from "./standard-native-accounts.js";
import { inspectRaydium22Route, inspectStandardRaydiumRoute } from "./token2022-raydium.js";
import {PUMP_AMM_PROGRAM} from '../src/copy-pumpswap.js';
import {inspectNativePumpSwapRoute} from './native-pumpswap-route.js';
import type { Raydium22Request } from "./token2022-raydium.js";
import type { Rpc } from "./funding.js";
import { CLOCK, clockEpoch, inspectTokenFees } from "./token-fees.js";
import { transferAmounts } from "../src/token-fees.js";
import { verifyRaydium22TokenSettlement } from "./token2022-settlement.js";
import {
  raydium22ReviewHash,
  type Raydium22ExecutionReview,
} from "./token2022-recovery.js";
const SYSTEM = "11111111111111111111111111111111";
const integer = (n: unknown): n is number =>
  Number.isSafeInteger(n) && (n as number) >= 0;
const invalid = (): never => {
  throw Error(
    "Token-2022 Raydium simulation evidence is incomplete or changed.",
  );
};
function nativeAccount(value: unknown, owner: string, allowUnsyncedVault = false) {
  const a = record(value),
    d = a.data;
  if (
    a.owner !== TOKEN_PROGRAM ||
    a.executable !== false ||
    !integer(a.lamports) ||
    !Array.isArray(d) ||
    d.length !== 2 ||
    d[1] !== "base64" ||
    typeof d[0] !== "string"
  )
    return invalid();
  const b = Buffer.from(d[0], "base64");
  if (
    b.length !== 165 ||
    b.toString("base64") !== d[0] ||
    bs58.encode(b.subarray(0, 32)) !== WSOL ||
    bs58.encode(b.subarray(32, 64)) !== owner ||
    b[108] !== 1 ||
    b.readUInt32LE(72) !== 0 ||
    b.readUInt32LE(129) !== 0 ||
    b.readBigUInt64LE(121) !== 0n ||
    b.readUInt32LE(109) !== 1 ||
    (allowUnsyncedVault ? BigInt(a.lamports) < b.readBigUInt64LE(64) + b.readBigUInt64LE(113) : BigInt(a.lamports) !== b.readBigUInt64LE(64) + b.readBigUInt64LE(113))
  )
    return invalid();
  return b;
}
async function simulateNativeRaydiumSwap(
  build: unknown,
  request: Raydium22Request,
  rpc: Rpc,
  maxSellRaw = '1000000',
  existingSellOnly = false,
  priorityMicroLamports = 0,
  tokenProgram: typeof TOKEN_PROGRAM | typeof TOKEN_2022 = TOKEN_2022,
  pump = false,
  reuseExistingWrapped = false,
  maxBuyRaw = '10000000',
) {
  const standard=tokenProgram===TOKEN_PROGRAM;
  if(pump&&!standard)return invalid();
  const inspectMint=standard?inspectStandardNativeMint:inspectToken2022Mint;
  const mintBytes=standard?standardNativeBytes:token2022Bytes;
  const verifyAccount=(value:unknown,wallet:string,mint:string,config:ReturnType<typeof inspectMint>)=>{
    if(config.accountSize===165) return verifyStandardNativeAccount(value,wallet,mint);
    return verifyToken2022Account(value,wallet,mint,config);
  };
  const programField:{tokenProgram?:typeof TOKEN_PROGRAM}=standard?{tokenProgram:TOKEN_PROGRAM}:{};
  if(![0,NATIVE_PRIORITY_MICROLAMPORTS].includes(priorityMicroLamports))return invalid();
  // One pool, retained WSOL, and locally built setup only.
  // Fresh SOL buys preserve any existing wrapped SOL balance.
  // Bound buys to 0.01 SOL and sells to 1,000,000 raw token units.
  const buy = request.direction === "buy";
  if(existingSellOnly && buy) return invalid();
  if (
    !["buy", "sell"].includes(request.direction) ||
    swapRaw(request.inputRaw) > (buy ? nativeBuyBound(maxBuyRaw) : swapRaw(maxSellRaw))
  )
    return invalid();
  const latest = record(
      await rpc("getLatestBlockhash", [{ commitment: "finalized" }]),
    ),
    life = record(latest.value),
    firstSlot = record(latest.context).slot;
  if (
    !integer(firstSlot) ||
    firstSlot < 1 ||
    !isMint(String(life.blockhash)) ||
    !integer(life.lastValidBlockHeight) ||
    life.lastValidBlockHeight < 1
  )
    return invalid();
  const review = pump ? await inspectNativePumpSwapRoute(build,request,rpc,firstSlot) : await (standard?inspectStandardRaydiumRoute:inspectRaydium22Route)(
    build,
    request,
    rpc,
    firstSlot,
    true,
  );
  if (review.segments.length !== 1) return invalid();
  const { wallet, mint } = request,
    { source, destination } = review,
    segment = review.segments[0],
    inputVault = segment[pump?(buy?9:8):6].pubkey,
    outputVault = segment[pump?(buy?8:9):7].pubkey,
    pool = segment[pump?1:3].pubkey;
  const pumpRoute=pump?review as Awaited<ReturnType<typeof inspectNativePumpSwapRoute>>:undefined;
  const pumpV4=pumpRoute?.pumpV4===true;
  const pumpFees=pump?(review as Awaited<ReturnType<typeof inspectNativePumpSwapRoute>>).fees:[];
  const missingTracker=pump?(review as Awaited<ReturnType<typeof inspectNativePumpSwapRoute>>).missingTracker:undefined;
  const trackerRent=missingTracker?await rpc('getMinimumBalanceForRentExemption',[137,{commitment:'finalized'}]):0;
  if(!integer(trackerRent)||trackerRent>2500000||(missingTracker&&trackerRent<1))return invalid();
  const state = record(
      await rpc("getMultipleAccounts", [
        [mint, source, destination, wallet],
        {
          encoding: "base64",
          commitment: "finalized",
          minContextSlot: review.slot,
        },
      ]),
    ),
    slot = record(state.context).slot;
  if (
    !integer(slot) ||
    slot < review.slot ||
    !Array.isArray(state.value) ||
    state.value.length !== 4
  )
    return invalid();
  const [mintAccount, sourceAccount, destinationAccount, payer] = state.value,
    config = inspectMint(mintAccount, mint),
    decimals = mintBytes(mintAccount)[44];
  if (
    record(payer).owner !== SYSTEM ||
    record(payer).executable !== false ||
    !integer(record(payer).lamports)
  )
    return invalid();
  if (buy && destinationAccount !== null)
    verifyAccount(destinationAccount, wallet, mint, config);
  if (!buy) {
    verifyAccount(sourceAccount, wallet, mint, config);
    if (
      mintBytes(sourceAccount).readBigUInt64LE(64) <
      BigInt(request.inputRaw)
    )
      return invalid();
  }
  const wrappedAccount = buy ? source : destination;
  const wrappedBefore = buy ? sourceAccount : destinationAccount;
  if(existingSellOnly && wrappedBefore === null) return invalid();
  const omitWrappedSetup = existingSellOnly || (buy && reuseExistingWrapped && wrappedBefore !== null);
  const wrappedBeforeBytes =
    wrappedBefore === null ? null : nativeAccount(wrappedBefore, wallet);
  const sourceRent = await rpc("getMinimumBalanceForRentExemption", [
      165,
      { commitment: "finalized" },
    ]),
    destRent = await rpc("getMinimumBalanceForRentExemption", [
      config.accountSize,
      { commitment: "finalized" },
    ]);
  if (
    !integer(sourceRent) ||
    !integer(destRent) ||
    sourceRent < 1 ||
    destRent < 1 ||
    sourceRent > 2500000 ||
    destRent > 2500000
  )
    return invalid();
  const ata = (
    account: string,
    token: string,
    program: string,
  ): Instruction => ({
    programAddress: address(ATA_PROGRAM),
    accounts: [
      { address: address(wallet), role: 3 },
      { address: address(account), role: 1 },
      { address: address(wallet), role: 0 },
      { address: address(token), role: 0 },
      { address: address(SYSTEM), role: 0 },
      { address: address(program), role: 0 },
    ],
    data: new Uint8Array([1]),
  });
  const transfer = Buffer.alloc(12);
  transfer.writeUInt32LE(2);
  transfer.writeBigUInt64LE(BigInt(request.inputRaw), 4);
  const priority=Buffer.alloc(9);priority[0]=3;priority.writeBigUInt64LE(BigInt(priorityMicroLamports),1);
  const instructions: Instruction[] = [
    {
      programAddress: address(COMPUTE_PROGRAM),
      data: new Uint8Array([2, 128, 26, 6, 0]),
    }, // 400,000 units; optional fixed 2,000-lamport prioritization fee.
    ...(priorityMicroLamports?[{programAddress:address(COMPUTE_PROGRAM),data:new Uint8Array(priority)}]:[]),
    ...(omitWrappedSetup ? [] : [ata(wrappedAccount, WSOL, TOKEN_PROGRAM)]),
    ...(buy ? [ata(destination, mint, tokenProgram)] : []),
    ...(buy
      ? ([
          {
            programAddress: address(SYSTEM),
            accounts: [
              { address: address(wallet), role: 3 },
              { address: address(source), role: 1 },
            ],
            data: transfer,
          },
          {
            programAddress: address(TOKEN_PROGRAM),
            accounts: [{ address: address(source), role: 1 }],
            data: new Uint8Array([17]),
          },
        ] as Instruction[])
      : []),
    {
      programAddress: address(review.swap.programId),
      accounts: review.swap.accounts.map((a) => ({
        address: address(a.pubkey),
        role: ((a.isSigner ? 2 : 0) + (a.isWritable ? 1 : 0)) as 0 | 1 | 2 | 3,
      })),
      data: instructionBytes(review.swap.data),
    },
  ];
  const tx = compileTransaction(
    appendTransactionMessageInstructions(
      instructions,
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash(String(life.blockhash)),
          lastValidBlockHeight: BigInt(life.lastValidBlockHeight),
        },
        setTransactionMessageFeePayer(
          address(wallet),
          createTransactionMessage({ version: 0 }),
        ),
      ),
    ),
  );
  const encoded = new Uint8Array(getTransactionEncoder().encode(tx));
  if (
    encoded.length > 1232 ||
    Object.values(tx.signatures).some((s) => s !== null)
  )
    return invalid();
  const feeReply = record(
      await rpc("getFeeForMessage", [
        toBase64(new Uint8Array(tx.messageBytes)),
        { commitment: "finalized", minContextSlot: slot },
      ]),
    ),
    fee = feeReply.value,
    feeSlot = record(feeReply.context).slot;
  if (
    !integer(fee) ||
    fee < 1 ||
    fee > 50000 ||
    !integer(feeSlot) ||
    feeSlot < slot
  )
    return invalid();
  const result = record(
      await rpc("simulateTransaction", [
        toBase64(encoded),
        {
          encoding: "base64",
          commitment: "finalized",
          sigVerify: false,
          replaceRecentBlockhash: false,
          minContextSlot: slot,
          accounts: {
            encoding: "base64",
            addresses: [
              source,
              destination,
              mint,
              inputVault,
              outputVault,
              ...pumpFees.map(f=>f.account),
              ...(missingTracker?[missingTracker]:[]),
              ...(config.transferFee ? [CLOCK] : []),
              ...(pumpV4?[pool]:[]),
            ],
          },
        },
      ]),
    ),
    sim = record(result.value),
    simulationSlot = record(result.context).slot;
  if (
    !integer(simulationSlot) ||
    simulationSlot < slot ||
    sim.err !== null ||
    sim.replacementBlockhash != null ||
    sim.fee !== fee ||
    !Array.isArray(sim.accounts) ||
    sim.accounts.length !== (config.transferFee ? 6 : 5)+pumpFees.length+(missingTracker?1:0)+(pumpV4?1:0)
  )
    return invalid();
  if (inspectMint(sim.accounts[2], mint).mintHash !== config.mintHash)
    return invalid();
  verifyAccount(sim.accounts[buy ? 1 : 0], wallet, mint, config);
  verifyAccount(sim.accounts[buy ? 4 : 3], pool, mint, config);
  const wrappedBytes = nativeAccount(sim.accounts[buy ? 0 : 1], wallet),
    nativeVaultBytes = nativeAccount(sim.accounts[buy ? 3 : 4], pool, standard);
  if (
    wrappedBytes.readBigUInt64LE(113) !==
    (wrappedBeforeBytes
      ? wrappedBeforeBytes.readBigUInt64LE(113)
      : BigInt(sourceRent))
  )
    return invalid();
  const keys = getCompiledTransactionMessageDecoder()
    .decode(tx.messageBytes)
    .staticAccounts.map(String);
  if (
    keys[0] !== wallet ||
    !Array.isArray(sim.preBalances) ||
    !Array.isArray(sim.postBalances) ||
    sim.preBalances.length !== keys.length ||
    sim.postBalances.length !== keys.length ||
    [...sim.preBalances, ...sim.postBalances].some((n) => !integer(n))
  )
    return invalid();
  const pre = sim.preBalances as number[],
    post = sim.postBalances as number[],
    sourceIndex = keys.indexOf(source),
    destIndex = keys.indexOf(destination),
    vaultIndex = keys.indexOf(buy ? inputVault : outputVault),
    wrappedIndex = keys.indexOf(wrappedAccount);
  const trackerIndex=missingTracker?keys.indexOf(missingTracker):-1;
  if(missingTracker){
    const value=record(sim.accounts[5+pumpFees.length]),data=value.data;
    if(trackerIndex<1||value.owner!==PUMP_AMM_PROGRAM||value.executable!==false||value.lamports!==trackerRent||!Array.isArray(data)||data.length!==2||data[1]!=='base64'||typeof data[0]!=='string')return invalid();
    const b=Buffer.from(data[0],'base64'),disc=createHash('sha256').update('account:UserVolumeAccumulator').digest().subarray(0,8);
    if(b.length!==137||b.toString('base64')!==data[0]||!b.subarray(0,8).equals(disc)||bs58.encode(b.subarray(8,40))!==wallet||b[40]>1||b[73]>1||pre[trackerIndex]!==0||post[trackerIndex]!==trackerRent)return invalid();
  }
  const feeAccounts=pumpFees.map((f,i)=>{
    const bytes=nativeAccount((sim.accounts as unknown[])[5+i],f.owner,true),accountIndex=keys.indexOf(f.account);
    if(accountIndex<1||record((sim.accounts as unknown[])[5+i]).lamports!==post[accountIndex])return invalid();
    const reserve=BigInt(post[accountIndex])-bytes.readBigUInt64LE(64);
    if(reserve<bytes.readBigUInt64LE(113))return invalid();
    return {...f,reserve:reserve.toString()};
  });
  const feeIndices=feeAccounts.map(f=>keys.indexOf(f.account));
  const feeLamports=feeIndices.reduce((sum,i)=>sum+BigInt(post[i])-BigInt(pre[i]),0n);
  const pumpField= pump ? {pumpFees:feeAccounts,...(pumpV4?{pumpV4:true as const}:{})} : {};
  if (
    [sourceIndex, destIndex, vaultIndex].some((n) => n < 1) ||
    (wrappedBefore === null) !== (pre[wrappedIndex] === 0) ||
    post[wrappedIndex] !==
      Number(
        wrappedBytes.readBigUInt64LE(113) + wrappedBytes.readBigUInt64LE(64),
      ) ||
    (buy && (destinationAccount === null) !== (pre[destIndex] === 0))
  )
    return invalid();
  if (
    [source, destination, mint, inputVault, outputVault].some(
      (key, i) =>
        record((sim.accounts as unknown[])[i]).lamports !==
        post[keys.indexOf(key)],
    )
  )
    return invalid();
  const rent =
      (wrappedBefore === null ? sourceRent : 0) +
      (buy && pre[destIndex] === 0 ? destRent : 0) + trackerRent,
    gross = BigInt(request.inputRaw);
  if (
    (buy && pre[destIndex] === 0 && post[destIndex] !== destRent) ||
    BigInt(pre[0]) - BigInt(post[0]) !==
      (buy ? gross : 0n) + BigInt(rent + fee) ||
    BigInt(post[vaultIndex]) - BigInt(pre[vaultIndex]) !==
      (buy
        ? gross-feeLamports
        : -(
            BigInt(post[wrappedIndex]) -
            BigInt(pre[wrappedIndex]) -
            BigInt(wrappedBefore === null ? sourceRent : 0)
          )-feeLamports) ||
    keys.some(
      (_, i) =>
        ![
          0,
          wrappedIndex,
          vaultIndex,
          ...feeIndices,
          ...(missingTracker?[trackerIndex]:[]),
          ...(buy && pre[destIndex] === 0 ? [destIndex] : []),
        ].includes(i) && pre[i] !== post[i],
    )
  )
    return invalid();
  const { before, after, received, tokenGross, tokenNet } =
    verifyRaydium22TokenSettlement(
      {
        ...programField,
        ...pumpField,
        wallet,
        mint,
        decimals,
        direction: request.direction,
        source,
        destination,
        inputVault,
        outputVault,
        pool,
        inputRaw: request.inputRaw,
        minimum: review.minimum,
      },
      sim,
      keys,
    );
  const rawAccounts = new Map([
    [source, buy ? wrappedBytes : mintBytes(sim.accounts[0])],
    [destination, buy ? mintBytes(sim.accounts[1]) : wrappedBytes],
    [inputVault, buy ? nativeVaultBytes : mintBytes(sim.accounts[3])],
    [outputVault, buy ? mintBytes(sim.accounts[4]) : nativeVaultBytes],
  ]);
  for (const [key, bytes] of rawAccounts)
    if (after.get(key)! !== bytes.readBigUInt64LE(64)) return invalid();
  // Native account reserves must agree with this bank's starting balance;
  // do not substitute a balance read from the earlier account snapshot.
  if (
    wrappedBeforeBytes &&
    BigInt(pre[wrappedIndex]) - before.get(wrappedAccount)! !==
      wrappedBeforeBytes.readBigUInt64LE(113)
  )
    return invalid();
  // A pool vault can receive unsolicited lamports without SyncNative. Preserve
  // the exact surplus through the swap; it is never wallet proceeds or input.
  const vaultOffset=BigInt(post[vaultIndex])-after.get(buy?inputVault:outputVault)!;
  if(vaultOffset!==BigInt(pre[vaultIndex])-before.get(buy?inputVault:outputVault)! ||
    vaultOffset<nativeVaultBytes.readBigUInt64LE(113)) return invalid();
  if(pumpV4){
    // AMM v2 retains protocol/creator quote fees in the pool. Their counters
    // may change, but the pool identity, modes and all reserved bytes may not.
    const account=record(sim.accounts.at(-1)),d=account.data;
    if(account.owner!==PUMP_AMM_PROGRAM||account.executable!==false||account.lamports!==post[keys.indexOf(pool)]||!Array.isArray(d)||d.length!==2||d[1]!=='base64'||typeof d[0]!=='string')return invalid();
    const b=Buffer.from(d[0],'base64'),prior=Buffer.from(pumpRoute!.poolBefore!);
    if(b.length!==301||prior.length!==301||b.toString('base64')!==d[0]||!b.subarray(0,245).equals(prior.subarray(0,245))||!b.subarray(261,271).equals(prior.subarray(261,271))||!b.subarray(287).equals(prior.subarray(287)))return invalid();
    const protocol=b.readBigUInt64LE(271),creator=b.readBigUInt64LE(279);
    const signed128=(v:Buffer)=>BigInt.asIntN(128,v.readBigUInt64LE(245)+(v.readBigUInt64LE(253)<<64n));
    const retainedBefore=prior.readBigUInt64LE(271)+prior.readBigUInt64LE(279);
    if(protocol<prior.readBigUInt64LE(271)||creator<prior.readBigUInt64LE(279)||protocol+creator>after.get(buy?inputVault:outputVault)!||signed128(b)!==-(protocol+creator)||signed128(prior)!==-retainedBefore)return invalid();
  }
  const wrappedIncrease =
    after.get(wrappedAccount)! - before.get(wrappedAccount)!;
  if (
    BigInt(post[wrappedIndex]) - BigInt(pre[wrappedIndex]) !==
    wrappedIncrease + BigInt(wrappedBefore === null ? sourceRent : 0)
  )
    return invalid();
  const epoch = config.transferFee
    ? clockEpoch(sim.accounts[5], simulationSlot)
    : "0";
  const fees = standard?{current:{epoch:'0',basisPoints:0,maximumRaw:'0'}}:inspectTokenFees(sim.accounts[2], mint, epoch);
  const tokenTransfer = transferAmounts(tokenGross.toString(), fees.current);
  if (BigInt(tokenTransfer.netRaw) !== tokenNet) return invalid();
  if (config.transferFee && buy) {
    // New destinations prove the exact withheld total. Existing destinations
    // have no raw pre-state in this bank: verify gross/net and a lower bound.
    const withheld = tokenExtensions(mintBytes(sim.accounts[1]), 2).get(2);
    if (
      !withheld ||
      (destinationAccount === null
        ? withheld.readBigUInt64LE(0) !== BigInt(tokenTransfer.feeRaw)
        : withheld.readBigUInt64LE(0) < BigInt(tokenTransfer.feeRaw))
    )
      return invalid();
  }
  if (config.transferFee && !buy) {
    const held = tokenExtensions(mintBytes(sim.accounts[3]), 2).get(2);
    // The pool existed before this bank. Its prior withheld amount is unknown;
    // gross/net deltas prove the fee, while this is only a lower-bound check.
    if (!held || held.readBigUInt64LE(0) < BigInt(tokenTransfer.feeRaw))
      return invalid();
  }
  const reviewedAt = Date.now();
  const executionReview: Raydium22ExecutionReview = {
    version: pump?(pumpV4?5:3):standard?2:1,
    ...(missingTracker?{pumpTracker:{account:missingTracker,rent:trackerRent}}:{}),
    unsigned: toBase64(encoded),
    messageHash: createHash("sha256")
      .update(new Uint8Array(tx.messageBytes))
      .digest("hex"),
    accounts: {
      ...programField,
      ...pumpField,
      wallet,
      mint,
      decimals,
      direction: request.direction,
      source,
      destination,
      inputVault,
      outputVault,
      pool,
      inputRaw: request.inputRaw,
      minimum: review.minimum,
    },
    minContextSlot: simulationSlot,
    lastValidBlockHeight: life.lastValidBlockHeight as number,
    reviewedAt,
    expiresAt: reviewedAt + 60000,
    feeLamports: fee,
    wrappedCreated: wrappedBefore === null,
    tokenCreated: buy && destinationAccount === null,
    wrappedReserve: wrappedBytes.readBigUInt64LE(113).toString(),
    vaultReserve: vaultOffset.toString(),
    tokenRent: buy && destinationAccount === null ? destRent : 0,
  };
  return {
    status: "simulated" as const,
    direction: request.direction,
    ...(config.transferFee
      ? {
          transferFee: {
            epoch,
            ...tokenTransfer,
            basisPoints: fees.current.basisPoints,
            maximumRaw: fees.current.maximumRaw,
            withheldEvidence:
              buy && destinationAccount === null
                ? ("exact-new-account" as const)
                : ("existing-account-lower-bound" as const),
          },
        }
      : {}),
    slot: simulationSlot,
    wallet,
    mint,
    inputRaw: request.inputRaw,
    receivedRaw: received.toString(),
    minimumRaw: review.minimum,
    networkFeeLamports: fee,
    rentLamports: rent,
    maximumSetupRentLamports: (omitWrappedSetup ? 0 : sourceRent) + (buy ? destRent : 0) + trackerRent,
    retainedWrappedSol: wrappedAccount,
    accounts: {
      wrappedSolCreated: wrappedBefore === null,
      tokenCreated: buy && destinationAccount === null,
      wrappedSolBeforeRaw: before.get(wrappedAccount)!.toString(),
      wrappedSolAfterRaw: after.get(wrappedAccount)!.toString(),
      tokenBeforeRaw: before.get(buy ? destination : source)!.toString(),
      tokenAfterRaw: after.get(buy ? destination : source)!.toString(),
    },
    transactionBytes: encoded.length,
    messageHash: executionReview.messageHash,
    executionReview,
    executionReviewHash: raydium22ReviewHash(executionReview),
  };
}

// Compatibility entry point keeps the original buy-only contract.
export async function simulateRaydium22Buy(
  build: unknown,
  request: Raydium22Request,
  rpc: Rpc,
) {
  if (request.direction !== "buy") return invalid();
  return simulateRaydium22Swap(build, request, rpc);
}

// Existing Token-2022 callers retain the same program and review version.
export function simulateRaydium22Swap(build:unknown,request:Raydium22Request,rpc:Rpc,maxSellRaw='1000000',existingSellOnly=false,priorityMicroLamports=0,reuseExistingWrapped=false,maxBuyRaw='10000000'){
 return simulateNativeRaydiumSwap(build,request,rpc,maxSellRaw,existingSellOnly,priorityMicroLamports,TOKEN_2022,false,reuseExistingWrapped,maxBuyRaw);
}
export function simulateStandardNativeSwap(build:unknown,request:Raydium22Request,rpc:Rpc,maxSellRaw='1000000',existingSellOnly=false,priorityMicroLamports=0,reuseExistingWrapped=false,maxBuyRaw='10000000'){
 return simulateNativeRaydiumSwap(build,request,rpc,maxSellRaw,existingSellOnly,priorityMicroLamports,TOKEN_PROGRAM,false,reuseExistingWrapped,maxBuyRaw);
}
export function simulatePumpNativeSwap(build:unknown,request:Raydium22Request,rpc:Rpc,maxSellRaw='1000000',existingSellOnly=false,priorityMicroLamports=0,reuseExistingWrapped=false,maxBuyRaw='10000000'){
 return simulateNativeRaydiumSwap(build,request,rpc,maxSellRaw,existingSellOnly,priorityMicroLamports,TOKEN_PROGRAM,true,reuseExistingWrapped,maxBuyRaw);
}
