import { createRequire } from "node:module";
import {setTimeout as delay} from 'node:timers/promises';
import { recoverWorkerReceipt } from "./worker-block-recovery.js";
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type {
  VersionedTransactionResponse,
  ParsedInnerInstruction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import {
  pumpDistributionInstructions,
  verifyLaunchSharing,
} from "./pump-launch.js";
import {
  rawLamports,
  payoutDestinations,
  validatePayoutAmounts,
  validatePayoutRoute,
  verifyPayoutSignature,
} from "./launch-payout-model.js";
import type {
  PayoutRoute,
  PayoutPlan,
  PayoutAttempt,
  PayoutReceipt,
} from "./launch-payout-model.js";
const require = createRequire(import.meta.url);
const NEXT = require('@pump-fun/pump-sdk-next') as typeof import('@pump-fun/pump-sdk-next');
const {
  PUMP_SDK,
  PUMP_PROGRAM_ID,
  PUMP_FEE_PROGRAM_ID,
  PUMP_AMM_PROGRAM_ID,
  feeSharingConfigPda,
  bondingCurvePda,
  creatorVaultPda,
  ammCreatorVaultPda,
  canonicalPumpPoolPda,
} = require("@pump-fun/pump-sdk") as typeof import("@pump-fun/pump-sdk");
const MAINNET = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const integer = (n: number) => {
  if (!Number.isSafeInteger(n) || n < 0) throw Error("Unsafe RPC integer.");
  return BigInt(n);
};
function configFor(route: PayoutRoute, payer: string) {
  const ordered=payoutDestinations(route);
  return {
    version: 2,
    mint: new PublicKey(route.mint),
    admin: new PublicKey(payer),
    adminRevoked: true,
    shareholders: [
      { address: new PublicKey(ordered.recipient), shareBps: 8000 },
      { address: new PublicKey(ordered.buybackWallet), shareBps: 2000 },
    ],
  };
}
// Rebuild the complete instruction list, including compute/priority limits. An
// altered database row must never turn the payout signer into a transfer signer.
export async function verifyPayoutPlan(
  route: PayoutRoute,
  payer: string,
  plan: PayoutPlan,
  allowAmm = true,
) {
  validatePayoutRoute(route, payer);
  if (plan.unsigned.length > 1644) throw Error("Payout packet too large.");
  const tx = VersionedTransaction.deserialize(
    Buffer.from(plan.unsigned, "base64"),
  );
  if (
    tx.message.header.numRequiredSignatures !== 1 ||
    tx.message.addressTableLookups.length ||
    tx.signatures.some((s) => s.some((x) => x !== 0))
  )
    throw Error("Invalid unsigned payout.");
  for (const graduated of (allowAmm ? [false, true] : [false])) for (const sweepCurve of [false,true]) for (const sweepPool of (graduated ? [false,true] : [false])) {
    const instructions = await pumpDistributionInstructions({
      ...route,
      ...payoutDestinations(route),
      payer,
      config: configFor(route, payer),
      graduated,
      sweepCurve,
      sweepPool,
    });
    const expected = new TransactionMessage({
      payerKey: new PublicKey(payer),
      recentBlockhash: tx.message.recentBlockhash,
      instructions,
    }).compileToV0Message();
    if (
      Buffer.from(expected.serialize()).equals(
        Buffer.from(tx.message.serialize()),
      )
    )
      return;
  }
  throw Error(
    "Only the registered Pump distribution instructions may be signed.",
  );
}
export function verifyPayoutSimulationCosts(
  inner: ParsedInnerInstruction[] | null | undefined,
  payer: string,
) {
  if (!Array.isArray(inner))
    throw Error("Payout simulation must include inner instructions.");
  for (const group of inner)
    for (const ix of group.instructions) {
      if (!ix.programId.equals(SystemProgram.programId)) continue;
      // SOL payout funds must originate from Pump's vault, never the fee payer.
      // Refuse unparsed system calls and payer-funded account rent until that
      // spending has its own explicitly reviewed budget and execution path.
      if (
        !("parsed" in ix) ||
        !ix.parsed ||
        typeof ix.parsed !== "object" ||
        !ix.parsed.info ||
        JSON.stringify(ix.parsed.info).includes(payer)
      )
        throw Error("Payout requires unapproved fee-payer funding.");
    }
}
export async function payoutReceipt(
  route: PayoutRoute,
  a: PayoutAttempt,
  tx: VersionedTransactionResponse,
): Promise<PayoutReceipt | null> {
  await verifyPayoutPlan(route, a.payer, a);
  if (verifyPayoutSignature(a, a.signed, a.payer) !== a.signature)
    throw Error("Payout signature mismatch.");
  const stored = VersionedTransaction.deserialize(
    Buffer.from(a.signed, "base64"),
  );
  if (
    !tx.meta ||
    tx.transaction.signatures[0] !== a.signature ||
    !Buffer.from(tx.transaction.message.serialize()).equals(
      Buffer.from(stored.message.serialize()),
    )
  )
    throw Error("Finalized payout evidence does not match.");
  integer(tx.slot);
  const keys = tx.transaction.message.staticAccountKeys;
  if (
    tx.meta.preBalances.length !== keys.length ||
    tx.meta.postBalances.length !== keys.length ||
    integer(tx.meta.fee) > rawLamports(a.feeLamports)
  )
    throw Error("Invalid payout balances or fee.");
  const delta = (wallet: string) => {
    const i = keys.findIndex((k) => k.toBase58() === wallet);
    if (i < 0) throw Error("Missing payout recipient.");
    return integer(tx.meta!.postBalances[i]) - integer(tx.meta!.preBalances[i]);
  };
  if (delta(a.payer) !== -integer(tx.meta.fee))
    throw Error("Payout fee payer had unexpected additional spending.");
  const recipient = delta(route.recipient),
    buyback = delta(route.buybackWallet);
  if (tx.meta.err) {
    if (recipient !== 0n || buyback !== 0n)
      throw Error("Failed payout cannot change recipient proceeds.");
    return null;
  }
  validatePayoutAmounts(route,recipient.toString(),buyback.toString());
  return {
    slot: Number(integer(tx.slot)),
    recipientLamports: recipient.toString(),
    buybackLamports: buyback.toString(),
    networkFeeLamports: String(tx.meta.fee),
  };
}

// Read-only, finalized fee snapshot shared by the payout and public-directory paths.
export async function readLaunchFeeVault(
  connection: Connection,
  route: PayoutRoute,
) {
  if ((await connection.getGenesisHash()) !== MAINNET)
    throw Error("Mainnet required.");
  const mint = new PublicKey(route.mint),
    sharing = feeSharingConfigPda(mint),
    vault = creatorVaultPda(sharing);
  const ammAuthority = ammCreatorVaultPda(sharing),
    ammVault = getAssociatedTokenAddressSync(NATIVE_MINT, ammAuthority, true);
  const result = await connection.getMultipleAccountsInfoAndContext(
    [
      sharing,
      bondingCurvePda(mint),
      mint,
      vault,
      canonicalPumpPoolPda(mint),
      ammVault,
    ],
    { commitment: "finalized" },
  );
  const [shareInfo, curveInfo, mintInfo, vaultInfo, poolInfo, ammInfo] =
    result.value;
  if (
    !shareInfo?.owner.equals(PUMP_FEE_PROGRAM_ID) ||
    !curveInfo?.owner.equals(PUMP_PROGRAM_ID) ||
    !mintInfo ||
    ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some((p) =>
      p.equals(mintInfo.owner),
    )
  )
    throw Error("Unexpected Pump account ownership.");
  if ([shareInfo, curveInfo, mintInfo].some((a) => a.executable))
    throw Error("Invalid Pump account.");
  const config = PUMP_SDK.decodeSharingConfig(shareInfo);
  const status = (config as unknown as { status?: { active?: unknown } })
    .status;
  if (!status || !("active" in status) || Object.keys(status).length !== 1)
    throw Error("Fee sharing is not active.");
  const ordered=payoutDestinations(route);
  verifyLaunchSharing(config, route.mint, ordered.recipient, ordered.buybackWallet);
  const curve = NEXT.PUMP_SDK.decodeBondingCurve(curveInfo);
  if (
    !curve.creator.equals(sharing) ||
    (!curve.quoteMint.equals(NATIVE_MINT) &&
      !curve.quoteMint.equals(PublicKey.default)) ||
    curve.isMayhemMode ||
    curve.isCashbackCoin ||
    curve.isHolderReward ||
    !unpackMint(mint, mintInfo, mintInfo.owner).isInitialized
  )
    throw Error("Unsupported launch payout route.");
  if (
    vaultInfo &&
    (!vaultInfo.owner.equals(SystemProgram.programId) ||
      vaultInfo.data.length !== 0 ||
      vaultInfo.executable)
  )
    throw Error("Unexpected creator vault.");
  const rent = integer(
    await connection.getMinimumBalanceForRentExemption(0, "finalized"),
  );
  let available = vaultInfo ? integer(vaultInfo.lamports) - rent : 0n;
  if (available < 0n) available = 0n;
  // New Pump v3 trades retain fees on the curve. Legacy vault balances are
  // still counted, but retained fees must be swept before distribution.
  const retainedCurve = rawLamports(curve.creatorFee.toString());
  available += retainedCurve;
  const sweepCurve = retainedCurve > 0n;
  let sweepAmm = false;
  let sweepPool = false;
  if (curve.complete) {
    if (!poolInfo?.owner.equals(PUMP_AMM_PROGRAM_ID) || poolInfo.executable)
      throw Error("Graduated pool unavailable.");
    // Older pools end after coinCreator (243 bytes); newer fields default to
    // zero on chain. Preserve that versioned layout behavior when the SDK IDL
    // grows, without padding a missing creator into a valid fee destination.
    if (poolInfo.data.length < 243) throw Error("Incomplete graduated fee pool.");
    const program = NEXT.getPumpAmmProgram(connection);
    const pool = program.coder.accounts.decode(
      "pool",
      Buffer.concat([
        poolInfo.data,
        Buffer.alloc(Math.max(0, program.account.pool.size - poolInfo.data.length)),
      ]),
    );
    if (
      !pool.baseMint.equals(mint) ||
      !pool.quoteMint.equals(NATIVE_MINT) ||
      !pool.coinCreator.equals(sharing)
    )
      throw Error("Graduated fee destination mismatch.");
    const retainedPool = rawLamports(pool.creatorFees.toString());
    available += retainedPool;
    sweepPool = retainedPool > 0n;
    sweepAmm = sweepPool;
    if (ammInfo) {
      const token = unpackAccount(ammVault, ammInfo, TOKEN_PROGRAM_ID);
      if (
        !token.mint.equals(NATIVE_MINT) ||
        !token.owner.equals(ammAuthority) ||
        !token.isNative ||
        token.isFrozen
      )
        throw Error("Unexpected AMM fee vault.");
      available += token.amount;
      sweepAmm = sweepAmm || token.amount > 0n;
    }
  }
  if (!Number.isSafeInteger(result.context.slot) || result.context.slot < 1)
    throw Error("Invalid fee snapshot slot.");
  return { available, slot: result.context.slot, config, sweepAmm, sweepCurve, sweepPool, graduated: !!curve.complete };
}

export function launchPayoutChain(
  connection: Connection,
  options: { payer: string; minimumLamports: string; maxFeeLamports: string; allowAmm?: boolean },
  recoveryRpc?: import("./funding.js").Rpc,
) {
  const minimum = rawLamports(options.minimumLamports),
    maxFee = rawLamports(options.maxFeeLamports);
  if (maxFee < 5000n || maxFee > 100000n || minimum < maxFee * 10n)
    throw Error("Payout threshold must cover transaction costs.");
  const mainnet = async () => {
    if ((await connection.getGenesisHash()) !== MAINNET)
      throw Error("Mainnet required.");
  };
  return {
    async prepare(route: PayoutRoute): Promise<PayoutPlan | null> {
      validatePayoutRoute(route, options.payer);
      const { available, slot, config, sweepAmm, sweepCurve, sweepPool, graduated } = await readLaunchFeeVault(
        connection,
        route,
      );
      if (graduated && options.allowAmm === false) throw Error("Graduated payout acceptance required.");
      if (available < minimum) return null;
      const latest = await connection.getLatestBlockhash({
        commitment: "confirmed",
        minContextSlot: slot,
      });
      const instructions = await pumpDistributionInstructions({
        ...route,
      ...payoutDestinations(route),
        payer: options.payer,
        config,
        graduated: sweepAmm,
        sweepCurve,
        sweepPool,
      });
      const message = new TransactionMessage({
        payerKey: new PublicKey(options.payer),
        recentBlockhash: latest.blockhash,
        instructions,
      }).compileToV0Message();
      const tx = new VersionedTransaction(message),
        bytes = tx.serialize();
      if (bytes.length > 1232) throw Error("Payout packet too large.");
      const fee = (await connection.getFeeForMessage(message, "confirmed"))
        .value;
      if (fee === null || integer(fee) > maxFee || fee <= 0)
        throw Error("Payout network fee unavailable or excessive.");
      const simulated = await connection.simulateTransaction(tx, {
        commitment: "confirmed",
        sigVerify: false,
        innerInstructions: true,
        minContextSlot: slot,
      });
      if (simulated.value.err) throw Error("Payout simulation failed.");
      verifyPayoutSimulationCosts(
        simulated.value.innerInstructions,
        options.payer,
      );
      const plan = {
        unsigned: Buffer.from(bytes).toString("base64"),
        lastValidBlockHeight: latest.lastValidBlockHeight,
        feeLamports: String(fee),
      };
      await verifyPayoutPlan(route, options.payer, plan, options.allowAmm);
      return plan;
    },
    async reconcile(
      route: PayoutRoute,
      a: PayoutAttempt,
    ): Promise<
      | { kind: "confirmed"; receipt: PayoutReceipt }
      | { kind: "failed" | "pending" | "expired_unresolved" }
    > {
      await mainnet();
      await verifyPayoutPlan(route, a.payer, a);
      if (verifyPayoutSignature(a, a.signed, a.payer) !== a.signature)
        throw Error("Payout signature mismatch.");
      let tx = await connection.getTransaction(a.signature, {
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      }).catch(error => { if (!recoveryRpc) throw error; return null; });
      // Older payout plans have no preparation slot. Exact saved bytes and the
      // finalized signature status still bind the receipt without inventing one.
      if (!tx && recoveryRpc)
        tx = await recoverWorkerReceipt({signature:a.signature,signed:a.signed,minContextSlot:1}, recoveryRpc);
      if (tx) {
        const receipt = await payoutReceipt(route, a, tx);
        return receipt ? { kind: "confirmed", receipt } : { kind: "failed" };
      }
      // A null result after expiry is not proof of failure. Keep this attempt
      // unresolved rather than signing a replacement or inventing revenue.
      return {
        kind:
          (await connection.getBlockHeight("finalized")) >
          a.lastValidBlockHeight
            ? "expired_unresolved"
            : "pending",
      };
    },
    async send(route: PayoutRoute, a: PayoutAttempt) {
      await mainnet();
      if (a.payer !== options.payer)
        throw Error("Unexpected payout fee payer.");
      await verifyPayoutPlan(route, a.payer, a, options.allowAmm);
      if (
        verifyPayoutSignature(a, a.signed, a.payer) !== a.signature ||
        rawLamports(a.feeLamports) > maxFee
      )
        throw Error("Invalid signed payout.");
      if (
        (await connection.getBlockHeight("confirmed")) > a.lastValidBlockHeight
      )
        return "expired" as const;
      const signature = await connection.sendRawTransaction(
        Buffer.from(a.signed, "base64"),
        {
          skipPreflight: false,
          // Retransmit the same signed packet while its blockhash is live.
          // Waiting for the next minute tick can outlast that lifetime.
          // Let the RPC keep forwarding these same bytes until blockhash
          // expiry. A short retry budget can drop a valid acknowledged packet.
          preflightCommitment: "confirmed",
        },
      );
      if (signature !== a.signature)
        throw Error("Payout submission response mismatch.");
      for(let retry=0;retry<3;retry++) {
        await delay(1000);
        const status=(await connection.getSignatureStatuses([a.signature],{searchTransactionHistory:true})).value[0];
        // Observed inclusion is not settlement; the later finalized receipt
        // must still pass the exact balances and 80/20 checks.
        if(status)return "sent" as const;
        if(await connection.getBlockHeight('confirmed')>a.lastValidBlockHeight)return "expired" as const;
        const repeated=await connection.sendRawTransaction(Buffer.from(a.signed,'base64'),{skipPreflight:false,preflightCommitment:'confirmed'});
        if(repeated!==a.signature)throw Error('Payout submission response mismatch.');
      }
      return "sent" as const;
    },
  };
}
export type LaunchPayoutChain = ReturnType<typeof launchPayoutChain>;
