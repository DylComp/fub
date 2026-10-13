import {cashDepositTransaction,inspectCashDepositMessage} from '../src/cash-deposit-signing.js';
export {cashDepositTransaction} from '../src/cash-deposit-signing.js';
import { createPublicKey, verify } from 'node:crypto';
import bs58 from 'bs58';
import { AccountLayout, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { CASH_MINT, type CashRouteIntent, type CashRouteQuote } from '../src/cash-route.js';
import { inspectCashQuote } from './cash-route.js';
import { MAINNET_GENESIS } from './solana-network.js';
import type { Rpc } from './funding.js';
import {cashContextRead} from './cash-context-read.js';

const VAULT = '7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ';
const SYSTEM = '11111111111111111111111111111111';
const ata = (owner: string) => getAssociatedTokenAddressSync(new PublicKey(CASH_MINT), new PublicKey(owner), true).toBase58();
const integer = (v: unknown): number => { if (!Number.isSafeInteger(v) || Number(v) < 0) throw Error('Invalid cash chain context.'); return Number(v); };
export type CashDepositReview = {
  admission?: 'public-v1'; publicSaleId?:string;
  version: 1 | 2; quote: CashRouteQuote; intent: CashRouteIntent; unsigned: string; rawQuote?: unknown;
  blockhash: string; lastValidBlockHeight: number; slot: number;
  maxFeeLamports: string; maxRentLamports: string;
};
function bytes64(value: string) {
  if (typeof value !== 'string' || value.length > 1700) throw Error('Invalid cash transaction.');
  const b = Buffer.from(value, 'base64');
  if (b.toString('base64') !== value || b.length > 1232) throw Error('Invalid cash transaction.');
  return b;
}
// Always build from checked fields. Provider serialized transactions, lookup
// tables and added instructions are never passed to a signing wallet.
export function inspectSignedCashDeposit(review: CashDepositReview, signed: string): string {
  const tx = VersionedTransaction.deserialize(bytes64(signed));
  inspectCashDepositMessage(review,tx);
  const key = createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'), new PublicKey(review.quote.sourceWallet).toBuffer()]),format:'der',type:'spki'});
  if (!verify(null,tx.message.serialize(),key,tx.signatures[0])) throw Error('The cash signature does not match its wallet.');
  return bs58.encode(tx.signatures[0]);
}
function token(value: any, owner: string) {
  if (!value || value.owner !== TOKEN_PROGRAM_ID.toBase58() || value.executable !== false ||
    !Array.isArray(value.data) || value.data[1] !== 'base64' || typeof value.data[0] !== 'string' || value.data[0].length !== 220)
    throw Error('The cash account is unavailable.');
  const bytes = Buffer.from(value.data[0],'base64');
  if (bytes.length !== 165 || bytes.toString('base64') !== value.data[0]) throw Error('Invalid cash account.');
  const t = AccountLayout.decode(bytes);
  if (t.owner.toBase58() !== owner || t.mint.toBase58() !== CASH_MINT || t.state !== 1 || t.isNativeOption !== 0)
    throw Error('An active standard USDC account is required.');
  return {amount:t.amount,bytes};
}
function system(value: any) {
  if (!value || value.owner !== SYSTEM || value.executable !== false || value.data?.[0] !== '' || value.data?.[1] !== 'base64')
    throw Error('Unsupported cash fee payer.');
  return integer(value.lamports);
}
export async function simulateCashDeposit(review: CashDepositReview, rpc: Rpc, signed?: string, now = Date.now()) {
  // Snapshot the immutable review; an in-flight caller cannot change a retry.
  review = structuredClone(review);
  const { quote } = review, started = performance.now();
  const fresh = () => { if (quote.expiresAt <= now + Math.max(0,performance.now()-started)) throw Error('Refresh the cash transaction before signing.'); };
  if (![1,2].includes(review.version) || quote.expiresAt <= now || quote.checkedAt > now + 1000 ||
    !/^[1-9]\d{0,6}$/.test(review.maxFeeLamports) || BigInt(review.maxFeeLamports) > 100000n ||
    !/^\d{1,7}$/.test(review.maxRentLamports) || BigInt(review.maxRentLamports) > 2500000n)
    throw Error('Refresh the cash transaction before signing.');
  if (signed) inspectSignedCashDeposit(review,signed);
  const expected = cashDepositTransaction(quote,review.blockhash,review.version);
  if (!Buffer.from(expected.serialize()).equals(bytes64(review.unsigned))) throw Error('Cash transaction integrity failed.');
  // Fee lookup and simulation must describe the actual wallet-signed message,
  // including any accepted assertion instructions or capped compute changes.
  const tx = signed ? VersionedTransaction.deserialize(bytes64(signed)) : expected;
  const depositIndex=inspectCashDepositMessage(review,tx);
  if (await rpc('getGenesisHash',[]) !== MAINNET_GENESIS) throw Error('Solana mainnet is required.');
  const source = ata(quote.sourceWallet), vault = ata(VAULT);
  const invariant = (b:Buffer) => Buffer.concat([b.subarray(0,64),b.subarray(72)]);
  let sourceInvariant:Buffer|undefined,minSlot=review.slot;
  // A separate wallet transaction can change balances between finalized banks.
  // Retry only that ambiguity, never a same-bank discrepancy or altered transfer.
  // Each attempt rereads all accounts and fees for the exact same transaction.
  for (let attempt=0;attempt<3;attempt++) {
  fresh();
  const before = await cashContextRead(rpc,'getMultipleAccounts',[[quote.sourceWallet,source,vault],{encoding:'base64',commitment:'finalized',minContextSlot:minSlot}]) as any;
  const slot = integer(before?.context?.slot);
  if (slot < minSlot) throw Error('Cash simulation context mismatch.');
  if (before?.value?.length !== 3) throw Error('Cash balances unavailable.');
  const sol = system(before.value[0]), from = token(before.value[1],quote.sourceWallet), to = before.value[2] ? token(before.value[2],VAULT) : null;
  fresh();
  const currentInvariant=invariant(from.bytes);
  if(sourceInvariant&&!sourceInvariant.equals(currentInvariant))throw Error('Cash simulation account invariant changed.');
  sourceInvariant=currentInvariant;
  if (from.amount < BigInt(quote.amountRaw)) throw Error('Not enough Solana USDC for this purchase.');
  const rent = to ? 0 : integer(await rpc('getMinimumBalanceForRentExemption',[165,{commitment:'finalized'}]));
  const fee = await cashContextRead(rpc,'getFeeForMessage',[Buffer.from(tx.message.serialize()).toString('base64'),{commitment:'finalized',minContextSlot:slot}]) as any;
  fresh();
  const feeLamports = integer(fee?.value),feeSlot=integer(fee?.context?.slot);
  if (feeSlot < slot) throw Error('Cash simulation context mismatch.');
  if (feeLamports < 5000 || feeLamports > Number(review.maxFeeLamports) ||
    rent > Number(review.maxRentLamports) || sol < feeLamports + rent) throw Error('Cash purchase exceeds its SOL fee limit.');
  const result = await cashContextRead(rpc,'simulateTransaction',[signed || review.unsigned,{encoding:'base64',sigVerify:!!signed,
    replaceRecentBlockhash:false,commitment:'finalized',minContextSlot:feeSlot,innerInstructions:true,accounts:{encoding:'base64',addresses:[quote.sourceWallet,source,vault]}}]) as any;
  fresh();
  const simulationSlot=integer(result?.context?.slot);
  if (simulationSlot < feeSlot) throw Error('Cash simulation context mismatch.');
  if (result?.value?.err !== null || result.value.accounts?.length !== 3)
    throw Error('Cash deposit simulation failed.');
  // The shared Relay vault changes between RPC reads as other users deposit.
  // Verify this simulation's exact transfer, rather than subtracting snapshots
  // from different blocks and attributing unrelated deposits to this purchase.
  const groups=result.value.innerInstructions,inner=groups?.[0]?.instructions;
  const transfer=inner?.[0],info=transfer?.parsed?.info;
  if(!Array.isArray(groups)||groups.length!==1||groups[0].index!==depositIndex||!Array.isArray(inner)||inner.length!==1||
    transfer.programId!==TOKEN_PROGRAM_ID.toBase58()||transfer.parsed?.type!=='transferChecked'||
    info?.authority!==quote.sourceWallet||info?.source!==source||info?.destination!==vault||info?.mint!==CASH_MINT||
    info?.tokenAmount?.amount!==quote.amountRaw||info?.tokenAmount?.decimals!==6)throw Error('Cash simulation transfer differs from the approved purchase.');
  const [payer,src,dest] = result.value.accounts, afterFrom = token(src,quote.sourceWallet), afterTo = token(dest,VAULT);
  // Only the token amount bytes may change on the source account. Delegates,
  // close authority, owner, state and mint must remain exactly unchanged.
  if (!invariant(from.bytes).equals(invariant(afterFrom.bytes))) throw Error('Cash simulation account invariant changed.');
  if (afterTo.amount < BigInt(quote.amountRaw)) throw Error('Cash deposit simulation differs from the approved purchase.');
  const afterSol=system(payer);
  if (from.amount-afterFrom.amount !== BigInt(quote.amountRaw) || sol-afterSol !== feeLamports+rent) {
    if (simulationSlot===slot) throw Error('Cash deposit simulation differs from the approved purchase.');
    if (attempt===2) throw Error('Cash simulation balance snapshots did not converge.');
    minSlot=simulationSlot;
    continue;
  }
  fresh();
  return {feeLamports:String(feeLamports),rentLamports:String(rent),slot};
  }
  throw Error('Cash simulation balance snapshots did not converge.');
}
export async function prepareCashDeposit(rawQuote: unknown, intent: CashRouteIntent, rpc: Rpc,
  caps: { maxFeeLamports: string; maxRentLamports: string }, now = Date.now()): Promise<CashDepositReview> {
  const quote = inspectCashQuote(rawQuote,intent,now);
  const latest = await rpc('getLatestBlockhash',[{commitment:'finalized'}]) as any;
  const blockhash = latest?.value?.blockhash;
  if (typeof blockhash !== 'string' || new PublicKey(blockhash).toBase58() !== blockhash) throw Error('Invalid cash blockhash.');
  const review: CashDepositReview = {version:2,quote,rawQuote,intent:{...intent},...caps,blockhash,
    lastValidBlockHeight:integer(latest.value.lastValidBlockHeight),slot:integer(latest.context?.slot),
    unsigned:Buffer.from(cashDepositTransaction(quote,blockhash).serialize()).toString('base64')};
  await simulateCashDeposit(review,rpc,undefined,now);
  return review;
}
