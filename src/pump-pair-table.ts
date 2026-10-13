import {AddressLookupTableProgram,ComputeBudgetProgram,PublicKey,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {Buffer} from 'buffer';
import {isMint} from './assets.js';
export type PumpPairTablePlan={version:1;owner:string;quoteMint:string;addresses:string[];table:string;slot:number;blockhash:string;lastValidBlockHeight:number;rentLamports:number;feeLamports:number;unsigned:string};
// A reusable, frozen address table holds public addresses only. This transaction
// never creates a token, grants a signer or moves an existing token balance.
export function pairTableTransaction(input:Pick<PumpPairTablePlan,'owner'|'addresses'|'slot'|'blockhash'>){
 if(!isMint(input.owner)||!PublicKey.isOnCurve(new PublicKey(input.owner).toBytes())||!Number.isSafeInteger(input.slot)||input.slot<1||!isMint(input.blockhash)||input.addresses.length<1||input.addresses.length>24||new Set(input.addresses).size!==input.addresses.length||input.addresses.some(a=>!isMint(a)))throw Error('Invalid pair setup.');
 const owner=new PublicKey(input.owner),[create,table]=AddressLookupTableProgram.createLookupTable({authority:owner,payer:owner,recentSlot:input.slot});
 const instructions=[ComputeBudgetProgram.setComputeUnitLimit({units:100000}),create,AddressLookupTableProgram.extendLookupTable({authority:owner,payer:owner,lookupTable:table,addresses:input.addresses.map(a=>new PublicKey(a))}),AddressLookupTableProgram.freezeLookupTable({authority:owner,lookupTable:table})];
 const tx=new VersionedTransaction(new TransactionMessage({payerKey:owner,recentBlockhash:input.blockhash,instructions}).compileToV0Message());
 if(tx.serialize().length>1232)throw Error('Pair setup exceeds the transaction size limit.');
 return {transaction:tx,table:table.toBase58()};
}
// expectedRentLamports must come from a fresh independent chain rent quote for
// 56 + 32 * address count bytes, never copied from an untrusted plan.
export function inspectPairTable(p:PumpPairTablePlan,owner:string,quoteMint:string,expectedRentLamports:number,encoded=p.unsigned){
 if(!p||p.version!==1||p.owner!==owner||p.quoteMint!==quoteMint||!isMint(quoteMint)||!p.addresses.includes(quoteMint)||![p.lastValidBlockHeight,p.rentLamports,p.feeLamports].every(n=>Number.isSafeInteger(n)&&n>0)||p.feeLamports!==5000||p.rentLamports>5000000||!Number.isSafeInteger(expectedRentLamports)||expectedRentLamports<=0||p.rentLamports!==expectedRentLamports||typeof encoded!=='string'||encoded.length>1644)throw Error('Pair setup does not match the chosen wallet, pair or costs.');
 const expected=pairTableTransaction(p),bytes=Buffer.from(encoded,'base64'),tx=VersionedTransaction.deserialize(bytes);
 if(bytes.toString('base64')!==encoded||!tx.message.serialize().every((b,i)=>expected.transaction.message.serialize()[i]===b)||tx.message.serialize().length!==expected.transaction.message.serialize().length||p.table!==expected.table||tx.message.header.numRequiredSignatures!==1)throw Error('Only the exact frozen pair table may be created.');
 return tx;
}
export async function verifySignedPairTable(p:PumpPairTablePlan,owner:string,quoteMint:string,rentLamports:number,signed:string){
 const tx=inspectPairTable(p,owner,quoteMint,rentLamports,signed);
 const key=await crypto.subtle.importKey('raw',Uint8Array.from(new PublicKey(owner).toBytes()),'Ed25519',false,['verify']);
 if(!await crypto.subtle.verify('Ed25519',key,Uint8Array.from(tx.signatures[0]),Uint8Array.from(tx.message.serialize())))throw Error('Invalid pair setup signature.');
 return tx;
}
