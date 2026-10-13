import {cashCopyHistory} from './cash-copy-history.js';
import canonicalize from 'canonicalize';
import {isMint} from '../src/assets.js';
import {cashCopyRaw,validateCashCopyScope,type CashCopyScope} from '../src/cash-copy-model.js';
import {verifyCashCopyPermission} from './cash-copy-permission.js';
import {cashCopyJournal,type CashCopyCas,type CashCopyEnrollment,type CashCopyDocument} from './cash-copy-journal.js';
import {EnrollmentRefused,privyDid,providerId,type OwnerBinding,type SignerPolicy} from './privy-owner.js';
import type {CashCopyJob} from './cash-copy-service.js';
type Ownership=(binding:Omit<OwnerBinding,'ownerId'>,delegated:boolean,signal:AbortSignal)=>Promise<OwnerBinding>;
const same=(a:unknown,b:unknown)=>canonicalize(a)===canonicalize(b);
/** Mount only on the private signer. A normal ownership binding or Solana
 * copy grant cannot activate this service. Two signatures authorize one exact
 * plan, and BOTH provider wallets must independently delegate its policies. */
export function cashCopyEnrollment(config:{origin:string;cas:CashCopyCas;authenticate:(token:string)=>Promise<string>;solanaOwnership:Ownership;evmOwnership:Ownership;solanaPolicy:SignerPolicy;evmPolicy:SignerPolicy;leaderSource:(leader:string)=>Promise<string>;listPlans?:(wallet:string,userId:string,after:string|null)=>Promise<CashCopyDocument[]>;now?:()=>number}){
 const now=config.now||Date.now,policies={solana:structuredClone(config.solanaPolicy),evm:structuredClone(config.evmPolicy)};
 const assertPolicies=(enrollment:CashCopyEnrollment)=>{if(enrollment.solanaPolicyDigest!==policies.solana.policyDigest||enrollment.evmPolicyDigest!==policies.evm.policyDigest)throw new EnrollmentRefused();};
 async function authenticated(token:string){const id=await config.authenticate(token);if(!privyDid(id))throw new EnrollmentRefused();return id;}
 function owned(binding:OwnerBinding,input:Omit<OwnerBinding,'ownerId'>){if(!binding||!providerId(binding.ownerId)||binding.userId!==input.userId||binding.wallet!==input.wallet||binding.walletId!==input.walletId)throw new EnrollmentRefused();return binding;}
 async function record(planId:string,wallet:string){const row=await config.cas.read(planId,wallet);if(!row?.value.enrollment)throw new EnrollmentRefused();return row.value as typeof row.value&{enrollment:CashCopyEnrollment};}
 return{
  async authorizeOwnerSale(token:string,planId:string,wallet:string,signal:AbortSignal){
   const userId=await authenticated(token),d=await record(planId,wallet);
   if(d.enrollment.solana.userId!==userId||d.enrollment.evm.userId!==userId||d.enrollment.solana.wallet!==wallet||d.enrollment.evm.wallet!==d.grant.scope.recipient)throw new EnrollmentRefused();
   const actual=await config.evmOwnership(d.enrollment.evm,false,signal);
   if(!same(actual,d.enrollment.evm))throw new EnrollmentRefused();
  },
  async history(token:string,planId:string,wallet:string,after:string|null){
   const userId=await authenticated(token),d=await record(planId,wallet);
   if(d.enrollment.solana.userId!==userId||d.enrollment.evm.userId!==userId||d.enrollment.solana.wallet!==wallet)throw new EnrollmentRefused();
   return cashCopyHistory(d,after);
  },
  async list(token:string,wallet:string,after:string|null){
   const userId=await authenticated(token);
   if(!isMint(wallet)||!config.listPlans)throw new EnrollmentRefused();
   const rows=await config.listPlans(wallet,userId,after);
   if(rows.length>11)throw new EnrollmentRefused();
   const at=now(),day=new Date(at).toISOString().slice(0,10);
   const plans=rows.slice(0,10).map(d=>{
    const s=d.grant.scope,e=d.enrollment;validateCashCopyScope(s);
    if(s.sourceWallet!==wallet||!e||e.solana.userId!==userId||e.evm.userId!==userId||e.solana.wallet!==wallet)throw new EnrollmentRefused();
    const used=cashCopyRaw(d.spent[day]||'0'),limit=cashCopyRaw(s.dailyUsdcRaw);
    return {scope:s,leaderSource:e.leaderSource,status:{planId:s.planId,permissionId:s.id,permissionVersion:s.planVersion,state:d.revoked?'paused':at>=s.expiresAt?'expired':'active',expiresAt:s.expiresAt,pending:Object.values(d.jobs).filter(j=>!['complete','stopped'].includes(j.state)).length+Object.values(d.pendingBuys||{}).filter(p=>p.state==='waiting'&&!d.revoked&&at<s.expiresAt&&at-p.event.blockTime<=10000).length+Object.values(d.pendingSales||{}).filter(p=>p.state==='waiting'&&!d.revoked&&p.permissionId===s.id&&at<s.expiresAt&&at-p.event.blockTime<=1800000).length,budget:{day,usedUsdcRaw:String(used),limitUsdcRaw:String(limit),remainingUsdcRaw:String(limit>used?limit-used:0n)}}};
   });
   return {plans,nextCursor:rows.length>10?plans.at(-1)!.scope.planId:null};
  },
  async activate(token:string,scope:CashCopyScope,proof:{solana:string;evm:string},ids:{solana:string;evm:string},signal:AbortSignal){
   signal.throwIfAborted();validateCashCopyScope(scope);
   if(scope.origin!==config.origin||!providerId(ids.solana)||!providerId(ids.evm)||ids.solana===ids.evm)throw new EnrollmentRefused();
   const userId=await authenticated(token);
   // Lost activation responses reuse the accepted grant. A fresh review or
   // provider mutation is not required just to recover its recorded status.
   const existing=await config.cas.read(scope.planId,scope.sourceWallet);
   if(existing){
    const d=existing.value,e=d.enrollment;
    if(!e||e.solana.userId!==userId||e.evm.userId!==userId||e.solana.walletId!==ids.solana||e.evm.walletId!==ids.evm)throw new EnrollmentRefused();
    if(d.grant.scope.id===scope.id){
     if(!same(d.grant.scope,scope)||!same(d.grant.proof,proof))throw new EnrollmentRefused();
     return{planId:scope.planId,permissionId:scope.id,state:d.revoked?'paused' as const:now()>=scope.expiresAt?'expired' as const:'active' as const,expiresAt:scope.expiresAt};
    }
   }
   await verifyCashCopyPermission(scope,proof,now());
   const sol={wallet:scope.sourceWallet,walletId:ids.solana,userId},evm={wallet:scope.recipient,walletId:ids.evm,userId};
   const [s,e,source]=await Promise.all([config.solanaOwnership(sol,true,signal),config.evmOwnership(evm,true,signal),config.leaderSource(scope.leader)]);
   if(!isMint(source))throw new EnrollmentRefused();signal.throwIfAborted();
   const enrollment:CashCopyEnrollment={solana:owned(s,sol),evm:owned(e,evm),solanaPolicyDigest:policies.solana.policyDigest,evmPolicyDigest:policies.evm.policyDigest,leaderSource:source};
   const journal=cashCopyJournal(config.cas,scope.planId,scope.sourceWallet,now);
   await journal.grant(scope,proof,enrollment);
   return{planId:scope.planId,permissionId:scope.id,state:'active' as const,expiresAt:scope.expiresAt};
  },
  async status(token:string,planId:string,wallet:string){
   const userId=await authenticated(token),row=await config.cas.read(planId,wallet);
   if(!row)return{planId,state:'missing',pending:0};
   let d=await record(planId,wallet);
   if(d.enrollment.solana.userId!==userId||d.enrollment.evm.userId!==userId)throw new EnrollmentRefused();
   if([...Object.values(d.pendingBuys||{}),...Object.values(d.pendingSales||{})].some(p=>p.state==='waiting')){
    await cashCopyJournal(config.cas,planId,wallet,now).pruneQueuedWork();d=await record(planId,wallet);
    if(d.enrollment.solana.userId!==userId||d.enrollment.evm.userId!==userId)throw new EnrollmentRefused();
   }
   const observedAt=now(),day=new Date(observedAt).toISOString().slice(0,10),used=cashCopyRaw(d.spent[day]||'0'),limit=cashCopyRaw(d.grant.scope.dailyUsdcRaw);
   // spent includes budget reserved for uncertain jobs. Renewal must never
   // reset it or present the full signed cap as additional available spending.
   const budget={day,usedUsdcRaw:String(used),limitUsdcRaw:String(limit),remainingUsdcRaw:String(limit>used?limit-used:0n)};
   return{planId,permissionId:d.grant.scope.id,permissionVersion:d.grant.scope.planVersion,state:d.revoked?'paused':observedAt>=d.grant.scope.expiresAt?'expired':'active',expiresAt:d.grant.scope.expiresAt,pending:Object.values(d.jobs).filter(j=>!['complete','stopped'].includes(j.state)).length+Object.values(d.pendingBuys||{}).filter(p=>p.state==='waiting').length+Object.values(d.pendingSales||{}).filter(p=>p.state==='waiting').length,budget};
  },
  async revoke(token:string,planId:string,wallet:string){
   const userId=await authenticated(token),d=await record(planId,wallet);
   if(d.enrollment.solana.userId!==userId||d.enrollment.evm.userId!==userId)throw new EnrollmentRefused();
   // Provider metadata/signing outages must not prevent a local stop.
   await cashCopyJournal(config.cas,planId,wallet,now).revoke();return{planId,state:'paused' as const};
  },
  async resolve(job:CashCopyJob,chain:'solana'|'evm',signal:AbortSignal){
   const s=job.scope,initial=await record(s.planId,s.sourceWallet),binding=initial.enrollment[chain];
   const check=async(active:AbortSignal)=>{
    active.throwIfAborted();const d=await record(s.planId,s.sourceWallet);assertPolicies(d.enrollment);
    if(d.revoked||now()>=s.expiresAt||!same(d.grant.scope,s)||!same(d.enrollment,initial.enrollment)||d.grant.scope.origin!==config.origin||binding.wallet!==(chain==='solana'?s.sourceWallet:s.recipient)||binding.userId!==d.enrollment.solana.userId||binding.userId!==d.enrollment.evm.userId)throw new EnrollmentRefused();
    // Revalidate persisted signatures at their acceptance time, not their now
    // expired five-minute review deadline. The active grant expiry still wins.
    await verifyCashCopyPermission(s,d.grant.proof,d.grant.acceptedAt);
    const actual=await (chain==='solana'?config.solanaOwnership:config.evmOwnership)(binding,true,active);
    if(!same(actual,binding))throw new EnrollmentRefused();
    const after=await record(s.planId,s.sourceWallet);if(after.revoked||!same(after.grant,d.grant)||!same(after.enrollment,d.enrollment)||now()>=s.expiresAt)throw new EnrollmentRefused();active.throwIfAborted();
   };
   await check(signal);return{walletId:binding.walletId,check};
  },
 };
}
