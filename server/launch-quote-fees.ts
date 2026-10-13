import { createRequire } from 'node:module';
import { Connection, PublicKey, ComputeBudgetProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import type { AccountInfo, VersionedTransactionResponse } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ExtensionType, getExtensionTypes, getAssociatedTokenAddressSync, unpackAccount, unpackMint } from '@solana/spl-token';
import { MAINNET_GENESIS } from './solana-network.js';
import { verifyLaunchSharing } from './pump-launch.js';
import { rawLamports, validatePayoutAmounts, validatePayoutRoute, verifyPayoutSignature } from './launch-payout-model.js';
import type { PayoutRoute, PayoutPlan, PayoutAttempt } from './launch-payout-model.js';
import { verifyPayoutSimulationCosts } from './launch-payout-chain.js';

const require = createRequire(import.meta.url);
const sdk = require('@pump-fun/pump-sdk-next') as typeof import('@pump-fun/pump-sdk-next');

// These values are quote-token base units, never SOL lamports. Keep this receipt
// separate from native payouts so it cannot fund a SOL buyback by accident.
export type QuoteFeeAsset = { mint: string; tokenProgram: string; decimals: number };
export type QuoteFeeRoute = PayoutRoute & { kind?: 'launchpad'; asset: QuoteFeeAsset };
export type QuoteFeeReceipt = { slot: number; asset: QuoteFeeAsset; recipientRaw: string; treasuryRaw: string; networkFeeLamports: string };
export type QuoteFeeSweeps = { curve: boolean; pool: boolean; amm: boolean };
export type QuoteFeePlan = PayoutPlan & { asset: QuoteFeeAsset; contextSlot: number; sweeps: QuoteFeeSweeps };
export type QuoteFeeAttempt = QuoteFeePlan & PayoutAttempt;
const safeInteger = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) throw Error('Invalid quote-fee chain integer.');
  return BigInt(value);
};

