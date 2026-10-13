import {Buffer} from 'buffer';
import {ComputeBudgetProgram,PublicKey,TransactionInstruction,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {getAssociatedTokenAddressSync,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {CASH_MINT,type CashRouteQuote,type CashRouteIntent,validateCashIntent} from './cash-route.js';
import type {CashDepositReview} from '../server/cash-deposit';
const PROGRAM = '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2';
const CONFIG = 'Dodg2HifwU8rmaVVyMyUZDGTRbqAJTyVYxXPwcbNpBKc';
const VAULT = '7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ';
const SYSTEM = '11111111111111111111111111111111';
const ata = (owner: string) => getAssociatedTokenAddressSync(new PublicKey(CASH_MINT), new PublicKey(owner), true).toBase58();
export function cashDepositTransaction(quote: CashRouteQuote, blockhash: string, version: 1 | 2 = 2): VersionedTransaction {
  if(version!==1&&version!==2)throw Error('Unsupported cash deposit version.');
  const data = Buffer.alloc(48);
  data.set([11, 156, 96, 218, 39, 163, 180, 19],0);
  data.writeBigUInt64LE(BigInt(quote.amountRaw), 8);
  Buffer.from(quote.orderId.slice(2), 'hex').copy(data, 16);
  const accounts = [CONFIG, quote.sourceWallet, quote.sourceWallet, VAULT, CASH_MINT, ata(quote.sourceWallet), ata(VAULT),
    TOKEN_PROGRAM_ID.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), SYSTEM];
  const instruction = new TransactionInstruction({ programId: new PublicKey(PROGRAM), data,
    keys: accounts.map((pubkey, i) => ({ pubkey: new PublicKey(pubkey), isSigner: i === 1, isWritable: [1, 5, 6].includes(i) })) });
  return new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(quote.sourceWallet), recentBlockhash: blockhash,
    instructions: version===1 ? [instruction] : [ComputeBudgetProgram.setComputeUnitLimit({units:200000}), ComputeBudgetProgram.setComputeUnitPrice({microLamports:5000}), instruction] }).compileToV0Message());
}
export function verifyCashDepositReview(review:CashDepositReview,intent:CashRouteIntent){
 validateCashIntent(intent);
 const q=review.quote;
 if(![review.maxFeeLamports,review.maxRentLamports].every(v=>/^(0|[1-9]\d{0,9})$/.test(v)))throw Error('Invalid cash purchase fee limits.');
 if(![1,2].includes(review.version)||q.sourceWallet!==intent.sourceWallet||q.recipient!==intent.recipient.toLowerCase()||q.network!==intent.network||q.token!==intent.token.toLowerCase()||q.amountRaw!==intent.amountRaw||q.expiresAt<=Date.now()||q.checkedAt>Date.now()+1000||!/^0x[0-9a-f]{64}$/i.test(q.orderId)||!/^0x[0-9a-f]{64}$/i.test(q.requestId)||BigInt(review.maxFeeLamports)>10000n||BigInt(review.maxRentLamports)>2500000n||q.gasTopup?.budgetUsdcRaw!==intent.gasTopupUsdcRaw)throw Error('The cash purchase review changed.');
 if(!/^[1-9]\d{0,77}$/.test(q.outputRaw)||!/^[1-9]\d{0,77}$/.test(q.minimumRaw)||BigInt(q.minimumRaw)>BigInt(q.outputRaw)||BigInt(q.minimumRaw)<BigInt(q.outputRaw)*BigInt(10000-intent.slippageBps)/10000n)throw Error('The cash purchase minimum changed.');
 const expected=cashDepositTransaction(q,review.blockhash,review.version);
 if(Buffer.from(expected.serialize()).toString('base64')!==review.unsigned)throw Error('The cash deposit transaction changed.');
 return expected;
}

