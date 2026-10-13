import { AddressLookupTableProgram, ComputeBudgetProgram, PublicKey, Transaction } from '@solana/web3.js';
import { Buffer } from 'buffer';
// One approved infrastructure operation. No token launch, transfer, delegation,
// trading instruction, priority fee, or additional authority is permitted.
export const SETUP_OWNER = '2SCiPp8ZHFsooXVR74SQxqPP3X6R3XcX2e69iBhSs5Tr';
export const SETUP_CAP = 1600000;
export const SETUP_ADDRESSES = [
  '62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV',
  'Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y',
  '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt',
  '5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD',
] as const;
export type TableSetup = { unsigned: string; table: string; slot: number; preparedAt: number; lastValidBlockHeight: number; rent: number; fee: number; debit: number };
export function setupTransaction(slot: number, blockhash: string) {
  if (!Number.isSafeInteger(slot) || slot <= 0) throw Error('Invalid setup slot.');
  const owner = new PublicKey(SETUP_OWNER);
  const [create, table] = AddressLookupTableProgram.createLookupTable({ authority: owner, payer: owner, recentSlot: slot });
  const transaction = new Transaction({ feePayer: owner, recentBlockhash: blockhash }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }), create,
    AddressLookupTableProgram.extendLookupTable({ authority: owner, payer: owner, lookupTable: table, addresses: SETUP_ADDRESSES.map(a => new PublicKey(a)) }),
  );
  return { transaction, table: table.toBase58() };
}
export function inspectTableSetup(plan: TableSetup, encoded = plan.unsigned) {
  if (!plan || typeof encoded !== 'string' || encoded.length > 1644 || ![plan.slot, plan.preparedAt, plan.lastValidBlockHeight, plan.rent, plan.fee, plan.debit].every(n => Number.isSafeInteger(n) && n > 0) || plan.rent !== 1584960 || plan.fee !== 5000 || plan.debit !== plan.rent + plan.fee || plan.debit > SETUP_CAP) throw Error('Setup costs exceed or differ from the approved operation.');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw Error('Invalid setup encoding.');
  const transaction = Transaction.from(bytes);
  const expected = setupTransaction(plan.slot, transaction.recentBlockhash!);
  if (expected.table !== plan.table || !transaction.serializeMessage().equals(expected.transaction.serializeMessage()) || transaction.signatures.length !== 1 || !transaction.signatures[0].publicKey.equals(new PublicKey(SETUP_OWNER))) throw Error('Only the approved address table may be created.');
  return transaction;
}
export function verifySignedTableSetup(plan: TableSetup, encoded: string) {
  const original = inspectTableSetup(plan), signed = inspectTableSetup(plan, encoded);
  if (!original.serializeMessage().equals(signed.serializeMessage()) || !signed.verifySignatures()) throw Error('Wallet changed the setup or returned an invalid signature.');
  return signed;
}
