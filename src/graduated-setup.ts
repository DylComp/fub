import { Buffer } from 'buffer';
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token';
export const GRADUATED_SETUP = {
  owner: '2SCiPp8ZHFsooXVR74SQxqPP3X6R3XcX2e69iBhSs5Tr',
  treasury: 'FUBX2ib5W4NeGpq1fmnf71eqAH2xZPrA7skTYNSZ1146',
  mint: 'DitHyRMQiSDhn5cnKMJV2CDDt6sVct96YrECiM49pump',
  ata: 'EKzkjVifmZ2b4QQ1xvjk6UyaHJZJEDE6ps1FoNMhk4Yt',
  volume: 'DTC1K8fU6YrNr5KSbFFGFrnhZLP6DHw7S2paKEbbKFwF',
  fundingMint: '9ywkrbaGneCjbGfxSX2R3x3RQhxwGVvCDMDHiVuuTkbh',
  vault: 'DogiAm1SZvr98dXnE2SwTs4YasXAaBcNzSGheM2umoPJ',
  funding: 25000000,
  cap: 27860000,
} as const;
export type GraduatedSetupReview = { unsigned: string; ata: boolean; volume: boolean; debit: number; fee: number; preparedAt: number; lastValidBlockHeight: number };
const pk = (s: string) => new PublicKey(s);
// One approved infrastructure/funding operation. No swap, burn, wallet authority
// change or destination supplied by the browser can enter this transaction.
export function graduatedSetupTransaction(blockhash: string, ata: boolean, volume: boolean) {
  const f = GRADUATED_SETUP, program = pk('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({units:400000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:1000})];
  if (ata) instructions.push(createAssociatedTokenAccountIdempotentInstruction(pk(f.owner),pk(f.ata),pk(f.treasury),pk(f.mint),TOKEN_PROGRAM_ID));
  if (volume) instructions.push(new TransactionInstruction({programId:program,keys:[
    {pubkey:pk(f.owner),isSigner:true,isWritable:true},
    {pubkey:pk(f.treasury),isSigner:false,isWritable:false},
    {pubkey:pk(f.volume),isSigner:false,isWritable:true},
    {pubkey:SystemProgram.programId,isSigner:false,isWritable:false},
    {pubkey:pk('GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR'),isSigner:false,isWritable:false},
    {pubkey:program,isSigner:false,isWritable:false},
  ],data:Buffer.from([94,6,202,115,255,96,232,183])}));
  instructions.push(SystemProgram.transfer({fromPubkey:pk(f.owner),toPubkey:pk(f.vault),lamports:f.funding}));
  return new VersionedTransaction(new TransactionMessage({payerKey:pk(f.owner),recentBlockhash:blockhash,instructions}).compileToV0Message());
}
export function inspectGraduatedSetup(plan: GraduatedSetupReview, encoded = plan.unsigned) {
  if (!plan || typeof plan.ata!=='boolean' || typeof plan.volume!=='boolean' ||
    ![plan.debit,plan.fee,plan.preparedAt,plan.lastValidBlockHeight].every(n=>Number.isSafeInteger(n)&&n>0) ||
    plan.fee!==5400 || plan.debit>GRADUATED_SETUP.cap || plan.debit<GRADUATED_SETUP.funding+plan.fee || typeof encoded!=='string' || encoded.length>1644) throw Error('Setup exceeds the approved PumpSwap test limits.');
  const bytes=Buffer.from(encoded,'base64');
  if(bytes.toString('base64')!==encoded)throw Error('Invalid setup encoding.');
  const tx=VersionedTransaction.deserialize(bytes),expected=graduatedSetupTransaction(tx.message.recentBlockhash,plan.ata,plan.volume);
  if(tx.signatures.length!==1 || !Buffer.from(tx.message.serialize()).equals(Buffer.from(expected.message.serialize())))throw Error('Setup differs from the approved accounts and fee-vault funding.');
  return tx;
}
export async function verifySignedGraduatedSetup(plan: GraduatedSetupReview, encoded: string) {
  const original=inspectGraduatedSetup(plan),signed=inspectGraduatedSetup(plan,encoded);
  if(!Buffer.from(original.message.serialize()).equals(Buffer.from(signed.message.serialize())))throw Error('The wallet changed the setup transaction.');
  const key=await crypto.subtle.importKey('raw',pk(GRADUATED_SETUP.owner).toBytes() as Uint8Array<ArrayBuffer>,'Ed25519',false,['verify']);
  if(!await crypto.subtle.verify('Ed25519',key,signed.signatures[0] as Uint8Array<ArrayBuffer>,signed.message.serialize() as Uint8Array<ArrayBuffer>))throw Error('The setup signature is invalid.');
  return signed;
}
