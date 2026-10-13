import { Buffer } from 'buffer';
import { ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
export const BUYBACK_SETUP = {
  owner: '2SCiPp8ZHFsooXVR74SQxqPP3X6R3XcX2e69iBhSs5Tr',
  treasury: 'FUBX2ib5W4NeGpq1fmnf71eqAH2xZPrA7skTYNSZ1146',
  mint: '9ywkrbaGneCjbGfxSX2R3x3RQhxwGVvCDMDHiVuuTkbh',
  ata: '8tos6ghfQ3skH8XewMPNnh9cXNDGWSFZ1EBvCseC59n8',
  volume: '849EUht5gJYoh4gruhyFZ1AMJNXq1vU3zP9psepu1SqX',
  cap: 2880000,
} as const;
export type BuybackSetupReview = { unsigned: string; ata: boolean; volume: boolean; debit: number; fee: number; preparedAt: number; lastValidBlockHeight: number };
const pk = (s: string) => new PublicKey(s);
// Fixed engineering account initialization only. No trade, transfer, delegation,
// authority change, arbitrary priority fee or program can pass this inspector.
// The sole priority option is a fixed 400 lamports within the original cap.
export function buybackSetupTransaction(blockhash: string, ata: boolean, volume: boolean, priority = false) {
  const instructions: TransactionInstruction[] = [];
  if (!ata && !volume) throw Error('Setup is already complete.');
  if (priority) instructions.push(ComputeBudgetProgram.setComputeUnitLimit({units:200000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:2000}));
  if (ata) instructions.push(createAssociatedTokenAccountIdempotentInstruction(pk(BUYBACK_SETUP.owner), pk(BUYBACK_SETUP.ata), pk(BUYBACK_SETUP.treasury), pk(BUYBACK_SETUP.mint), TOKEN_2022_PROGRAM_ID));
  if (volume) instructions.push(new TransactionInstruction({
    programId: pk('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
    keys: [
      { pubkey: pk(BUYBACK_SETUP.owner), isSigner: true, isWritable: true },
      { pubkey: pk(BUYBACK_SETUP.treasury), isSigner: false, isWritable: false },
      { pubkey: pk(BUYBACK_SETUP.volume), isSigner: false, isWritable: true },
      { pubkey: pk('11111111111111111111111111111111'), isSigner: false, isWritable: false },
      { pubkey: pk('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1'), isSigner: false, isWritable: false },
      { pubkey: pk('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'), isSigner: false, isWritable: false },
    ], data: Buffer.from([94, 6, 202, 115, 255, 96, 232, 183]),
  }));
  if (!instructions.length) throw Error('Setup is already complete.');
  return new VersionedTransaction(new TransactionMessage({ payerKey: pk(BUYBACK_SETUP.owner), recentBlockhash: blockhash, instructions }).compileToV0Message());
}
export function inspectBuybackSetup(plan: BuybackSetupReview, encoded = plan.unsigned) {
  if (!plan || typeof plan.ata !== 'boolean' || typeof plan.volume !== 'boolean' ||
    ![plan.debit, plan.fee, plan.preparedAt, plan.lastValidBlockHeight].every(n => Number.isSafeInteger(n) && n > 0) ||
    ![5000,5400].includes(plan.fee) || plan.debit > BUYBACK_SETUP.cap || plan.debit <= plan.fee || typeof encoded !== 'string' || encoded.length > 1644) throw Error('Account setup exceeds the approved limits.');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw Error('Invalid transaction encoding.');
  const tx = VersionedTransaction.deserialize(bytes);
  const expected = buybackSetupTransaction(tx.message.recentBlockhash, plan.ata, plan.volume, plan.fee===5400);
  if (!Buffer.from(tx.message.serialize()).equals(Buffer.from(expected.message.serialize())) || tx.signatures.length !== 1) throw Error('The transaction differs from the approved account setup.');
  return tx;
}
export async function verifySignedBuybackSetup(plan: BuybackSetupReview, encoded: string) {
  const original = inspectBuybackSetup(plan), signed = inspectBuybackSetup(plan, encoded);
  if (!Buffer.from(original.message.serialize()).equals(Buffer.from(signed.message.serialize()))) throw Error('The wallet changed the setup transaction.');
  const key = await crypto.subtle.importKey('raw', pk(BUYBACK_SETUP.owner).toBytes() as Uint8Array<ArrayBuffer>, 'Ed25519', false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', key, signed.signatures[0] as Uint8Array<ArrayBuffer>, signed.message.serialize() as Uint8Array<ArrayBuffer>)) throw Error('The setup signature is invalid.');
  return signed;
}
