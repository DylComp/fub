import { createRequire } from "node:module";
import {
  Connection,
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  unpackMint,
  unpackAccount,
  getExtensionTypes,
  ExtensionType,
  MintLayout,
  ACCOUNT_SIZE,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  createBurnCheckedInstruction,
} from "@solana/spl-token";
import { buybackInput } from "./buyback-model.js";
import type { BuybackPlan, BuybackPolicy } from "./buyback-model.js";
import { rawLamports } from "./launch-payout-model.js";
const require = createRequire(import.meta.url),
  amm =
    require("@pump-fun/pump-swap-sdk") as typeof import("@pump-fun/pump-swap-sdk"),
  next = require("@pump-fun/pump-sdk-next") as typeof import("@pump-fun/pump-sdk-next"),
  pump = require("@pump-fun/pump-sdk") as typeof import("@pump-fun/pump-sdk"),
  BN = require("bn.js") as typeof import("bn.js");
const integer = (n: number) => {
  if (!Number.isSafeInteger(n) || n < 0) throw Error("Unsafe AMM RPC integer");
  return BigInt(n);
};
export function ammBuybackAddresses(
  mint: PublicKey,
  user: PublicKey,
  program: PublicKey,
) {
  const pool = amm.canonicalPumpPoolPda(mint);
  return {
    pool,
    base: getAssociatedTokenAddressSync(mint, user, false, program),
    quote: getAssociatedTokenAddressSync(NATIVE_MINT, user),
    poolBase: getAssociatedTokenAddressSync(mint, pool, true, program),
    poolQuote: getAssociatedTokenAddressSync(NATIVE_MINT, pool, true),
  };
}
// Every account is derived, never accepted from a quote service or arbitrary plan metadata.
export async function ammBuybackInstructions(p: BuybackPlan) {
  const mint = new PublicKey(p.policy.mint),
    user = new PublicKey(p.policy.treasury),
    program = new PublicKey(p.tokenProgram),
    creator = new PublicKey(p.creator),
    recipient = new PublicKey(p.feeRecipient),
    buyback = new PublicKey(p.buybackFeeRecipient),
    a = ammBuybackAddresses(mint, user, program),
    creatorVault = amm.coinCreatorVaultAuthorityPda(creator);
  if(p.ammVersion!==undefined && p.ammVersion!==2)throw Error("Unsupported AMM buyback instruction version");
  const buy = p.ammVersion===2 ? await next.getPumpAmmProgram(new Connection("http://127.0.0.1:8899")).methods.buyV2(new BN(p.tokens),new BN(p.inputCap)).accountsStrict({pool:a.pool,user,globalConfig:amm.GLOBAL_CONFIG_PDA,baseMint:mint,quoteMint:NATIVE_MINT,userBaseTokenAccount:a.base,userQuoteTokenAccount:a.quote,poolBaseTokenAccount:a.poolBase,poolQuoteTokenAccount:a.poolQuote,baseTokenProgram:program,quoteTokenProgram:TOKEN_PROGRAM_ID,systemProgram:SystemProgram.programId,userVolumeAccumulator:amm.userVolumeAccumulatorPda(user),feeConfig:amm.PUMP_AMM_FEE_CONFIG_PDA,buybackFeeRecipient:getAssociatedTokenAddressSync(NATIVE_MINT,buyback,true),eventAuthority:amm.PUMP_AMM_EVENT_AUTHORITY_PDA,program:amm.PUMP_AMM_PROGRAM_ID}).instruction() : await amm.OFFLINE_PUMP_AMM_PROGRAM.methods
    .buy(new BN(p.tokens), new BN(p.inputCap), { 0: false })
    .accountsStrict({
      pool: a.pool,
      user,
      globalConfig: amm.GLOBAL_CONFIG_PDA,
      baseMint: mint,
      quoteMint: NATIVE_MINT,
      userBaseTokenAccount: a.base,
      userQuoteTokenAccount: a.quote,
      poolBaseTokenAccount: a.poolBase,
      poolQuoteTokenAccount: a.poolQuote,
      protocolFeeRecipient: recipient,
      protocolFeeRecipientTokenAccount: getAssociatedTokenAddressSync(
        NATIVE_MINT,
        recipient,
        true,
      ),
      baseTokenProgram: program,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      eventAuthority: amm.PUMP_AMM_EVENT_AUTHORITY_PDA,
      program: amm.PUMP_AMM_PROGRAM_ID,
      coinCreatorVaultAta: getAssociatedTokenAddressSync(
        NATIVE_MINT,
        creatorVault,
        true,
      ),
      coinCreatorVaultAuthority: creatorVault,
      globalVolumeAccumulator: amm.GLOBAL_VOLUME_ACCUMULATOR_PDA,
      userVolumeAccumulator: amm.userVolumeAccumulatorPda(user),
      feeConfig: amm.PUMP_AMM_FEE_CONFIG_PDA,
      feeProgram: amm.PUMP_FEE_PROGRAM_ID,
    })
    .remainingAccounts([
      { pubkey: amm.poolV2Pda(mint), isWritable: false, isSigner: false },
      { pubkey: buyback, isWritable: false, isSigner: false },
      {
        pubkey: getAssociatedTokenAddressSync(NATIVE_MINT, buyback, true),
        isWritable: true,
        isSigner: false,
      },
    ])
    .instruction();
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }),
    // Deliberately non-idempotent: never wrap or close a pre-existing WSOL account.
    createAssociatedTokenAccountInstruction(user, a.quote, user, NATIVE_MINT),
    SystemProgram.transfer({
      fromPubkey: user,
      toPubkey: a.quote,
      lamports: BigInt(p.inputCap),
    }),
    createSyncNativeInstruction(a.quote),
    buy,
    createBurnCheckedInstruction(
      a.base,
      mint,
      user,
      BigInt(p.tokens),
      p.decimals,
      [],
      program,
    ),
    createCloseAccountInstruction(a.quote, user, user),
  ];
}
export async function prepareAmmBuyback(
  connection: Connection,
  policy: BuybackPolicy,
  minContextSlot: number,
  available?: string,
): Promise<BuybackPlan> {
  const mint = new PublicKey(policy.mint),
    user = new PublicKey(policy.treasury),
    classic = ammBuybackAddresses(mint, user, TOKEN_PROGRAM_ID),
    token22 = ammBuybackAddresses(mint, user, TOKEN_2022_PROGRAM_ID);
  const addresses = [
    amm.GLOBAL_CONFIG_PDA,
    amm.PUMP_AMM_FEE_CONFIG_PDA,
    mint,
    pump.bondingCurvePda(mint),
    user,
    classic.base,
    token22.base,
    classic.pool,
    classic.poolBase,
    token22.poolBase,
    classic.poolQuote,
    classic.quote,
    amm.userVolumeAccumulatorPda(user),
  ];
  // Quote against the same commitment used by simulation; finalized reserves
  // can lag a moving pool enough to reject otherwise valid 1% slippage limits.
  // Fee-revenue eligibility remains finalized independently in the worker.
  const r = await connection.getMultipleAccountsInfoAndContext(addresses, {
    commitment: "confirmed",
    minContextSlot,
  });
  if (integer(r.context.slot) < integer(minContextSlot))
    throw Error("Stale AMM account context");
  const [g, f, m, c, u, , , pi] = r.value;
  if (
    !g?.owner.equals(amm.PUMP_AMM_PROGRAM_ID) ||
    !f?.owner.equals(amm.PUMP_FEE_PROGRAM_ID) ||
    !c?.owner.equals(pump.PUMP_PROGRAM_ID) ||
    !pi?.owner.equals(amm.PUMP_AMM_PROGRAM_ID) ||
    !m ||
    ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some((p) => p.equals(m.owner)) ||
    !u?.owner.equals(SystemProgram.programId) ||
    u.data.length ||
    [g, f, m, c, u, pi].some((a) => a.executable)
  )
    throw Error("Unsupported graduated buyback account owner");
  const global = amm.PUMP_AMM_SDK.decodeGlobalConfig(g),
    feeConfig = amm.PUMP_AMM_SDK.decodeFeeConfig(f),
    poolProgram = next.getPumpAmmProgram(connection),
    pool = poolProgram.coder.accounts.decode("pool", Buffer.concat([pi.data,Buffer.alloc(Math.max(0,poolProgram.account.pool.size-pi.data.length))])) as ReturnType<typeof amm.PUMP_AMM_SDK.decodePool> & {isHolderReward:boolean;protocolFees:import("bn.js");creatorFees:import("bn.js")},
    curve = pump.PUMP_SDK.decodeBondingCurve(c),
    mintState = unpackMint(mint, m, m.owner),
    a = m.owner.equals(TOKEN_PROGRAM_ID) ? classic : token22,
    baseIndex = m.owner.equals(TOKEN_PROGRAM_ID) ? 5 : 6,
    vaultIndex = m.owner.equals(TOKEN_PROGRAM_ID) ? 8 : 9;
  if (
    !curve.complete ||
    curve.isMayhemMode ||
    curve.isCashbackCoin ||
    curve.isHolderReward ||
    (!curve.quoteMint.equals(NATIVE_MINT) &&
      !curve.quoteMint.equals(PublicKey.default)) ||
    global.disableFlags & 8 ||
    pool.index !== 0 ||
    !pool.creator.equals(amm.pumpPoolAuthorityPda(mint)) ||
    !pool.baseMint.equals(mint) ||
    !pool.quoteMint.equals(NATIVE_MINT) ||
    !pool.poolBaseTokenAccount.equals(a.poolBase) ||
    !pool.poolQuoteTokenAccount.equals(a.poolQuote) ||
    pool.coinCreator.equals(PublicKey.default) ||
    pool.isMayhemMode ||
    pool.isCashbackCoin ||
    pool.isHolderReward ||
    pool.canEditCreatorFee ||
    pi.data.length < amm.POOL_ACCOUNT_NEW_SIZE ||
    pi.data.subarray(poolProgram.account.pool.size).some((byte) => byte !== 0)
  )
    throw Error("Only standard canonical graduated SOL pools are supported");
  if (
    !mintState.isInitialized ||
    mintState.mintAuthority ||
    mintState.freezeAuthority ||
    mintState.decimals > 9 ||
    getExtensionTypes(mintState.tlvData).some(
      (t) =>
        ![ExtensionType.MetadataPointer, ExtensionType.TokenMetadata].includes(
          t,
        ),
    )
  )
    throw Error("Unsupported graduated platform mint");
  const baseInfo = r.value[baseIndex],
    poolBaseInfo = r.value[vaultIndex],
    poolQuoteInfo = r.value[10],
    volumeInfo = r.value[12];
  if (
    !baseInfo ||
    !poolBaseInfo ||
    !poolQuoteInfo ||
    !volumeInfo?.owner.equals(amm.PUMP_AMM_PROGRAM_ID) ||
    [baseInfo, poolBaseInfo, poolQuoteInfo, volumeInfo].some(
      (x) => x.executable,
    )
  )
    throw Error("Provisioned treasury, pool and volume accounts required");
  if (r.value[11] !== null)
    throw Error("Existing treasury WSOL account must remain untouched");
  if (
    !amm.PUMP_AMM_SDK.decodeUserVolumeAccumulator(volumeInfo).user.equals(user)
  )
    throw Error("Wrong treasury volume owner");
  const base = unpackAccount(a.base, baseInfo, m.owner),
    poolBase = unpackAccount(a.poolBase, poolBaseInfo, m.owner),
    poolQuote = unpackAccount(a.poolQuote, poolQuoteInfo, TOKEN_PROGRAM_ID);
  for (const [account, owner, token] of [
    [base, user, mint],
    [poolBase, a.pool, mint],
    [poolQuote, a.pool, NATIVE_MINT],
  ] as const) {
    if (
      !account.owner.equals(owner) ||
      !account.mint.equals(token) ||
      !account.isInitialized ||
      account.isFrozen ||
      account.delegate ||
      account.closeAuthority ||
      getExtensionTypes(account.tlvData).some(
        (t) => t !== ExtensionType.ImmutableOwner,
      )
    )
      throw Error("Unsupported AMM token account");
  }
  if (
    !poolQuote.isNative ||
    poolBase.isNative ||
    base.isNative ||
    poolBase.amount === 0n ||
    poolQuote.amount === 0n
  )
    throw Error("Unsupported or empty pool reserves");
  const input = buybackInput(policy,available ?? (rawLamports(policy.maxInput)+rawLamports(policy.maxOverhead)).toString(),integer(u.lamports)),
    reserve = input + rawLamports(policy.maxOverhead),
    rent = integer(
      await connection.getMinimumBalanceForRentExemption(
        ACCOUNT_SIZE,
        "confirmed",
      ),
    );
  if (
    integer(u.lamports) < reserve ||
    4n * rent + 5400n > rawLamports(policy.maxOverhead)
  )
    throw Error(
      "Treasury overhead must cover temporary WSOL plus three possible fee accounts and network fees",
    );
  const quoted = (input * 10000n) / BigInt(10000 + policy.slippageBps);
  const quote = amm.buyQuoteInput({
    quote: new BN(quoted.toString()),
    slippage: 0,
    baseReserve: new BN(poolBase.amount.toString()),
    quoteReserve: new BN(poolQuote.amount.toString()).sub(pool.protocolFees).sub(pool.creatorFees),
    virtualQuoteReserves: pool.virtualQuoteReserves,
    globalConfig: global,
    baseMintAccount: MintLayout.decode(m.data),
    baseMint: mint,
    coinCreator: pool.coinCreator,
    creator: pool.creator,
    feeConfig,
    quoteMint: NATIVE_MINT,
    isMayhemMode: false,
    creatorFeeBps: pool.creatorFeeBps,
  });
  const recipient = global.protocolFeeRecipients.find(
      (k) => !k.equals(PublicKey.default),
    ),
    buyback = global.buybackFeeRecipients.find(
      (k) => !k.equals(PublicKey.default),
    );
  if (!recipient || !buyback) throw Error("AMM fee destination unavailable");
  const block = await connection.getLatestBlockhash({
    commitment: "confirmed",
    minContextSlot: r.context.slot,
  });
  const plan: BuybackPlan = {
    version: 1,
    route: "pump-amm",
    ammVersion: 2,
    policy,
    unsigned: "",
    inputCap: input.toString(),
    tokens: quote.base.toString(),
    decimals: mintState.decimals,
    tokenProgram: m.owner.toBase58(),
    creator: pool.coinCreator.toBase58(),
    feeRecipient: recipient.toBase58(),
    buybackFeeRecipient: buyback.toBase58(),
    lastValidBlockHeight: block.lastValidBlockHeight,
    contextSlot: r.context.slot,
    preparedAt: Date.now(),
    fee: "5400",
  };
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: user,
      recentBlockhash: block.blockhash,
      instructions: await ammBuybackInstructions(plan),
    }).compileToV0Message(),
  );
  const bytes = tx.serialize();
  if (bytes.length > 1232) throw Error("AMM buyback exceeds packet size");
  plan.unsigned = Buffer.from(bytes).toString("base64");
  const fee = (await connection.getFeeForMessage(tx.message, "confirmed"))
    .value;
  if (
    fee === null ||
    integer(fee) + 4n * rent > rawLamports(policy.maxOverhead)
  )
    throw Error("AMM network fee exceeds temporary funding budget");
  plan.fee = String(fee);
  const sim = await connection.simulateTransaction(tx, {
    commitment: "confirmed",
    sigVerify: false,
    minContextSlot: r.context.slot,
    accounts: {
      encoding: "base64",
      addresses: [user.toBase58(), a.base.toBase58(), a.quote.toBase58()],
    },
  });
  if (
    sim.value.err ||
    !sim.value.accounts?.[0] ||
    !sim.value.accounts[1] ||
    sim.value.accounts.length !== 3 ||
    !(
      sim.value.accounts[2] === null ||
      (sim.value.accounts[2].owner === SystemProgram.programId.toBase58() &&
        sim.value.accounts[2].lamports === 0 &&
        !sim.value.accounts[2].executable &&
        sim.value.accounts[2].data[0] === "" &&
        sim.value.accounts[2].data[1] === "base64")
    )
  )
    throw Error("Atomic AMM buy/burn/unwrap simulation failed");
  if (integer(sim.context.slot) < integer(r.context.slot))
    throw Error("Stale AMM simulation context");
  const [nextUser, nextBase] = sim.value.accounts;
  if (
    nextUser.owner !== SystemProgram.programId.toBase58() ||
    nextUser.executable ||
    nextUser.data[0] !== "" ||
    nextBase.executable ||
    nextBase.data[1] !== "base64"
  )
    throw Error("AMM simulation changed account permissions");
  const after = unpackAccount(
      a.base,
      {
        ...nextBase,
        data: Buffer.from(nextBase.data[0], "base64"),
        owner: new PublicKey(nextBase.owner),
      },
      m.owner,
    ),
    debit = integer(u.lamports) - integer(nextUser.lamports);
  if (
    debit <= integer(fee) ||
    debit > reserve ||
    after.amount !== base.amount ||
    !after.owner.equals(user) ||
    !after.mint.equals(mint) ||
    !after.isInitialized ||
    after.isFrozen ||
    after.delegate ||
    after.closeAuthority ||
    !after.tlvData.equals(base.tlvData)
  )
    throw Error("AMM simulation exceeded budget or touched prior holdings");
  return plan;
}