// Phantom can insert Lighthouse balance assertions while simulating a deposit.
// Compare the payment's instructions and permissions, not just its compiled
// account indexes. Only assertion instructions are accepted; memory writes,
// account creation, additional payments and blockhash replacement are not.
// Layout: Jac0xb/lighthouse@4c579479c98635e419b1b167f08be02a71604a71,
// programs/lighthouse/src/instruction.rs and types/assert/log_level.rs.
export const CASH_LIGHTHOUSE_PROGRAM = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
// Non-executable local diagnostics: no signatures, transaction bytes, wallet
// addresses, order IDs or balances. Retain the layout if a wallet is rejected.
export function cashDepositLayout(review:CashDepositReview,tx:VersionedTransaction){
 const expected=TransactionMessage.decompile(cashDepositTransaction(review.quote,review.blockhash,review.version).message).instructions.at(-1)!;
 const actual=TransactionMessage.decompile(tx.message);
 return {version:tx.version,blockhashMatches:tx.message.recentBlockhash===review.blockhash,
  instructions:actual.instructions.map((ix,index)=>({index,program:ix.programId.toBase58(),accounts:ix.keys.length,
   kind:ix.programId.toBase58()===CASH_LIGHTHOUSE_PROGRAM?ix.data[0]:null,
   guardLogLevel:ix.programId.toBase58()===CASH_LIGHTHOUSE_PROGRAM?ix.data[1]:null,
   guardDataLength:ix.programId.toBase58()===CASH_LIGHTHOUSE_PROGRAM?ix.data.length:null,
   guardTargets:ix.programId.toBase58()===CASH_LIGHTHOUSE_PROGRAM?ix.keys.map(k=>k.pubkey.toBase58()===review.quote.sourceWallet?'funding-wallet':k.pubkey.toBase58()===ata(review.quote.sourceWallet)?'funding-usdc':'other'):null,
   guardPaymentAccountIndexes:ix.programId.toBase58()===CASH_LIGHTHOUSE_PROGRAM?ix.keys.map(k=>expected.keys.findIndex(p=>p.pubkey.equals(k.pubkey))):null,
   paymentProgram:ix.programId.equals(expected.programId),
   paymentData:Buffer.from(ix.data).equals(expected.data),
   paymentAccounts:ix.keys.length===expected.keys.length&&ix.keys.every((k,i)=>k.pubkey.equals(expected.keys[i].pubkey)),
   paymentPermissions:ix.keys.length===expected.keys.length&&ix.keys.every((k,i)=>k.isSigner===expected.keys[i].isSigner&&k.isWritable===expected.keys[i].isWritable),
  }))};
}
export function inspectCashDepositMessage(review: CashDepositReview, signed: VersionedTransaction): number {
  const expected = cashDepositTransaction(review.quote, review.blockhash, review.version);
  const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
  const fail = (reason: string): never => { throw Error(`The signed purchase changed: ${reason}. Nothing was submitted.`); };
  if (Buffer.from(expected.serialize()).toString('base64') !== review.unsigned) fail('review integrity');
  if (signed.signatures.length !== 1) fail('signing permissions');
  if (equal(signed.message.serialize(), expected.message.serialize())) return review.version === 1 ? 0 : 2;
  if (review.version !== 2 || signed.version !== 0 || signed.message.addressTableLookups.length) fail('transaction format');
  if (signed.message.recentBlockhash !== review.blockhash) fail('blockhash');
  const original = TransactionMessage.decompile(expected.message), actual = TransactionMessage.decompile(signed.message);
  if (!actual.payerKey.equals(original.payerKey) || signed.message.header.numRequiredSignatures !== 1) fail('fee payer');
  const originalKeys = new Map(expected.message.staticAccountKeys.map((key, i) => [key.toBase58(), i]));
  const actualKeys = signed.message.staticAccountKeys.map(key => key.toBase58());
  if (new Set(actualKeys).size !== actualKeys.length || actualKeys.length !== originalKeys.size + 1) fail('account list');
  for (const [i, key] of actualKeys.entries()) {
    const old = originalKeys.get(key);
    if (old === undefined) {
      if (key !== CASH_LIGHTHOUSE_PROGRAM || signed.message.isAccountSigner(i) || signed.message.isAccountWritable(i)) fail('added account');
    } else if (signed.message.isAccountSigner(i) !== expected.message.isAccountSigner(old) ||
      signed.message.isAccountWritable(i) !== expected.message.isAccountWritable(old)) fail('account permissions');
  }
  if (actual.instructions.length < 4 || actual.instructions.length > 11) fail('instruction count');
  // The two compute instructions stay first. Read-only guards may surround
  // the one unchanged Relay deposit; they do not have to follow it.
  for (let i = 0; i < 2; i++) {
    const ix = actual.instructions[i];
    if (!ix.programId.equals(ComputeBudgetProgram.programId) || ix.keys.length ||
      ix.data[0] !== i + 2 || ix.data.length !== (i === 0 ? 5 : 9)) fail('fee instructions');
  }
  const units = actual.instructions[0].data.readUInt32LE(1), price = actual.instructions[1].data.readBigUInt64LE(1);
  if (!/^[1-9]\d{0,4}$/.test(review.maxFeeLamports) || BigInt(review.maxFeeLamports) > 10000n ||
    units < 200000 || units > 1400000 || price === 0n ||
    5000n + (BigInt(units) * price + 999999n) / 1000000n > BigInt(review.maxFeeLamports)) fail('network fee cap');
  const planned = original.instructions[2];
  const payments = actual.instructions.map((ix,index)=>({ix,index})).filter(({ix})=>ix.programId.equals(planned.programId));
  if(payments.length!==1)fail('payment instruction count');
  const {ix:deposit,index:depositIndex}=payments[0];
  if(!equal(deposit.data,planned.data))fail('payment amount or order');
  if(deposit.keys.length!==planned.keys.length||deposit.keys.some((k,i)=>!k.pubkey.equals(planned.keys[i].pubkey)))fail('payment recipient or accounts');
  if(deposit.keys.some((k,i)=>k.isSigner!==planned.keys[i].isSigner||k.isWritable!==planned.keys[i].isWritable))fail('payment account permissions');
  // Assertions can inspect the receiving vault or any other account already
  // in the exact reviewed payment. Limiting them to the funding side rejects
  // wallet recipient checks. They remain read-only program variants, with no
  // new accounts, privilege changes, extra payments or logging CPIs allowed.
  const assertionAccounts = new Set(planned.keys.map(k=>k.pubkey.toBase58()));
  for (const [index,guard] of actual.instructions.entries()) {
    if(index<2||index===depositIndex)continue;
    // 2/3: AccountData; 5/6: AccountInfo; 9/10: TokenAccount assertion(s).
    // These variants only read one account. The on-chain program validates
    // the assertion payload, and signed simulation must pass before sending.
    if(guard.programId.toBase58()!==CASH_LIGHTHOUSE_PROGRAM||guard.keys.length!==1)fail('wallet guard program or account count');
    if(!assertionAccounts.has(guard.keys[0].pubkey.toBase58()))fail('wallet guard target');
    if(guard.data.length<3||![2,3,5,6,9,10].includes(guard.data[0]))fail('wallet guard instruction');
    // Borsh 0.10 encodes enum ordinals, NOT the Rust repr discriminants.
    // SDK wire values 4/5 are failure-only plaintext/encoded logs. Values
    // 3/6 use a noop CPI and remain unsupported; 16/17 are invalid on wire.
    if(![0,1,2,4,5].includes(guard.data[1]))fail('wallet guard logging mode');
  }
  return depositIndex;
}