export function validateQuoteFeeRoute(route: QuoteFeeRoute, payer?: string) {
  validatePayoutRoute(route, payer);
  if (route.kind && route.kind !== 'launchpad') throw Error('Token-quoted official launches require a separate policy.');
  const asset = route.asset;
  if (!asset || new PublicKey(asset.mint).toBase58() !== asset.mint || asset.mint === NATIVE_MINT.toBase58() ||
      [route.mint, route.recipient, route.buybackWallet, payer].includes(asset.mint) ||
      ![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(asset.tokenProgram) ||
      !Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 18) throw Error('Invalid quote-fee asset.');
}

function matchingAsset(a: QuoteFeeAsset, b: QuoteFeeAsset) {
  return a?.mint === b?.mint && a?.tokenProgram === b?.tokenProgram && a?.decimals === b?.decimals;
}
export function quoteFeeAccounts(route: QuoteFeeRoute) {
  validateQuoteFeeRoute(route);
  const mint = new PublicKey(route.mint), quote = new PublicKey(route.asset.mint), program = new PublicKey(route.asset.tokenProgram);
  const sharing = sdk.feeSharingConfigPda(mint), creator = sdk.creatorVaultPda(sharing), amm = sdk.ammCreatorVaultPda(sharing);
  const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(quote, owner, true, program);
  return { mint, quote, program, sharing, curve: sdk.bondingCurvePda(mint), pool: sdk.canonicalPumpPoolPdaWithQuote(mint, quote),
    creator, amm, vault: ata(creator), ammVault: ata(amm), recipient: ata(new PublicKey(route.recipient)), treasury: ata(new PublicKey(route.buybackWallet)) };
}
function quoteBalance(address: PublicKey, info: AccountInfo<Buffer> | null, owner: PublicKey, asset: QuoteFeeAsset) {
  if (!info) return 0n;
  if (info.executable || info.owner.toBase58() !== asset.tokenProgram) throw Error('Invalid quote-fee token account.');
  const account = unpackAccount(address, info, new PublicKey(asset.tokenProgram));
  if (account.mint.toBase58() !== asset.mint || !account.owner.equals(owner) || !account.isInitialized || account.isFrozen || account.isNative ||
      account.delegate || account.closeAuthority) throw Error('Quote-fee account authority or mint mismatch.');
  return account.amount;
}

export async function readQuoteFees(connection: Connection, route: QuoteFeeRoute) {
  validateQuoteFeeRoute(route);
  if (await connection.getGenesisHash() !== MAINNET_GENESIS) throw Error('Mainnet required.');
  const a = quoteFeeAccounts(route);
  const result = await connection.getMultipleAccountsInfoAndContext([a.sharing, a.curve, a.mint, a.quote, a.vault, a.pool, a.ammVault, a.recipient, a.treasury], { commitment: 'finalized' });
  const [sharing, curve, mint, quote, vault, pool, ammVault, recipient, treasury] = result.value;
  if (result.value.length !== 9 || !sharing?.owner.equals(sdk.PUMP_FEE_PROGRAM_ID) || !curve?.owner.equals(sdk.PUMP_PROGRAM_ID) ||
      !mint || ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some(p => p.equals(mint.owner)) || !quote?.owner.equals(a.program) ||
      [sharing, curve, mint, quote].some(i => i.executable)) throw Error('Invalid quote-fee account ownership.');
  const config = sdk.PUMP_SDK.decodeSharingConfig(sharing);
  const status = (config as unknown as { status?: { active?: unknown } }).status;
  if (!status || !('active' in status) || Object.keys(status).length !== 1) throw Error('Fee sharing is not active.');
  verifyLaunchSharing(config, route.mint, route.recipient, route.buybackWallet);
  const b = sdk.PUMP_SDK.decodeBondingCurve(curve), q = unpackMint(a.quote, quote, a.program);
  if (!b.creator.equals(a.sharing) || !b.quoteMint.equals(a.quote) || b.isMayhemMode || b.isCashbackCoin || b.isHolderReward ||
      !unpackMint(a.mint, mint, mint.owner).isInitialized || !q.isInitialized || q.decimals !== route.asset.decimals ||
      getExtensionTypes(q.tlvData).some(t => ![ExtensionType.MetadataPointer, ExtensionType.TokenMetadata].includes(t))) {
    throw Error('Unsupported quote-fee mint or curve.');
  }
  const retainedCurve = rawLamports(b.creatorFee.toString());
  let availableRaw = quoteBalance(a.vault, vault, a.creator, route.asset) + retainedCurve;
  let retainedPool = 0n, ammRaw = 0n;
  if (b.complete) {
    if (!pool?.owner.equals(sdk.PUMP_AMM_PROGRAM_ID) || pool.executable || pool.data.length < 243) throw Error('Graduated quote-fee pool unavailable.');
    const program = sdk.getPumpAmmProgram(connection);
    const p = program.coder.accounts.decode('pool', Buffer.concat([pool.data, Buffer.alloc(Math.max(0, program.account.pool.size - pool.data.length))]));
    if (!p.baseMint.equals(a.mint) || !p.quoteMint.equals(a.quote) || !p.coinCreator.equals(a.sharing) || p.isMayhemMode || p.isCashbackCoin || p.isHolderReward) throw Error('Graduated quote-fee destination mismatch.');
    retainedPool = rawLamports(p.creatorFees.toString());
    ammRaw = quoteBalance(a.ammVault, ammVault, a.amm, route.asset);
    availableRaw += retainedPool + ammRaw;
  } else {
    if (pool) throw Error('Unexpected ungraduated quote-fee pool.');
    // Launch setup pre-creates this empty account to avoid charging the worker
    // rent at graduation. Validate its identity even before a pool exists.
    if (quoteBalance(a.ammVault, ammVault, a.amm, route.asset) !== 0n) throw Error('Unexpected ungraduated AMM fees.');
  }
  quoteBalance(a.recipient, recipient, new PublicKey(route.recipient), route.asset);
  quoteBalance(a.treasury, treasury, new PublicKey(route.buybackWallet), route.asset);
  if (safeInteger(result.context.slot) === 0n || availableRaw > 18446744073709551615n) throw Error('Invalid quote-fee snapshot.');
  return { asset: { ...route.asset }, availableRaw, slot: result.context.slot, config, graduated: !!b.complete,
    accountsReady: !!vault && !!recipient && !!treasury,
    sweeps: { curve: retainedCurve > 0n, pool: retainedPool > 0n, amm: retainedPool + ammRaw > 0n } };
}

export async function quoteFeeInstructions(route: QuoteFeeRoute, payer: string, sweeps: QuoteFeeSweeps) {
  validateQuoteFeeRoute(route, payer);
  if (!sweeps || Object.keys(sweeps).sort().join() !== 'amm,curve,pool' || Object.values(sweeps).some(v => typeof v !== 'boolean') || sweeps.pool && !sweeps.amm) throw Error('Invalid quote-fee sweeps.');
  const a = quoteFeeAccounts(route), payerKey = new PublicKey(payer);
  const terms = { payer: payerKey, mint: a.mint, quoteMint: a.quote, quoteTokenProgram: a.program };
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 })];
  if (sweeps.curve) instructions.push(await sdk.PUMP_SDK.sweepCreatorFeeInstruction({ ...terms, creator: a.sharing }));
  if (sweeps.pool) instructions.push(await sdk.PUMP_SDK.sweepPoolCreatorFeeInstruction({ ...terms, coinCreator: a.sharing }));
  if (sweeps.amm) instructions.push(await sdk.PUMP_SDK.transferCreatorFeesToPumpV2(terms));
  // ATA rent belongs in the user's launch review, never in the payout worker's
  // gas budget. Missing accounts must be repaired before enabling a route.
  instructions.push(await sdk.PUMP_SDK.distributeCreatorFeesV2({ ...terms, sharingConfigAddress: a.sharing, shouldInitializeAta: false,
    sharingConfig: { version: 2, mint: a.mint, admin: payerKey, adminRevoked: true, shareholders: [
      { address: new PublicKey(route.recipient), shareBps: 8000 }, { address: new PublicKey(route.buybackWallet), shareBps: 2000 },
    ] } }));
  return instructions;
}

