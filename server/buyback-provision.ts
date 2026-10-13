import { createRequire } from 'node:module';
import { Connection, PublicKey, SystemProgram, ComputeBudgetProgram, TransactionMessage, VersionedTransaction, type AccountInfo } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, ACCOUNT_SIZE, ExtensionType, getExtensionTypes, getAssociatedTokenAddressSync, unpackMint, unpackAccount, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';

const require = createRequire(import.meta.url);
const pump = require('@pump-fun/pump-sdk') as typeof import('@pump-fun/pump-sdk');
const amm = require('@pump-fun/pump-swap-sdk') as typeof import('@pump-fun/pump-swap-sdk');
const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const safe = (n: number) => { if (!Number.isSafeInteger(n) || n < 0) throw Error('Invalid provisioning amount'); return BigInt(n); };
export type ProvisionRole = 'token' | 'curve-volume' | 'amm-volume';
export type BuybackProvisionRequest = { payer: string; treasury: string; mint: string; maxSetupLamports: number };
export type BuybackProvisionReview = BuybackProvisionRequest & {
  tokenProgram: string; missing: ProvisionRole[]; unsigned: string; contextSlot: number;
  preparedAt: number; lastValidBlockHeight: number; debitLamports: number; networkFeeLamports: number;
};
function keys(p: BuybackProvisionRequest) {
  const [payer, treasury, mint] = [p.payer, p.treasury, p.mint].map(a => {
    const key = new PublicKey(a);
    if (key.toBase58() !== a || !PublicKey.isOnCurve(key.toBytes())) throw Error('Invalid provisioning address');
    return key;
  });
  if (new Set([p.payer, p.treasury, p.mint]).size !== 3 || safe(p.maxSetupLamports) > 10000000n || p.maxSetupLamports < 5400) throw Error('Invalid provisioning limits');
  return { payer, treasury, mint };
}
export function buybackProvisionAddresses(p: BuybackProvisionRequest, program: PublicKey) {
  const k = keys(p);
  if (![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some(v => v.equals(program))) throw Error('Unsupported provisioning mint');
  return { ...k, token: getAssociatedTokenAddressSync(k.mint, k.treasury, false, program),
    curve: pump.userVolumeAccumulatorPda(k.treasury), amm: amm.userVolumeAccumulatorPda(k.treasury),
    wsol: getAssociatedTokenAddressSync(NATIVE_MINT, k.treasury) };
}
export async function buybackProvisionInstructions(p: BuybackProvisionRequest, program: PublicKey, missing: ProvisionRole[]) {
  const a = buybackProvisionAddresses(p, program);
  const ordered: ProvisionRole[] = ['token', 'curve-volume', 'amm-volume'];
  if (!missing.length || missing.join() !== ordered.filter(r => missing.includes(r)).join()) throw Error('Invalid provisioning account selection');
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 })];
  if (missing.includes('token')) instructions.push(createAssociatedTokenAccountIdempotentInstruction(a.payer, a.token, a.treasury, a.mint, program));
  if (missing.includes('curve-volume')) instructions.push(await pump.PUMP_SDK.initUserVolumeAccumulator({ payer: a.payer, user: a.treasury }));
  if (missing.includes('amm-volume')) instructions.push(await amm.PUMP_AMM_SDK.initUserVolumeAccumulator({ payer: a.payer, user: a.treasury }));
  return instructions;
}
function inspectAccount(role: ProvisionRole, info: AccountInfo<Buffer>, a: ReturnType<typeof buybackProvisionAddresses>, program: PublicKey) {
  if (info.executable) throw Error('Executable provisioning account');
  if (role === 'token') {
    const t = unpackAccount(a.token, info, program);
    if (!t.owner.equals(a.treasury) || !t.mint.equals(a.mint) || !t.isInitialized || t.isFrozen || t.isNative || t.delegate || t.closeAuthority || getExtensionTypes(t.tlvData).some(e => e !== ExtensionType.ImmutableOwner)) throw Error('Invalid treasury token account');
  } else {
    const isCurve = role === 'curve-volume';
    if (!info.owner.equals(isCurve ? pump.PUMP_PROGRAM_ID : amm.PUMP_AMM_PROGRAM_ID)) throw Error('Invalid tracking account program');
    const state = isCurve ? pump.PUMP_SDK.decodeUserVolumeAccumulator(info) : amm.PUMP_AMM_SDK.decodeUserVolumeAccumulator(info);
    if (!state.user.equals(a.treasury)) throw Error('Invalid tracking account user');
  }
}

