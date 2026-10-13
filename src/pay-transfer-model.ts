import { address, getCompiledTransactionMessageEncoder, getTransactionEncoder, getTransactionDecoder, type Transaction, isOffCurveAddress } from '@solana/kit';
import bs58 from 'bs58';
import { associated, ATA_PROGRAM, fromBase64, toBase64 } from './transaction-review.js';
import { USDC, TOKEN_PROGRAM } from './funding-model.js';
import { isMint } from './assets.js';
import { validTransferTerms, paymentRawAmount, paymentReference, type TransferTerms } from './pay-verification.js';
export type PayTransferReview = {version:1; sender:string; terms:TransferTerms; reference:string; unsigned:string; blockhash:string; lastValidBlockHeight:number; slot:number; preparedAt:number; feeLamports:string; rentLamports:string};
export const PAY_TRANSFER_FEE = '5250';
const SYSTEM='11111111111111111111111111111111', COMPUTE='ComputeBudget111111111111111111111111111111';
export async function payTransferTransaction(sender:string,terms:TransferTerms,blockhash:string){
 if(!validTransferTerms(terms)||!isMint(sender)||!isMint(blockhash)||sender===terms.recipient||isOffCurveAddress(address(sender))||isOffCurveAddress(address(terms.recipient)))throw Error('Choose a different receiving wallet with valid payment details.');
 const source=await associated(sender,USDC),destination=await associated(terms.recipient,USDC),reference=await paymentReference(terms);
 const accounts=[sender,source,destination,terms.recipient,USDC,TOKEN_PROGRAM,ATA_PROGRAM,SYSTEM,COMPUTE,reference];
 if(new Set(accounts).size!==accounts.length)throw Error('Payment accounts overlap.');
 const limit=new Uint8Array(5);limit[0]=2;new DataView(limit.buffer).setUint32(1,50000,true);
 const price=new Uint8Array(9);price[0]=3;new DataView(price.buffer).setBigUint64(1,5000n,true);
 const transfer=new Uint8Array(10);transfer[0]=12;new DataView(transfer.buffer).setBigUint64(1,BigInt(paymentRawAmount(terms)),true);transfer[9]=6;
 const messageBytes=getCompiledTransactionMessageEncoder().encode({version:0,header:{numSignerAccounts:1,numReadonlySignerAccounts:0,numReadonlyNonSignerAccounts:7},staticAccounts:accounts.map(address),lifetimeToken:blockhash,instructions:[{programAddressIndex:8,accountIndices:[],data:limit},{programAddressIndex:8,accountIndices:[],data:price},{programAddressIndex:6,accountIndices:[0,2,3,4,7,5],data:new Uint8Array([1])},{programAddressIndex:5,accountIndices:[1,4,2,0,9],data:transfer}],addressTableLookups:[]});
 return toBase64(new Uint8Array(getTransactionEncoder().encode({messageBytes,signatures:{[sender]:null}} as Transaction)));
}
export async function inspectPayTransfer(review:PayTransferReview,sender:string,terms:TransferTerms,signed?:string,fresh=true){
 if(!review||review.version!==1||review.sender!==sender||!validTransferTerms(review.terms)||Object.keys(terms).sort().join()!==Object.keys(review.terms).sort().join()||Object.keys(terms).some(k=>(terms as unknown as Record<string,unknown>)[k]!==(review.terms as unknown as Record<string,unknown>)[k])||review.reference!==await paymentReference(terms)||![review.slot,review.lastValidBlockHeight,review.preparedAt].every(n=>Number.isSafeInteger(n)&&n>0)||review.feeLamports!==PAY_TRANSFER_FEE||!/^(0|[1-9]\d{0,6})$/.test(review.rentLamports)||BigInt(review.rentLamports)>3000000n)throw Error('Payment review does not match this share.');
 if(fresh&&(Date.now()-review.preparedAt>60000||review.preparedAt>Date.now()+5000))throw Error('Refresh the payment review before signing.');
 const unsigned=await payTransferTransaction(sender,terms,review.blockhash);if(unsigned!==review.unsigned)throw Error('Payment instructions changed.');
 if(!signed)return null;
 const before=getTransactionDecoder().decode(fromBase64(unsigned)),tx=getTransactionDecoder().decode(fromBase64(signed));
 if(toBase64(new Uint8Array(getTransactionEncoder().encode(tx)))!==signed||toBase64(new Uint8Array(before.messageBytes))!==toBase64(new Uint8Array(tx.messageBytes))||Object.keys(tx.signatures).length!==1)throw Error('Wallet changed the payment transaction.');
 const sig=tx.signatures[address(sender)],key=await crypto.subtle.importKey('raw',Uint8Array.from(bs58.decode(sender)),'Ed25519',false,['verify']);
 if(!sig||!await crypto.subtle.verify('Ed25519',key,Uint8Array.from(sig),Uint8Array.from(tx.messageBytes)))throw Error('Payment signature is invalid.');
 return bs58.encode(sig);
}
