import { createRequire } from "node:module";
import { PublicKey, ComputeBudgetProgram, TransactionMessage, VersionedTransaction, AddressLookupTableAccount } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { Global, FeeConfig, SharingConfig, QuoteControl } from "@pump-fun/pump-sdk";
import type { ResolvedQuoteMint } from "@pump-fun/pump-sdk-next";
import { SOL_PAIR_MINT, pairAmount } from "../src/launch-pairs.js";
import { launchDraft, launchShares, initialBuyLamports } from "../src/launch-model.js";
import type { LaunchDraft } from "../src/launch-model.js";
// CommonJS avoids the SDK's Anchor ESM named-export incompatibility on Node.
const require = createRequire(import.meta.url);
const { PUMP_SDK, feeSharingConfigPda, creatorVaultPda, getBuyTokenAmountFromSolAmount } = require("@pump-fun/pump-sdk") as typeof import("@pump-fun/pump-sdk");
const BN = require("bn.js") as typeof import("bn.js");
const NEXT = require('@pump-fun/pump-sdk-next') as typeof import('@pump-fun/pump-sdk-next');
function signingAddress(value: string) {
  const key = new PublicKey(value);
  if (key.toBase58() !== value || !PublicKey.isOnCurve(key.toBytes())) throw Error("A Solana signing address is required.");
  return key;
}
export async function pumpLaunchInstructions(input: {
  draft: LaunchDraft; launcher: string; mint: string; metadataUri: string;
  recipient: string; buybackWallet: string;
  // Must be decoded from owner-checked, mainnet Pump accounts by the caller.
  buyState?: { global: Global; feeConfig: FeeConfig };
  // Decoded from this exact mint's unsigned create simulation, before any buy.
  openingCurve?: import('@pump-fun/pump-sdk-next').BondingCurve;
  quoteState?: ResolvedQuoteMint;
  quoteControl?: QuoteControl | null;
  // Existing signed v2 plans stay recoverable. New paired launches use v3.
  customBuyVersion?: 3;
  createBuybackQuoteAccount?: boolean;
}) {
  const d = launchDraft(input.draft), user = signingAddress(input.launcher), mint = signingAddress(input.mint);
  const shares = launchShares(input.recipient, input.buybackWallet).map(s => ({ address: signingAddress(s.address), shareBps: s.shareBps }));
  if ([input.launcher, input.recipient, input.buybackWallet].includes(input.mint)) throw Error("The mint must be a new, separate key.");
  const uri = new URL(input.metadataUri);
  if (uri.protocol !== "https:" || uri.username || uri.password || uri.port || new TextEncoder().encode(input.metadataUri).length > 200) throw Error("A permanent HTTPS metadata URI is required.");
  const custom = !!d.quoteMint && d.quoteMint !== SOL_PAIR_MINT;
  const quote = input.quoteState;
  if (custom && (!quote || quote.mint.toBase58() !== d.quoteMint ||
    ![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(quote.quoteTokenProgram.toBase58()) ||
    !quote.initialVirtualQuoteReserves.gtn(0))) throw Error("Resolve the exact supported quote mint on chain before building.");
  if (custom && quote!.source === 'pumpCoin' && !quote!.pumpQuote) throw Error('Pump-token pairs require their verified curve and pool accounts.');
  const quoteMint = custom ? quote!.mint : NATIVE_MINT, quoteTokenProgram = custom ? quote!.quoteTokenProgram : TOKEN_PROGRAM_ID;
  const buyLamports = custom ? pairAmount(d.initialBuy, quote!.decimals) : initialBuyLamports(d.initialBuy);
  const createTerms = { user, creator: user, mint, name: d.name, symbol: d.ticker, uri: input.metadataUri, mayhemMode: false, holderReward: false, cashback: false, quoteMint, quoteTokenProgram };
  const create = custom ? await NEXT.PUMP_SDK.createV2Instruction({ ...createTerms, pumpQuote: quote?.pumpQuote?.accounts }) : await PUMP_SDK.createV2Instruction(createTerms);
  const sharing = await PUMP_SDK.createFeeSharingConfig({ creator: user, mint, pool: null });
  // The SDK retains compact SOL-only instructions. They avoid unused quote
  // ATAs and keep optional opening buys within Solana's atomic packet limit.
  const split = buyLamports > 0n && !custom
    ? await PUMP_SDK.updateFeeShares({ authority: user, mint, currentShareholders: [user], newShareholders: shares })
    : await PUMP_SDK.updateFeeSharesV2({ authority: user, mint, currentShareholders: [user], newShareholders: shares, quoteMint, quoteTokenProgram });
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }), create, sharing];
  if (custom) {
    // Updating shares settles the existing shareholder first, even on a new
    // empty curve. Its quote account and the creator vault must already exist.
    for (const owner of [creatorVaultPda(feeSharingConfigPda(mint)), user, NEXT.ammCreatorVaultPda(feeSharingConfigPda(mint)), ...shares.map(s => s.address)].filter((key,index,all)=>all.findIndex(k=>k.equals(key))===index)) {
      instructions.push(createAssociatedTokenAccountIdempotentInstruction(user, getAssociatedTokenAddressSync(quoteMint, owner, true, quoteTokenProgram), owner, quoteMint, quoteTokenProgram));
    }
  }
  instructions.push(split);
  let tokens = "0";
  if (buyLamports > 0n) {
    const state = input.buyState;
    if (!state || !state.global.initialized || !state.global.createV2Enabled) throw Error("Fresh Pump buy terms are required.");
    const buybackFeeRecipient = state.global.buybackFeeRecipients.find(key => !key.equals(PublicKey.default));
    if (!buybackFeeRecipient) throw Error("Pump buyback fee recipient is unavailable.");
    const terms = { global: state.global, feeConfig: state.feeConfig, mintSupply: null, bondingCurve: null, amount: new BN(buyLamports.toString()), quoteMint, quoteControl: input.quoteControl };
    let amount;
    if(custom && input.openingCurve){
      const curve=input.openingCurve;
      if(!curve.quoteMint.equals(quoteMint)||!curve.creator.equals(feeSharingConfigPda(mint))||curve.complete||curve.isMayhemMode||curve.isHolderReward||curve.isCashbackCoin||!curve.realQuoteReserves.isZero()||!curve.realTokenReserves.eq(state.global.initialRealTokenReserves)||!curve.virtualTokenReserves.eq(state.global.initialVirtualTokenReserves)||!curve.tokenTotalSupply.eq(state.global.tokenTotalSupply)||curve.virtualQuoteReserves.lten(0))throw Error('Opening curve does not match this new paired launch.');
      amount=NEXT.getBuyTokenAmountFromSolAmount({...terms,global:state.global as import('@pump-fun/pump-sdk-next').Global,bondingCurve:curve,mintSupply:curve.tokenTotalSupply,quoteControl:undefined});
    } else if (custom && quote!.source === 'pumpCoin') {
      if (!('maxCurveDepth' in state.global) || !Number.isInteger(state.global.maxCurveDepth)) throw Error('Fresh Pump-token pairing terms are required.');
      amount = NEXT.getBuyTokenAmountFromSolAmount({ ...terms, global: state.global as import('@pump-fun/pump-sdk-next').Global, pumpQuote: quote!.pumpQuote!.curve, quoteControl: quote!.pumpQuote!.curve.quoteControl });
    } else amount = getBuyTokenAmountFromSolAmount(terms);
    if(custom&&input.customBuyVersion===3){
      const curve=input.openingCurve??NEXT.newBondingCurve(state.global as import('@pump-fun/pump-sdk-next').Global,quoteMint,input.quoteControl as import('@pump-fun/pump-sdk-next').QuoteControl|undefined,undefined,false,quote!.pumpQuote?.curve);
      if(!input.openingCurve)curve.isMayhemMode=false;
      amount=NEXT.getBuyV3TokenAmountFromQuoteAmount({global:state.global as import('@pump-fun/pump-sdk-next').Global,feeConfig:state.feeConfig,mintSupply:curve.tokenTotalSupply,bondingCurve:curve,amount:new BN(buyLamports.toString()),curveBaseTokenBalance:curve.tokenTotalSupply}).muln(99).divn(100);
      if(amount.gt(curve.realTokenReserves))throw Error('Opening buy exceeds this new curve’s available supply.');
    }
    if (amount.lten(0)) throw Error("Initial buy amount is too small.");
    tokens = amount.toString();
    instructions.push(createAssociatedTokenAccountIdempotentInstruction(user, getAssociatedTokenAddressSync(mint, user, false, TOKEN_2022_PROGRAM_ID), user, mint, TOKEN_2022_PROGRAM_ID));
    if(custom&&input.customBuyVersion===3){
      if(input.createBuybackQuoteAccount)instructions.push(createAssociatedTokenAccountIdempotentInstruction(user,getAssociatedTokenAddressSync(quoteMint,buybackFeeRecipient,true,quoteTokenProgram),buybackFeeRecipient,quoteMint,quoteTokenProgram));
      instructions.push(await NEXT.PUMP_SDK.getBuyV3InstructionRaw({user,mint,amount,quoteAmount:new BN(buyLamports.toString()),buybackFeeRecipient,tokenProgram:TOKEN_2022_PROGRAM_ID,quoteMint,quoteTokenProgram,partialFill:false}));
    }
    else if (custom) instructions.push(await PUMP_SDK.getBuyV2InstructionRaw({ user, mint, creator: feeSharingConfigPda(mint), amount, quoteAmount: new BN(buyLamports.toString()), feeRecipient: state.global.feeRecipient, buybackFeeRecipient, tokenProgram: TOKEN_2022_PROGRAM_ID, quoteMint, quoteTokenProgram }));
    else instructions.push(await PUMP_SDK.getBuyInstructionRaw({ user, mint, creator: feeSharingConfigPda(mint), amount, solAmount: new BN(buyLamports.toString()), feeRecipient: state.global.feeRecipient, buybackFeeRecipient, tokenProgram: TOKEN_2022_PROGRAM_ID }));
  }
  return { instructions, mint: input.mint, launcher: input.launcher, sharingConfig: feeSharingConfigPda(mint).toBase58(), shares: shares.map(s => ({ address: s.address.toBase58(), shareBps: s.shareBps })), purchase: { maxLamports: custom ? "0" : buyLamports.toString(), maxQuoteRaw: buyLamports.toString(), quoteMint: quoteMint.toBase58(), tokenAmount: tokens } };
}
export function compilePumpLaunch(built: Awaited<ReturnType<typeof pumpLaunchInstructions>>, blockhash: string, lookupTables: AddressLookupTableAccount[] = []) {
  if (lookupTables.length > 3 || lookupTables.some(t => !t.isActive())) throw Error("Unsupported launch lookup tables.");
  const message = new TransactionMessage({ payerKey: new PublicKey(built.launcher), recentBlockhash: new PublicKey(blockhash).toBase58(), instructions: built.instructions }).compileToV0Message(lookupTables);
  const transaction = new VersionedTransaction(message);
  let bytes: Uint8Array;
  try { bytes = transaction.serialize(); } catch { throw Error("The atomic launch needs a verified address lookup table."); }
  if (bytes.length > 1232 || message.header.numRequiredSignatures !== 2 || !message.staticAccountKeys[0].equals(new PublicKey(built.launcher)) || !message.staticAccountKeys[1].equals(new PublicKey(built.mint))) throw Error("The atomic launch needs a verified address lookup table and exactly the launcher and mint signatures.");
  return { unsigned: Buffer.from(bytes).toString("base64"), bytes: bytes.length, requiredSigners: [built.launcher, built.mint] };
}
export function verifyLaunchSharing(config: SharingConfig, mint: string, recipient: string, buybackWallet: string) {
  const expected = launchShares(recipient, buybackWallet);
  if (config.version < 2 || config.adminRevoked !== true || config.mint.toBase58() !== mint || config.shareholders.length !== 2 || expected.some(e => config.shareholders.filter(s => s.address.toBase58() === e.address && s.shareBps === e.shareBps).length !== 1)) throw Error("On-chain creator shares do not match this launch's permanent 80/20 split.");
}
// Permissionless distribution plan only: no recipient keys, custody or send.
// The caller must independently verify account owners, mint/quote and graduation.
export async function pumpDistributionInstructions(input: { payer: string; mint: string; recipient: string; buybackWallet: string; config: SharingConfig; graduated: boolean; sweepCurve?: boolean; sweepPool?: boolean }) {
  verifyLaunchSharing(input.config, input.mint, input.recipient, input.buybackWallet);
  const payer = signingAddress(input.payer), mint = new PublicKey(input.mint);
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 })];
  if (input.sweepPool && !input.graduated) throw Error('Pool fee sweep requires a graduated payout.');
  const sweep = { payer, mint, quoteMint: NATIVE_MINT, quoteTokenProgram: TOKEN_PROGRAM_ID };
  if (input.sweepCurve) instructions.push(await NEXT.PUMP_SDK.sweepCreatorFeeInstruction({ ...sweep, creator: feeSharingConfigPda(mint) }));
  if (input.sweepPool) instructions.push(await NEXT.PUMP_SDK.sweepPoolCreatorFeeInstruction({ ...sweep, coinCreator: feeSharingConfigPda(mint) }));
  if (input.graduated) instructions.push(await PUMP_SDK.transferCreatorFeesToPumpV2({ payer, mint, quoteMint: NATIVE_MINT, quoteTokenProgram: TOKEN_PROGRAM_ID }));
  instructions.push(await PUMP_SDK.distributeCreatorFeesV2({ mint, sharingConfig: input.config, sharingConfigAddress: feeSharingConfigPda(mint), quoteMint: NATIVE_MINT, quoteTokenProgram: TOKEN_PROGRAM_ID, payer, shouldInitializeAta: false }));
  return instructions;
}

// Select only addresses shared by two separately generated sample launches.
// The result is a setup plan, not an on-chain table or permission to fund it.
export function additionalPumpLookupAddresses(samples: Awaited<ReturnType<typeof pumpLaunchInstructions>>[], existing: AddressLookupTableAccount[]) {
  if (samples.length !== 2 || samples[0].mint === samples[1].mint || samples[0].launcher === samples[1].launcher) throw Error("Two independent sample launches are required.");
  const keys = (sample: typeof samples[number]) => new Map(sample.instructions.flatMap(ix => [ix.programId, ...ix.keys.filter(k => !k.isSigner).map(k => k.pubkey)]).map(k => [k.toBase58(), k]));
  const first = keys(samples[0]), second = keys(samples[1]);
  const excluded = new Set([...samples.flatMap(s => [s.launcher, s.mint, ...s.shares.map(v => v.address)]), ...existing.flatMap(t => t.state.addresses.map(k => k.toBase58()))]);
  const addresses = [...first].filter(([key]) => second.has(key) && !excluded.has(key)).map(([, key]) => key);
  if (!addresses.length || addresses.length > 20) throw Error("Lookup setup needs a separately reviewed multi-extension plan.");
  return addresses;
}
