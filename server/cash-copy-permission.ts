import {createPublicKey,verify} from 'node:crypto';
import bs58 from 'bs58';
import {recoverMessageAddress} from 'viem';
import {cashCopyPermissionMessage,type CashCopyScope} from '../src/cash-copy-model.js';
// Both signatures authorize exactly the same immutable scope. Ownership
// challenges and old Solana-only copy grants are never interchangeable with it.
// Consuming the nonce and verifying live provider delegation remain mandatory
// in the durable signer service before any automatic signature is requested.
export async function verifyCashCopyPermission(scope:CashCopyScope,proof:{solana:string;evm:string},now=Date.now()){
 const message=cashCopyPermissionMessage(scope);
 if(now<scope.issuedAt||now>=scope.acceptBy||!/^0x[0-9a-f]{130}$/i.test(proof.evm)||! /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(proof.solana))throw Error('Copy permission expired or is invalid.');
 const sig=bs58.decode(proof.solana),key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),bs58.decode(scope.sourceWallet)]),format:'der',type:'spki'});
 if(sig.length!==64||!verify(null,Buffer.from(message),key,sig)||(await recoverMessageAddress({message,signature:proof.evm as `0x${string}`})).toLowerCase()!==scope.recipient)throw Error('Cross-chain copy permission was not verified.');
 return {scope:structuredClone(scope),proof:structuredClone(proof),acceptedAt:now};
}