export async function verifyQuoteFeePlan(route: QuoteFeeRoute, payer: string, plan: QuoteFeePlan) {
  validateQuoteFeeRoute(route, payer);
  if (!matchingAsset(route.asset, plan.asset) || !Number.isSafeInteger(plan.contextSlot) || plan.contextSlot < 1 ||
      !Number.isSafeInteger(plan.lastValidBlockHeight) || plan.lastValidBlockHeight < 1 || rawLamports(plan.feeLamports) !== 5400n || plan.unsigned.length > 1644) throw Error('Invalid quote-fee plan.');
  const tx = VersionedTransaction.deserialize(Buffer.from(plan.unsigned, 'base64'));
  if (Buffer.from(tx.serialize()).toString('base64') !== plan.unsigned || tx.signatures.some(s => s.some(n => n !== 0)) ||
      tx.message.header.numRequiredSignatures !== 1 || tx.message.addressTableLookups.length) throw Error('Invalid unsigned quote-fee packet.');
  const expected = new TransactionMessage({ payerKey: new PublicKey(payer), recentBlockhash: tx.message.recentBlockhash,
    instructions: await quoteFeeInstructions(route, payer, plan.sweeps) }).compileToV0Message();
  if (!Buffer.from(expected.serialize()).equals(Buffer.from(tx.message.serialize()))) throw Error('Quote-fee instructions changed.');
  return tx;
}

