import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { Connection, PublicKey, SystemProgram, type VersionedTransactionResponse } from '@solana/web3.js';
import bs58 from 'bs58';
import { GRADUATED_SETUP as fixed, graduatedSetupTransaction, inspectGraduatedSetup, verifySignedGraduatedSetup, type GraduatedSetupReview } from '../src/graduated-setup.js';
import { buybackSetupConnection } from './buyback-setup.js';
import { prepareBuybackProvision } from './buyback-provision.js';
import { graduatedSetupStore } from './graduated-setup-store.js';
import { verifyLaunchSharing } from './pump-launch.js';
const pump=createRequire(import.meta.url)('@pump-fun/pump-sdk') as typeof import('@pump-fun/pump-sdk');
const pk=(s:string)=>new PublicKey(s);
const safe=(n:number)=>{if(!Number.isSafeInteger(n)||n<0)throw Error('Invalid setup balance.');return n;};
async function fundingState(c:Connection){
 if(await c.getGenesisHash()!=='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')throw Error('Mainnet required.');
 const sharing=pump.feeSharingConfigPda(pk(fixed.fundingMint));
 if(!pump.creatorVaultPda(sharing).equals(pk(fixed.vault)))throw Error('Funding vault mismatch.');
 const r=await c.getMultipleAccountsInfoAndContext([pk(fixed.owner),pk(fixed.vault),sharing],'finalized');
 const [owner,vault,config]=r.value;
 if(!owner||!vault||!config||owner.executable||vault.executable||config.executable||!owner.owner.equals(SystemProgram.programId)||owner.data.length||!vault.owner.equals(SystemProgram.programId)||vault.data.length||!config.owner.equals(pump.PUMP_FEE_PROGRAM_ID))throw Error('Invalid approved funding accounts.');
 verifyLaunchSharing(pump.PUMP_SDK.decodeSharingConfig(config),fixed.fundingMint,fixed.owner,fixed.treasury);
 return {owner,vault,slot:r.context.slot};
}
export async function verifyGraduatedSetupReceipt(review:GraduatedSetupReview,signed:string,receipt:VersionedTransactionResponse){
 const tx=await verifySignedGraduatedSetup(review,signed),signature=bs58.encode(tx.signatures[0]),m=receipt.meta;
 if(!m||receipt.transaction.signatures[0]!==signature||!Buffer.from(receipt.transaction.message.serialize()).equals(Buffer.from(tx.message.serialize()))||!Number.isSafeInteger(receipt.slot)||receipt.slot<1||m.preBalances.length!==tx.message.staticAccountKeys.length||m.postBalances.length!==tx.message.staticAccountKeys.length)throw Error('Setup receipt does not match the signed packet.');
 const vault=tx.message.staticAccountKeys.findIndex(k=>k.toBase58()===fixed.vault);
 const debit=safe(m.preBalances[0])-safe(m.postBalances[0]),fee=safe(m.fee),gain=safe(m.postBalances[vault])-safe(m.preBalances[vault]);
 if(fee!==review.fee||debit>review.debit||debit>fixed.cap||debit<fee||(m.err?(debit!==fee||gain!==0):(debit<fixed.funding+fee||gain!==fixed.funding)))throw Error('Setup receipt exceeded its approved funding or cost.');
 return {signature,debit,slot:receipt.slot,success:!m.err};
}
async function receipt(c:Connection,journal:ReturnType<typeof graduatedSetupStore>,review:GraduatedSetupReview,signed:string){
 const tx=await verifySignedGraduatedSetup(review,signed),signature=bs58.encode(tx.signatures[0]);
 const found=await c.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
 if(!found)return null;
 const r=await verifyGraduatedSetupReceipt(review,signed,found);
 await journal.settle(signature,r.debit,r.success,r.slot);
 return {signature,state:r.success?'finalized':'failed',complete:r.success,debit:r.debit};
}
export async function prepareGraduatedSetup(c=buybackSetupConnection(),journal=graduatedSetupStore()){
 if(await c.getGenesisHash()!=='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')throw Error('Mainnet required.');
 const latest=await journal.latest();
 if(latest){
  if(latest.state==='confirmed')return {complete:true,signature:latest.signature,debit:Number(latest.debit_lamports)};
  if(latest.state==='pending'){
   const result=await receipt(c,journal,latest.review,latest.signed);
   if(result)return result;
   return {complete:false,pending:latest.signature};
  }
  if(latest.state==='failed')throw Error('The previous setup failed. Its fee must be counted before preparing another packet.');
 }
 const p=await prepareBuybackProvision(c,{payer:fixed.owner,treasury:fixed.treasury,mint:fixed.mint,maxSetupLamports:fixed.cap-fixed.funding});
 if(p.existingWsol||p.missing.includes('curve-volume'))throw Error('Treasury state changed. Resolve its existing accounts before funding.');
 const state=await fundingState(c),block=await c.getLatestBlockhash({commitment:'confirmed',minContextSlot:state.slot});
 const tx=graduatedSetupTransaction(block.blockhash,p.missing.includes('token'),p.missing.includes('amm-volume'));
 const sim=await c.simulateTransaction(tx,{sigVerify:false,commitment:'confirmed',minContextSlot:state.slot,accounts:{encoding:'base64',addresses:[fixed.owner,fixed.vault]}});
 if(sim.value.err||sim.context.slot<state.slot||!sim.value.accounts?.[0]||!sim.value.accounts[1])throw Error('Approved setup and funding simulation failed.');
 const fee=(await c.getFeeForMessage(tx.message,'confirmed')).value;
 const debit=safe(state.owner.lamports)-safe(sim.value.accounts[0].lamports);
 if(safe(sim.value.accounts[1].lamports)-safe(state.vault.lamports)!==fixed.funding||debit!==(p.review?.debitLamports??5400)+fixed.funding)throw Error('Funding simulation changed the approved amounts.');
 const review:GraduatedSetupReview={unsigned:Buffer.from(tx.serialize()).toString('base64'),ata:p.missing.includes('token'),volume:p.missing.includes('amm-volume'),debit,fee:fee!,preparedAt:Date.now(),lastValidBlockHeight:block.lastValidBlockHeight};
 inspectGraduatedSetup(review);
 return {complete:false,review};
}
export async function submitGraduatedSetup(review:GraduatedSetupReview,signed:string,c=buybackSetupConnection(),journal=graduatedSetupStore()){
 const tx=await verifySignedGraduatedSetup(review,signed),signature=bs58.encode(tx.signatures[0]);
 await fundingState(c);
 const prior=await journal.latest();
 if(prior?.signature===signature&&prior.state==='confirmed')return {signature,complete:true,state:'finalized'};
 const finalized=await c.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
 if(finalized){
  const r=await verifyGraduatedSetupReceipt(review,signed,finalized);
  await journal.save(signature,review,signed);await journal.settle(signature,r.debit,r.success,r.slot);
  return {signature,complete:r.success,state:r.success?'finalized':'failed'};
 }
 // Retain the exact wallet signature even after expiry. It may already be in
 // flight; expiry never authorizes a new deposit or discards its reservation.
 await journal.save(signature,review,signed);
 const [observed]=(await c.getSignatureStatuses([signature],{searchTransactionHistory:true})).value;
 if(observed)return {signature,state:observed.err?'failed':observed.confirmationStatus};
 if(Date.now()-review.preparedAt>120000||review.preparedAt>Date.now()+5000||await c.getBlockHeight('confirmed')>review.lastValidBlockHeight)return {signature,state:'expired_unresolved'};
 const state=await fundingState(c);
 const sim=await c.simulateTransaction(tx,{sigVerify:true,commitment:'confirmed',minContextSlot:state.slot,accounts:{encoding:'base64',addresses:[fixed.owner,fixed.vault]}});
 const debit=sim.value.accounts?.[0]&&safe(state.owner.lamports)-safe(sim.value.accounts[0].lamports),vault=sim.value.accounts?.[1];
 const fee=(await c.getFeeForMessage(tx.message,'confirmed')).value;
 if(sim.value.err||sim.context.slot<state.slot||!debit||debit>review.debit||debit>fixed.cap||fee!==review.fee||!vault||safe(vault.lamports)-safe(state.vault.lamports)!==fixed.funding)throw Error('Fresh setup checks failed. The signed packet remains saved; no replacement is allowed.');
 const start=Date.now();
 do{
  if(await c.getBlockHeight('confirmed')>review.lastValidBlockHeight)return {signature,state:'expired_unresolved'};
  try{if(await c.sendRawTransaction(tx.serialize(),{skipPreflight:false,maxRetries:3,preflightCommitment:'confirmed'})!==signature)throw Error('Unexpected signature.');}catch{/* Read actual status; retry only identical bytes. */}
  const found=await receipt(c,journal,review,signed);if(found)return found;
  const [status]=(await c.getSignatureStatuses([signature],{searchTransactionHistory:true})).value;
  if(status)return {signature,state:status.err?'failed':status.confirmationStatus};
  await delay(1500);
 }while(Date.now()-start<18000);
 return {signature,state:'submitted'};
}