// Read and unsigned simulation only. Deliberately has no signer, storage mutation
// or send path. Provision both venues before activation so graduation needs no
// surprise owner signature. This does not establish route/trading readiness.
export async function prepareBuybackProvision(connection: Connection, p: BuybackProvisionRequest) {
  const { mint } = keys(p);
  if (await connection.getGenesisHash() !== MAINNET) throw Error('Mainnet provisioning required');
  const m = await connection.getAccountInfo(mint, 'finalized');
  if (!m || m.executable) throw Error('Provisioning mint unavailable');
  const a = buybackProvisionAddresses(p, m.owner), state = unpackMint(mint, m, m.owner);
  if (!state.isInitialized || state.freezeAuthority || state.decimals > 9 || getExtensionTypes(state.tlvData).some(e => ![ExtensionType.MetadataPointer, ExtensionType.TokenMetadata].includes(e))) throw Error('Unsupported provisioning mint');
  const addresses = [a.payer, a.treasury, a.token, a.curve, a.amm, a.wsol];
  const snapshot = await connection.getMultipleAccountsInfoAndContext(addresses, { commitment: 'finalized' });
  safe(snapshot.context.slot);
  if (snapshot.value.length !== addresses.length) throw Error('Incomplete provisioning snapshot');
  const [payer, treasury] = snapshot.value;
  for (const account of [payer, treasury]) if (!account || account.executable || !account.owner.equals(SystemProgram.programId) || account.data.length) throw Error('Invalid provisioning system account');
  const roles: ProvisionRole[] = ['token', 'curve-volume', 'amm-volume'];
  const missing = roles.filter((role, i) => { const account = snapshot.value[i + 2]; if (account) inspectAccount(role, account, a, m.owner); return !account; });
  const rent = safe(await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE, 'confirmed'));
  const common = { payer: p.payer, treasury: p.treasury, mint: p.mint, tokenProgram: m.owner.toBase58(), contextSlot: snapshot.context.slot,
    accounts: { token: a.token.toBase58(), curve: a.curve.toBase58(), amm: a.amm.toBase58() }, missing,
    existingWsol: snapshot.value[5] !== null, treasuryBalanceLamports: safe(treasury!.lamports).toString(),
    // The current worker reserves worst-case account rent even if returned later.
    ammMinimumOverheadLamports: (4n * rent + 5400n).toString() };
  if (!missing.length) return { ...common, review: null };
  const block = await connection.getLatestBlockhash({ commitment: 'confirmed', minContextSlot: snapshot.context.slot });
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: a.payer, recentBlockhash: block.blockhash, instructions: await buybackProvisionInstructions(p, m.owner, missing) }).compileToV0Message());
  if (transaction.serialize().length > 1232) throw Error('Provisioning packet too large');
  const fee = (await connection.getFeeForMessage(transaction.message, 'confirmed')).value;
  if (fee !== 5400) throw Error('Unexpected provisioning network fee');
  const simulation = await connection.simulateTransaction(transaction, { commitment: 'confirmed', sigVerify: false, minContextSlot: snapshot.context.slot, accounts: { encoding: 'base64', addresses: addresses.map(k => k.toBase58()) } });
  if (simulation.value.err || safe(simulation.context.slot) < safe(snapshot.context.slot) || simulation.value.accounts?.length !== addresses.length) throw Error('Provisioning simulation failed');
  const after = simulation.value.accounts.map(info => {
    if (!info) return null;
    if (info.data[1] !== 'base64') throw Error('Invalid provisioning simulation encoding');
    return { ...info, owner: new PublicKey(info.owner), data: Buffer.from(info.data[0], 'base64') };
  });
  const unchanged = (before: AccountInfo<Buffer> | null, next: AccountInfo<Buffer> | null) => before === null ? next === null : !!next && before.owner.equals(next.owner) && before.executable === next.executable && before.data.equals(next.data) && before.lamports === next.lamports;
  if (!unchanged(treasury, after[1]) || !unchanged(snapshot.value[5], after[5]) || !after[0] || !after[0].owner.equals(SystemProgram.programId) || after[0].executable || after[0].data.length) throw Error('Provisioning changed unrelated funds');
  let createdRent = 0n;
  roles.forEach((role, i) => {
    const next = after[i + 2];
    if (!next) throw Error('Provisioning account missing after simulation');
    inspectAccount(role, next, a, m.owner);
    const before = snapshot.value[i + 2];
    if (before && !unchanged(before, next)) throw Error('Provisioning touched existing account');
    if (!before) createdRent += safe(next.lamports);
  });
  const debit = safe(payer!.lamports) - safe(after[0].lamports);
  if (debit !== createdRent + BigInt(fee) || debit > BigInt(p.maxSetupLamports)) throw Error('Provisioning exceeds exact rent and fee limits');
  const review: BuybackProvisionReview = { ...p, tokenProgram: m.owner.toBase58(), missing, unsigned: Buffer.from(transaction.serialize()).toString('base64'), contextSlot: snapshot.context.slot, preparedAt: Date.now(), lastValidBlockHeight: block.lastValidBlockHeight, debitLamports: Number(debit), networkFeeLamports: fee };
  return { ...common, review };
}