export async function prepareQuoteFees(connection: Connection, route: QuoteFeeRoute, payer: string, minimumRaw: string): Promise<QuoteFeePlan | null> {
  validateQuoteFeeRoute(route, payer);
  const minimum = rawLamports(minimumRaw);
  if (minimum === 0n) throw Error('A reviewed quote-token threshold is required.');
  const snapshot = await readQuoteFees(connection, route);
  if (snapshot.availableRaw < minimum) return null;
  if (!snapshot.accountsReady) throw Error('Quote-fee token accounts need funded setup.');
  const block = await connection.getLatestBlockhash({ commitment: 'confirmed', minContextSlot: snapshot.slot });
  const message = new TransactionMessage({ payerKey: new PublicKey(payer), recentBlockhash: block.blockhash,
    instructions: await quoteFeeInstructions(route, payer, snapshot.sweeps) }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  let bytes: Uint8Array;
  try { bytes = tx.serialize(); } catch { throw Error('Quote-fee packet exceeds the atomic limit.'); }
  if (bytes.length > 1232) throw Error('Quote-fee packet exceeds the atomic limit.');
  const fee = (await connection.getFeeForMessage(message, 'confirmed')).value;
  if (fee !== 5400) throw Error('Quote-fee network cost changed.');
  const simulated = await connection.simulateTransaction(tx, { commitment: 'confirmed', sigVerify: false, innerInstructions: true, minContextSlot: snapshot.slot });
  if (simulated.value.err) throw Error('Quote-fee simulation failed.');
  verifyPayoutSimulationCosts(simulated.value.innerInstructions, payer);
  const plan: QuoteFeePlan = { unsigned: Buffer.from(bytes).toString('base64'), lastValidBlockHeight: block.lastValidBlockHeight,
    feeLamports: String(fee), asset: { ...route.asset }, contextSlot: snapshot.slot, sweeps: snapshot.sweeps };
  await verifyQuoteFeePlan(route, payer, plan);
  return plan;
}

export async function quoteFeeReceipt(route: QuoteFeeRoute, attempt: QuoteFeeAttempt, tx: VersionedTransactionResponse): Promise<QuoteFeeReceipt | null> {
  await verifyQuoteFeePlan(route, attempt.payer, attempt);
  if (verifyPayoutSignature(attempt, attempt.signed, attempt.payer) !== attempt.signature) throw Error('Quote-fee signature mismatch.');
  const signed = VersionedTransaction.deserialize(Buffer.from(attempt.signed, 'base64'));
  const meta = tx.meta, keys = tx.transaction.message.staticAccountKeys;
  if (!meta || tx.transaction.signatures[0] !== attempt.signature || !Buffer.from(tx.transaction.message.serialize()).equals(Buffer.from(signed.message.serialize())) ||
      safeInteger(tx.slot) < BigInt(attempt.contextSlot) || safeInteger(meta.fee) !== rawLamports(attempt.feeLamports) ||
      meta.preBalances.length !== keys.length || meta.postBalances.length !== keys.length ||
      meta.loadedAddresses && (meta.loadedAddresses.writable.length || meta.loadedAddresses.readonly.length)) throw Error('Quote-fee receipt differs from its plan.');
  // Non-native distributions transfer tokens only. Every account keeps its SOL
  // balance, except the payer's exact network fee. Refuse hidden ATA rent.
  for (let i = 0; i < keys.length; i++) {
    if (safeInteger(meta.preBalances[i]) - safeInteger(meta.postBalances[i]) !== (i === 0 ? BigInt(meta.fee) : 0n)) throw Error('Unexpected SOL spending in quote-fee receipt.');
  }
  if (!meta.preTokenBalances || !meta.postTokenBalances) throw Error('Quote-fee token balances unavailable.');
  const a = quoteFeeAccounts(route);
  const delta = (address: PublicKey, owner: string) => {
    const index = keys.findIndex(k => k.equals(address));
    if (index < 0) throw Error('Quote-fee recipient account missing.');
    const amount = (balances: NonNullable<typeof meta.preTokenBalances>) => {
      const rows = balances.filter(b => b.accountIndex === index);
      if (rows.length !== 1 || rows[0].mint !== route.asset.mint || rows[0].programId !== route.asset.tokenProgram || rows[0].owner !== owner ||
          rows[0].uiTokenAmount.decimals !== route.asset.decimals) throw Error('Quote-fee token evidence mismatch.');
      return rawLamports(rows[0].uiTokenAmount.amount);
    };
    return amount(meta.postTokenBalances!) - amount(meta.preTokenBalances!);
  };
  const recipient = delta(a.recipient, route.recipient), treasury = delta(a.treasury, route.buybackWallet);
  if (meta.err) {
    if (recipient || treasury) throw Error('Failed quote-fee payout changed proceeds.');
    return null;
  }
  validatePayoutAmounts(route, recipient.toString(), treasury.toString());
  if (recipient + treasury === 0n) throw Error('Quote-fee payout had no proceeds.');
  return { slot: tx.slot, asset: { ...route.asset }, recipientRaw: recipient.toString(), treasuryRaw: treasury.toString(), networkFeeLamports: String(meta.fee) };
}
