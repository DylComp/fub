import {createPublicKey,verify} from 'node:crypto';
import {ComputeBudgetProgram,SystemProgram,VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
import {CONTROLLED_TEST} from './controlled-leader-test.js';

// The caller must fetch this receipt with finalized commitment on mainnet.
// No transaction is constructed, signed or sent by this verifier.
export function verifyControlledFunding(receipt:unknown,expected:{follower:string;leader:string;signature:string;amountLamports?:string}){
 const amount=expected.amountLamports??CONTROLLED_TEST.leaderDebitCap;
 if(!['4000000','5000000'].includes(amount))throw Error('Unsupported controlled funding amount.');
 return verifyTransfer(receipt,expected,amount,true);
}
// Separate fixed-amount test-wallet rebalance. Never relax new-wallet funding.
export function verifyControlledRebalance(receipt:unknown,expected:{follower:string;leader:string;signature:string}){
 return verifyTransfer(receipt,expected,'100000',false);
}
function verifyTransfer(receipt:unknown,expected:{follower:string;leader:string;signature:string},fundingAmount:string,newRecipient:boolean){
 const fail=():never=>{throw Error('Funding receipt does not match the approved transfer.');};
 const r=receipt as {slot:number;blockTime:number;transaction:[string,string];meta:{err:unknown;fee:number;preBalances:number[];postBalances:number[];innerInstructions:unknown[]|null}};
 if(!r||!Number.isSafeInteger(r.slot)||r.slot<1||!Number.isSafeInteger(r.blockTime)||r.blockTime<1||
  !Array.isArray(r.transaction)||r.transaction[1]!=='base64'||typeof r.transaction[0]!=='string'||r.transaction[0].length>1800)return fail();
 const tx=VersionedTransaction.deserialize(Buffer.from(r.transaction[0],'base64')),m=tx.message;
 if(![0,'legacy'].includes(m.version)||m.addressTableLookups.length||![3,4].includes(m.staticAccountKeys.length)||m.compiledInstructions.length<1||m.compiledInstructions.length>3||tx.signatures.length!==1||
  m.header.numRequiredSignatures!==1||m.header.numReadonlySignedAccounts!==0||m.header.numReadonlyUnsignedAccounts!==m.staticAccountKeys.length-2)return fail();
 if(expected.follower===expected.leader||m.staticAccountKeys[0].toBase58()!==expected.follower||m.staticAccountKeys[1].toBase58()!==expected.leader||
  bs58.encode(tx.signatures[0])!==expected.signature)return fail();
 // Wallets can serialize legacy messages and place the two readonly programs
 // in either order. Verify roles by address, never by incidental key order.
 const system=m.staticAccountKeys.findIndex(k=>k.equals(SystemProgram.programId));
 const compute=m.staticAccountKeys.findIndex(k=>k.equals(ComputeBudgetProgram.programId));
 if(system<2||m.staticAccountKeys.length===3&&system!==2||
  m.staticAccountKeys.length===4&&(compute<2||compute===system))return fail();
 const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),m.staticAccountKeys[0].toBuffer()]),format:'der',type:'spki'});
 if(!verify(null,m.serialize(),key,tx.signatures[0]))return fail();
 const budgets=new Set<number>();
 for(const ix of m.compiledInstructions.slice(0,-1)){
  const data=Buffer.from(ix.data),kind=data[0];
  if(m.staticAccountKeys.length!==4||ix.programIdIndex!==compute||ix.accountKeyIndexes.length||budgets.has(kind)||
   !(kind===2&&data.length===5&&data.readUInt32LE(1)>0&&data.readUInt32LE(1)<=1400000||kind===3&&data.length===9))return fail();
  budgets.add(kind);
 }
 if(m.staticAccountKeys.length===4&&!budgets.size)return fail();
 const ix=m.compiledInstructions.at(-1)!,data=Buffer.from(ix.data);
 if(ix.programIdIndex!==system||ix.accountKeyIndexes.length!==2||ix.accountKeyIndexes[0]!==0||ix.accountKeyIndexes[1]!==1||
  data.length!==12||data.readUInt32LE(0)!==2||data.readBigUInt64LE(4)!==BigInt(fundingAmount))return fail();
 const meta=r.meta;
 if(!meta||meta.err!==null||!Number.isSafeInteger(meta.fee)||meta.fee<1||BigInt(meta.fee)>BigInt(CONTROLLED_TEST.fundingFeeCap)||
  !Array.isArray(meta.preBalances)||!Array.isArray(meta.postBalances)||meta.preBalances.length!==m.staticAccountKeys.length||meta.postBalances.length!==m.staticAccountKeys.length||
  [...meta.preBalances,...meta.postBalances].some(v=>!Number.isSafeInteger(v)||v<0)||
  meta.innerInstructions!==null&&(!Array.isArray(meta.innerInstructions)||meta.innerInstructions.length!==0))return fail();
 const amount=BigInt(fundingAmount),fee=BigInt(meta.fee);
 if(newRecipient&&meta.preBalances[1]!==0||BigInt(meta.postBalances[1])-BigInt(meta.preBalances[1])!==amount||
  BigInt(meta.preBalances[0])-BigInt(meta.postBalances[0])!==amount+fee||meta.preBalances.slice(2).some((v,i)=>v!==meta.postBalances[i+2]))return fail();
 return {signature:expected.signature,slot:r.slot,blockTime:r.blockTime,sender:expected.follower,recipient:expected.leader,
  amountLamports:amount.toString(),feeLamports:fee.toString(),totalDebitLamports:(amount+fee).toString()};
}
