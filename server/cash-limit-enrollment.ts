import canonicalize from 'canonicalize';
import {createPublicKey,verify} from 'node:crypto';
import bs58 from 'bs58';
import {recoverMessageAddress} from 'viem';
import {cashLimitPermissionMessage,validateCashLimitTerms,type CashLimitTerms} from '../src/cash-limit-model.js';
import {privyDid,providerId,type OwnerBinding,type SignerPolicy} from './privy-owner.js';
import type {CashLimitStore,CashLimitRecord} from './cash-limit-store.js';
type Ownership=(b:Omit<OwnerBinding,'ownerId'>,delegated:boolean,signal:AbortSignal)=>Promise<OwnerBinding>;
const same=(a:unknown,b:unknown)=>canonicalize(a)===canonicalize(b);
export async function verifyCashLimitPermission(terms:CashLimitTerms,proof:{solana:string;evm:string},now:number){
 const message=cashLimitPermissionMessage(terms);
 if(now<terms.issuedAt||now>=terms.acceptBy||!/^0x[0-9a-f]{130}$/i.test(proof.evm)||! /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(proof.solana))throw Error('Limit permission expired or is invalid.');
 const sig=bs58.decode(proof.solana),key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),bs58.decode(terms.sourceWallet)]),format:'der',type:'spki'});
 if(sig.length!==64||!verify(null,Buffer.from(message),key,sig)||(await recoverMessageAddress({message,signature:proof.evm as `0x${string}`})).toLowerCase()!==terms.recipient)throw Error('Limit permission signatures do not match.');
}
export function cashLimitEnrollment<R>(c:{origin:string;store:CashLimitStore<R>;authenticate:(token:string)=>Promise<string>;solanaOwnership:Ownership;evmOwnership:Ownership;solanaPolicy:SignerPolicy;evmPolicy:SignerPolicy;enabled:()=>boolean;walletAllowed?:(wallet:string)=>boolean;now?:()=>number}){
 const now=c.now||Date.now;
 const auth=async(token:string)=>{const user=await c.authenticate(token);if(!privyDid(user))throw Error('Verify your wallet.');return user;};
 const view=(r:CashLimitRecord<R>)=>({terms:r.terms,state:r.state,revoked:r.revoked,executionEnabled:c.enabled(),revision:r.revision});
 async function owned(token:string,id:string){const user=await auth(token),r=await c.store.get(id);if(!r||r.grant.solana.userId!==user||r.grant.evm.userId!==user)throw Error('Order not found.');return r;}
 return{
  async activate(token:string,terms:CashLimitTerms,proof:{solana:string;evm:string},ids:{solana:string;evm:string},signal:AbortSignal){
   validateCashLimitTerms(terms);if(c.walletAllowed&&!c.walletAllowed(terms.sourceWallet))throw Error('Limit access is not available for this wallet.');if(terms.origin!==c.origin||!providerId(ids.solana)||!providerId(ids.evm)||ids.solana===ids.evm)throw Error('Invalid limit ownership.');const userId=await auth(token),old=await c.store.get(terms.id);
   if(old){if(old.grant.solana.userId!==userId||old.grant.evm.userId!==userId||old.grant.solana.walletId!==ids.solana||old.grant.evm.walletId!==ids.evm||!same(old.terms,terms)||!same(old.grant.proof,proof))throw Error('Order identity already used.');return view(old);}
   if(!c.enabled())throw Error('Limit execution is paused.');await verifyCashLimitPermission(terms,proof,now());
   const sol={wallet:terms.sourceWallet,walletId:ids.solana,userId},evm={wallet:terms.recipient,walletId:ids.evm,userId};
   const [s,e]=await Promise.all([c.solanaOwnership(sol,true,signal),c.evmOwnership(evm,true,signal)]);signal.throwIfAborted();
   for(const[a,b]of[[s,sol],[e,evm]])if(!providerId((a as OwnerBinding).ownerId)||a.wallet!==b.wallet||a.walletId!==b.walletId||a.userId!==b.userId)throw Error('Limit wallet ownership changed.');
   if(!c.enabled())throw Error('Limit execution is paused.');const acceptedAt=now();await verifyCashLimitPermission(terms,proof,acceptedAt);
   return view(await c.store.create(terms,{proof,acceptedAt,solana:s,evm:e,solanaPolicyDigest:c.solanaPolicy.policyDigest,evmPolicyDigest:c.evmPolicy.policyDigest}));
  },
  async status(token:string,id:string){return view(await owned(token,id));},
  async stop(token:string,id:string){const r=await owned(token,id);await c.store.stop(id,r.grant.solana.userId);return view((await c.store.get(id))!);},
  async list(token:string,wallet:string){const userId=await auth(token);return{orders:(await c.store.list(wallet,userId)).map(view)};},
  async resolve(terms:CashLimitTerms,chain:'solana'|'evm',signal:AbortSignal){
   const check=async()=>{signal.throwIfAborted();const r=await c.store.get(terms.id);if(c.walletAllowed&&!c.walletAllowed(terms.sourceWallet)||!r||r.revoked||!c.enabled()||now()>=terms.expiresAt||!same(r.terms,terms)||r.grant.solanaPolicyDigest!==c.solanaPolicy.policyDigest||r.grant.evmPolicyDigest!==c.evmPolicy.policyDigest)throw Error('Limit permission stopped.');await verifyCashLimitPermission(terms,r.grant.proof,r.grant.acceptedAt);const b=r.grant[chain];if(b.userId!==r.grant.solana.userId||b.userId!==r.grant.evm.userId||b.wallet!==(chain==='solana'?terms.sourceWallet:terms.recipient))throw Error('Limit owner changed.');const current=await(chain==='solana'?c.solanaOwnership:c.evmOwnership)(b,true,signal);if(!same(current,b))throw Error('Limit wallet delegation changed.');signal.throwIfAborted();const latest=await c.store.get(terms.id);if(c.walletAllowed&&!c.walletAllowed(terms.sourceWallet)||!latest||latest.revoked||!c.enabled()||now()>=terms.expiresAt||!same(latest.terms,terms)||!same(latest.grant,r.grant))throw Error('Limit permission stopped during verification.');return b;};
   const binding=await check();return{...binding,check};
  },
 };
}
