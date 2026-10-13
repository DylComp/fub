import { createRequire } from "node:module";
import { recoverWorkerReceipt } from "./worker-block-recovery.js";
import {
  Connection,
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type { VersionedTransactionResponse } from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  unpackMint,
  unpackAccount,
  getExtensionTypes,
  ExtensionType,
  createBurnCheckedInstruction,
} from "@solana/spl-token";
import { rawLamports } from "./launch-payout-model.js";
import {
  buybackInput,
  validateBuybackPolicy,
  validateBuybackPlan,
  buybackReservation,
  verifyBuybackSigned,
  buybackPolicyId,
} from "./buyback-model.js";
import type {
  BuybackPolicy,
  BuybackPlan,
  BuybackAttempt,
  BuybackReceipt,
} from "./buyback-model.js";
import { ammBuybackInstructions, prepareAmmBuyback } from "./buyback-amm.js";
const require = createRequire(import.meta.url),
  sdk = require("@pump-fun/pump-sdk") as typeof import("@pump-fun/pump-sdk"),
  BN = require("bn.js") as typeof import("bn.js");
const MAINNET = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const integer = (n: number) => {
  if (!Number.isSafeInteger(n) || n < 0) throw Error("Unsafe RPC integer");
  return BigInt(n);
};
export async function buybackInstructions(p: BuybackPlan) {
  validateBuybackPlan(p);
  if (p.route === "pump-amm") return ammBuybackInstructions(p);
  const mint = new PublicKey(p.policy.mint),
    user = new PublicKey(p.policy.treasury),
    program = new PublicKey(p.tokenProgram);
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }),
    await sdk.PUMP_SDK.getBuyInstructionRaw({
      user,
      mint,
      creator: new PublicKey(p.creator),
      amount: new BN(p.tokens),
      solAmount: new BN(p.inputCap),
      feeRecipient: new PublicKey(p.feeRecipient),
      buybackFeeRecipient: new PublicKey(p.buybackFeeRecipient),
      tokenProgram: program,
    }),
    createBurnCheckedInstruction(
      getAssociatedTokenAddressSync(mint, user, false, program),
      mint,
      user,
      BigInt(p.tokens),
      p.decimals,
      [],
      program,
    ),
  ];
}
export async function verifyBuybackPlan(p: BuybackPlan) {
  validateBuybackPlan(p);
  const tx = VersionedTransaction.deserialize(
    Buffer.from(p.unsigned, "base64"),
  );
  const message = new TransactionMessage({
    payerKey: new PublicKey(p.policy.treasury),
    recentBlockhash: tx.message.recentBlockhash,
    instructions: await buybackInstructions(p),
  }).compileToV0Message();
  if (
    tx.message.addressTableLookups.length ||
    tx.message.header.numRequiredSignatures !== 1 ||
    tx.signatures.some((s) => s.some((n) => n !== 0)) ||
    Buffer.from(tx.serialize()).toString("base64") !== p.unsigned ||
    !Buffer.from(tx.message.serialize()).equals(
      Buffer.from(message.serialize()),
    )
  )
    throw Error("Only the exact platform-token buy and burn may be signed");
}
export async function buybackReceipt(
  a: BuybackAttempt,
  tx: VersionedTransactionResponse,
): Promise<BuybackReceipt> {
  await verifyBuybackPlan(a.plan);
  if (verifyBuybackSigned(a.plan, a.signed) !== a.signature)
    throw Error("Buyback signature mismatch");
  const saved = VersionedTransaction.deserialize(
      Buffer.from(a.signed, "base64"),
    ),
    meta = tx.meta,
    p = a.plan;
  if (
    !meta ||
    tx.transaction.signatures[0] !== a.signature ||
    !Buffer.from(tx.transaction.message.serialize()).equals(
      Buffer.from(saved.message.serialize()),
    ) ||
    tx.slot < p.contextSlot
  )
    throw Error("Buyback receipt mismatch");
  const keys = tx.transaction.message.staticAccountKeys;
  if (
    meta.preBalances.length !== keys.length ||
    meta.postBalances.length !== keys.length
  )
    throw Error("Missing buyback balances");
  const debit = integer(meta.preBalances[0]) - integer(meta.postBalances[0]),
    fee = integer(meta.fee);
  if (
    fee > rawLamports(p.fee) ||
    debit < fee ||
    debit > rawLamports(buybackReservation(p))
  )
    throw Error("Buyback exceeded approved spending");
  const ata = getAssociatedTokenAddressSync(
      new PublicKey(p.policy.mint),
      new PublicKey(p.policy.treasury),
      false,
      new PublicKey(p.tokenProgram),
    ),
    index = keys.findIndex((k) => k.equals(ata));
  const before = meta.preTokenBalances?.filter((t) => t.accountIndex === index),
    after = meta.postTokenBalances?.filter((t) => t.accountIndex === index);
  if (
    before?.length !== 1 ||
    after?.length !== 1 ||
    [before[0], after[0]].some(
      (t) =>
        t.mint !== p.policy.mint ||
        t.owner !== p.policy.treasury ||
        t.programId !== p.tokenProgram ||
        t.uiTokenAmount.decimals !== p.decimals,
    ) ||
    rawLamports(before[0].uiTokenAmount.amount) !==
      rawLamports(after[0].uiTokenAmount.amount)
  )
    throw Error("Buyback touched pre-existing token holdings");
  if (p.route === "pump-amm") {
    const quote = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      new PublicKey(p.policy.treasury),
    );
    const quoteIndex = keys.findIndex((k) => k.equals(quote));
    if (
      quoteIndex < 0 ||
      meta.preBalances[quoteIndex] !== 0 ||
      meta.postBalances[quoteIndex] !== 0 ||
      [
        ...(meta.preTokenBalances || []),
        ...(meta.postTokenBalances || []),
      ].some((t) => t.accountIndex === quoteIndex)
    )
      throw Error("AMM receipt did not close its temporary WSOL account");
  }
  if (meta.err && debit !== fee)
    throw Error("Failed buyback has unexpected spending");
  if (!meta.err && debit <= fee) throw Error("No purchase spending recorded");
  return {
    slot: Number(integer(tx.slot)),
    debit: debit.toString(),
    networkFee: fee.toString(),
    burned: meta.err ? "0" : p.tokens,
    success: !meta.err,
  };
}
export function buybackChain(connection: Connection, policy: BuybackPolicy, recoveryRpc?: import("./funding.js").Rpc) {
  validateBuybackPolicy(policy);
  const mainnet = async () => {
    if ((await connection.getGenesisHash()) !== MAINNET)
      throw Error("Mainnet required");
  };
  const same = (p: BuybackPlan) => {
    if (buybackPolicyId(p.policy) !== buybackPolicyId(policy))
      throw Error("Buyback policy mismatch");
  };
  return {
    async prepare(available: string): Promise<BuybackPlan | null> {
      let input = rawLamports(policy.maxInput), reserve = input + rawLamports(policy.maxOverhead);
      if (policy.revenueReserve===undefined && rawLamports(available) < reserve) return null;
      await mainnet();
      const mint = new PublicKey(policy.mint),
        user = new PublicKey(policy.treasury);
      // Read both possible ATAs with mint, curve and fee configuration in one finalized context.
      const addresses = [
        sdk.GLOBAL_PDA,
        sdk.PUMP_FEE_CONFIG_PDA,
        mint,
        sdk.bondingCurvePda(mint),
        user,
        getAssociatedTokenAddressSync(mint, user, false, TOKEN_PROGRAM_ID),
        getAssociatedTokenAddressSync(mint, user, false, TOKEN_2022_PROGRAM_ID),
      ];
      const r = await connection.getMultipleAccountsInfoAndContext(addresses, {
        commitment: "finalized",
      });
      const [g, f, m, c, u] = r.value;
      if (
        !g?.owner.equals(sdk.PUMP_PROGRAM_ID) ||
        !f?.owner.equals(sdk.PUMP_FEE_PROGRAM_ID) ||
        !c?.owner.equals(sdk.PUMP_PROGRAM_ID) ||
        !m ||
        ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some((p) =>
          p.equals(m.owner),
        ) ||
        !u?.owner.equals(SystemProgram.programId) ||
        u.data.length ||
        [g, f, m, c, u].some((a) => a.executable)
      )
        throw Error("Unsupported buyback account owner");
      input=buybackInput(policy,available,integer(u.lamports));
      if(input===0n)return null;
      reserve=input+rawLamports(policy.maxOverhead);
      const global = sdk.PUMP_SDK.decodeGlobal(g),
        feeConfig = sdk.PUMP_SDK.decodeFeeConfig(f),
        curve = sdk.PUMP_SDK.decodeBondingCurve(c),
        mintState = unpackMint(mint, m, m.owner);
      if (curve.complete) {
        const plan = await prepareAmmBuyback(
          connection,
          policy,
          r.context.slot,
          available,
        );
        await verifyBuybackPlan(plan);
        return plan;
      }
      if (policy.acceptanceRoute === "pump-amm") throw Error("Graduated acceptance cannot execute a curve purchase");
      if (
        !global.initialized ||
        curve.isMayhemMode ||
        curve.isCashbackCoin ||
        curve.isHolderReward ||
        (!curve.quoteMint.equals(NATIVE_MINT) &&
          !curve.quoteMint.equals(PublicKey.default))
      )
        throw Error(
          "Only standard SOL Pump bonding curves are supported for buybacks",
        );
      if (
        !mintState.isInitialized ||
        mintState.mintAuthority ||
        mintState.freezeAuthority ||
        mintState.decimals > 9 ||
        getExtensionTypes(mintState.tlvData).some(
          (t) =>
            ![
              ExtensionType.MetadataPointer,
              ExtensionType.TokenMetadata,
            ].includes(t),
        )
      )
        throw Error("Unsupported platform mint permissions or extensions");
      const index = m.owner.equals(TOKEN_PROGRAM_ID) ? 5 : 6,
        ataInfo = r.value[index];
      if (!ataInfo)
        throw Error(
          "The treasury token account must be provisioned before activation",
        );
      if (ataInfo.executable)
        throw Error("Executable treasury token account refused");
      const ata = unpackAccount(addresses[index], ataInfo, m.owner);
      if (
        !ata.owner.equals(user) ||
        !ata.mint.equals(mint) ||
        !ata.isInitialized ||
        ata.isFrozen ||
        ata.delegate ||
        ata.closeAuthority ||
        getExtensionTypes(ata.tlvData).some(
          (t) => t !== ExtensionType.ImmutableOwner,
        )
      )
        throw Error("Unsupported treasury token account");
      if (integer(u.lamports) < reserve)
        throw Error("Treasury balance does not cover its receipt budget");
      // Quote at a lower input so the exact-output buy has the approved price headroom.
      const quoted = (input * 10000n) / BigInt(10000 + policy.slippageBps);
      const tokens = sdk
        .getBuyTokenAmountFromSolAmount({
          global,
          feeConfig,
          mintSupply: new BN(mintState.supply.toString()),
          bondingCurve: curve,
          amount: new BN(quoted.toString()),
          quoteMint: NATIVE_MINT,
          creatorFeeBps: curve.creatorFeeBps,
        })
        .toString();
      const recipient = global.buybackFeeRecipients.find(
        (k) => !k.equals(PublicKey.default),
      );
      if (!recipient) throw Error("Pump fee destination unavailable");
      const block = await connection.getLatestBlockhash({
        commitment: "confirmed",
        minContextSlot: r.context.slot,
      });
      const plan: BuybackPlan = {
        version: 1,
        policy,
        unsigned: "",
        inputCap: input.toString(),
        tokens,
        decimals: mintState.decimals,
        tokenProgram: m.owner.toBase58(),
        creator: curve.creator.toBase58(),
        feeRecipient: global.feeRecipient.toBase58(),
        buybackFeeRecipient: recipient.toBase58(),
        lastValidBlockHeight: block.lastValidBlockHeight,
        contextSlot: r.context.slot,
        preparedAt: Date.now(),
        fee: "5400",
      };
      const tx = new VersionedTransaction(
        new TransactionMessage({
          payerKey: user,
          recentBlockhash: block.blockhash,
          instructions: await buybackInstructions(plan),
        }).compileToV0Message(),
      );
      const bytes = tx.serialize();
      if (bytes.length > 1232)
        throw Error("Buyback transaction exceeds packet size");
      plan.unsigned = Buffer.from(bytes).toString("base64");
      const fee = (await connection.getFeeForMessage(tx.message, "confirmed"))
        .value;
      if (fee === null || integer(fee) > rawLamports(policy.maxOverhead))
        throw Error("Buyback network fee unavailable");
      plan.fee = String(fee);
      const sim = await connection.simulateTransaction(tx, {
        commitment: "confirmed",
        sigVerify: false,
        minContextSlot: r.context.slot,
        accounts: {
          encoding: "base64",
          addresses: [user.toBase58(), addresses[index].toBase58()],
        },
      });
      if (sim.value.err || !sim.value.accounts?.[0] || !sim.value.accounts[1])
        throw Error("Atomic buy-and-burn simulation failed");
      if (
        !Number.isSafeInteger(sim.context.slot) ||
        sim.context.slot < r.context.slot
      )
        throw Error("Stale simulation context");
      const [nextUser, nextAta] = sim.value.accounts;
      if (
        nextUser.owner !== SystemProgram.programId.toBase58() ||
        nextUser.executable ||
        nextUser.data[0] !== "" ||
        nextAta.executable ||
        nextAta.data[1] !== "base64"
      )
        throw Error("Simulation changed account permissions");
      const debit = integer(u.lamports) - integer(nextUser.lamports),
        data = Buffer.from(nextAta.data[0], "base64");
      const after = unpackAccount(
        addresses[index],
        { ...nextAta, data, owner: new PublicKey(nextAta.owner) },
        m.owner,
      );
      if (
        debit < integer(fee) ||
        debit > reserve ||
        after.amount !== ata.amount ||
        !after.owner.equals(user) ||
        !after.mint.equals(mint) ||
        !after.isInitialized ||
        after.isFrozen ||
        after.delegate ||
        after.closeAuthority ||
        !after.tlvData.equals(ata.tlvData)
      )
        throw Error(
          "Simulation exceeded spending or touched existing holdings",
        );
      await verifyBuybackPlan(plan);
      return plan;
    },
    async reconcile(a: BuybackAttempt) {
      same(a.plan);
      await mainnet();
      await verifyBuybackPlan(a.plan);
      if (verifyBuybackSigned(a.plan, a.signed) !== a.signature)
        throw Error("Buyback signature mismatch");
      let tx = await connection.getTransaction(a.signature, {
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      }).catch(error => { if (!recoveryRpc) throw error; return null; });
      if (!tx && recoveryRpc)
        tx = await recoverWorkerReceipt({signature:a.signature,signed:a.signed,minContextSlot:a.plan.contextSlot}, recoveryRpc);
      if (tx)
        return {
          kind: "settled" as const,
          receipt: await buybackReceipt(a, tx),
        };
      return {
        kind:
          (await connection.getBlockHeight("finalized")) >
          a.plan.lastValidBlockHeight
            ? ("expired_unresolved" as const)
            : ("pending" as const),
      };
    },
    async send(a: BuybackAttempt) {
      same(a.plan);
      await mainnet();
      await verifyBuybackPlan(a.plan);
      if (verifyBuybackSigned(a.plan, a.signed) !== a.signature)
        throw Error("Buyback signature mismatch");
      if (
        (await connection.getBlockHeight("confirmed")) >
        a.plan.lastValidBlockHeight
      )
        return "expired" as const;
      const signature = await connection.sendRawTransaction(
        Buffer.from(a.signed, "base64"),
        {
          skipPreflight: false,
          preflightCommitment: "confirmed",
          // Keep RPC forwarding active through blockhash expiry, as on the
          // native trading path. A minute worker must not cut it off after
          // three attempts. Retries always retain these exact signed bytes.
          minContextSlot: a.plan.contextSlot,
        },
      );
      if (signature !== a.signature) throw Error("Buyback submission mismatch");
      return "sent" as const;
    },
  };
}
