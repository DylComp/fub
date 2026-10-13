import { createHash, createPublicKey, verify } from 'node:crypto';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import canonicalize from 'canonicalize';
import type { PublishedLaunch } from '../src/launch-publication.js';
import { validPublishedLaunch } from '../src/launch-publication.js';
import { SOL_PAIR_MINT, pairAmount } from '../src/launch-pairs.js';
import { launchShares, initialBuyLamports } from '../src/launch-model.js';

export type LaunchExecutionPlan = {
  version:1; publication:PublishedLaunch; mint:string; buybackWallet:string;
  unsigned:string; lastValidBlockHeight:number; contextSlot:number;
  feeLamports:string; maxWalletDebitLamports:string; openingTokens:string;
  quoteSpend?:{mint:string;tokenProgram:string;decimals:number;maxRaw:string};
  preparedAt:number; review?:import("../src/launch-signing.js").LaunchReviewEvidence;
};
export type LaunchExecutionReceipt = {slot:number;signature:string;mint:string;owner:string;recipient:string;buybackWallet:string;networkFeeLamports:string;walletDebitLamports:string;openingTokens:string;quoteDebit?:{mint:string;tokenProgram:string;decimals:number;raw:string}};
export type LaunchExecutionState = 'prepared'|'pending'|'expired_unresolved'|'confirmed'|'failed'|'superseded';
export type LaunchExecution = {id:string;plan:LaunchExecutionPlan;state:LaunchExecutionState;signed:string|null;signature:string|null;receipt:LaunchExecutionReceipt|null;nonlandingProof?:import("./launch-expiry.js").LaunchNonlandingProof};
export const launchPlanHash=(p:LaunchExecutionPlan)=>createHash('sha256').update(canonicalize(p)!).digest('hex');
export function launchPacket(encoded:string){
  if(typeof encoded!=='string'||encoded.length>1644)throw Error('Launch packet too large.');
  const bytes=Buffer.from(encoded,'base64');
  if(bytes.toString('base64')!==encoded||bytes.length>1232)throw Error('Invalid launch packet.');
  const tx=VersionedTransaction.deserialize(bytes);
  if(Buffer.from(tx.serialize()).toString('base64')!==encoded||tx.version!==0)throw Error('Unsupported launch packet.');
  return tx;
}
export function launchAmount(n:unknown):bigint{
  if(typeof n!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(n)||BigInt(n)>18446744073709551615n)throw Error('Invalid launch amount.');return BigInt(n);
}
export function validateLaunchPlan(p:LaunchExecutionPlan){
  if(p.version!==1||!validPublishedLaunch(p.publication,p.publication.owner))throw Error('Invalid launch publication.');
  const keys=[p.publication.owner,p.mint,p.publication.recipient,p.buybackWallet];
  if(keys.some(k=>new PublicKey(k).toBase58()!==k||!PublicKey.isOnCurve(new PublicKey(k).toBytes()))||[p.publication.owner,p.publication.recipient,p.buybackWallet].includes(p.mint))throw Error('Invalid launch addresses.');
  launchShares(p.publication.recipient,p.buybackWallet);
  if(![p.lastValidBlockHeight,p.contextSlot,p.preparedAt].every(n=>Number.isSafeInteger(n)&&n>0)||launchAmount(p.feeLamports)<10000n||launchAmount(p.feeLamports)>100000n||launchAmount(p.maxWalletDebitLamports)<launchAmount(p.feeLamports))throw Error('Invalid launch costs or lifetime.');
  const custom=!!p.publication.draft.quoteMint&&p.publication.draft.quoteMint!==SOL_PAIR_MINT;
  if(custom){const q=p.quoteSpend;if(!q||q.mint!==p.publication.draft.quoteMint||!['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'].includes(q.tokenProgram)||pairAmount(p.publication.draft.initialBuy,q.decimals)!==launchAmount(q.maxRaw))throw Error('Invalid quote spending.');}
  else if(p.quoteSpend)throw Error('Unexpected quote spending.');
  const buy=custom?launchAmount(p.quoteSpend!.maxRaw):initialBuyLamports(p.publication.draft.initialBuy);
  if((buy>0n)!==(launchAmount(p.openingTokens)>0n))throw Error('Invalid opening buy.');
  const tx=launchPacket(p.unsigned);
  if(tx.signatures.some(s=>s.some(n=>n!==0))||tx.message.header.numRequiredSignatures!==2||tx.message.staticAccountKeys[0].toBase58()!==p.publication.owner||tx.message.staticAccountKeys[1].toBase58()!==p.mint)throw Error('Launch requires only its owner and mint signatures.');
  return tx;
}
export function verifyLaunchSigned(p:LaunchExecutionPlan,signed:string){
  const original=validateLaunchPlan(p),tx=launchPacket(signed);
  if(!Buffer.from(original.message.serialize()).equals(Buffer.from(tx.message.serialize())))throw Error('Signing changed the reviewed launch.');
  for(let i=0;i<2;i++){
    const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),tx.message.staticAccountKeys[i].toBuffer()]),format:'der',type:'spki'});
    if(!verify(null,tx.message.serialize(),key,tx.signatures[i]))throw Error('Both launch signatures are required.');
  }
  return bs58.encode(tx.signatures[0]);
}

export type LaunchExpiryProof = {blockHeight:number;slot:number;checkedAt:number};
export function validateLaunchExpiry(p:LaunchExecutionPlan,proof:LaunchExpiryProof){
 if(![proof.blockHeight,proof.slot,proof.checkedAt].every(Number.isSafeInteger)||proof.blockHeight<=p.lastValidBlockHeight||proof.slot<p.contextSlot||proof.checkedAt<=0||proof.checkedAt>Date.now()+30000||Date.now()-proof.checkedAt>60000)throw Error('Fresh finalized launch expiry evidence is required.');
}
