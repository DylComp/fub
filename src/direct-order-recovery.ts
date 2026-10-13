import bs58 from 'bs58';
import {directExitMessage,validateExitTerms,type DirectExitTerms} from './direct-exits';
import {validEnrollmentConfig,type EnrollmentConfig,type EnrollmentIdentity} from './enrollment-client';

export type PendingDirectOrder={version:1;origin:string;identity:EnrollmentIdentity;policy:EnrollmentConfig;terms:DirectExitTerms;signature:string};
type StoragePort=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
const keys=(v:object)=>Object.keys(v).sort().join(',');
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const ownerFields=(i:EnrollmentIdentity)=>[i.wallet,i.walletId,i.userId];
const policyFields=(c:EnrollmentConfig)=>[c.serviceOrigin,c.appId,c.signerId,c.policyId,c.policyDigest];
export const sameDirectOrderPolicy=(a:EnrollmentConfig,b:EnrollmentConfig)=>same(policyFields(a),policyFields(b));
// One unresolved approval per owner/site/app. Keeping the policy in this slot,
// rather than hiding it under a new key after migration, prevents a replacement
// order while an older policy's activation outcome is still unknown.
export function directOrderRecoveryKey(c:EnrollmentConfig,i:EnrollmentIdentity,origin:string){
 if(!validEnrollmentConfig(c,origin)||new URL(origin).origin!==origin||!origin.startsWith('https://')||ownerFields(i).some(x=>typeof x!=='string'||!x.length||x.length>256))throw Error('Invalid order recovery identity.');
 return 'fub.direct-order.pending.v1:'+encodeURIComponent(JSON.stringify([origin,c.appId,...ownerFields(i)]));
}
export async function validatePendingDirectOrder(value:unknown,c:EnrollmentConfig,i:EnrollmentIdentity,origin:string,now=Date.now()):Promise<PendingDirectOrder>{
 const p=value as PendingDirectOrder;
 if(!p||keys(p)!=='identity,origin,policy,signature,terms,version'||p.version!==1||p.origin!==origin||!p.identity||keys(p.identity)!=='userId,wallet,walletId'||!same(ownerFields(p.identity),ownerFields(i))||!p.policy||keys(p.policy)!=='appId,policyDigest,policyId,serviceOrigin,signerId'||!validEnrollmentConfig(p.policy,origin)||p.policy.appId!==c.appId||p.policy.serviceOrigin!==c.serviceOrigin)throw Error('Saved order approval belongs to another wallet, site or service.');
 validateExitTerms(p.terms);
 if(p.terms.wallet!==i.wallet||p.terms.origin!==origin||p.terms.issuedAt>now+5000||typeof p.signature!=='string'||p.signature.length>88)throw Error('Saved order approval changed.');
 const signature=bs58.decode(p.signature),wallet=bs58.decode(i.wallet);
 if(signature.length!==64||wallet.length!==32)throw Error('Saved order signature is invalid.');
 const key=await crypto.subtle.importKey('raw',Uint8Array.from(wallet),'Ed25519',false,['verify']);
 if(!await crypto.subtle.verify('Ed25519',key,Uint8Array.from(signature),new TextEncoder().encode(directExitMessage(p.terms))))throw Error('Saved order signature is invalid.');
 return structuredClone(p);
}
export function directOrderRecovery(storage:StoragePort,c:EnrollmentConfig,i:EnrollmentIdentity,origin:string){
 const key=directOrderRecoveryKey(c,i,origin);
 const raw=()=>{const value=storage.getItem(key);if(value!==null&&value.length>16384)throw Error('Saved order recovery is too large.');return value;};
 const exclusive=<T>(work:()=>Promise<T>):Promise<T>=>{
  if(typeof navigator!=='undefined'&&navigator.locks)return navigator.locks.request(key,work);
  if(typeof window!=='undefined')return Promise.reject(Error('This browser cannot safely retain order approvals. Use a browser with secure storage locks.'));
  return work();
 };
 const read=async()=>{const value=raw();return value===null?null:validatePendingDirectOrder(JSON.parse(value),c,i,origin);};
 return {
  read,
  async writable(){return exclusive(async()=>{
   if(await read())throw Error('An existing approval still needs confirmation. Check its status before creating another order.');
   const probe=key+':storage-check';storage.setItem(probe,'1');if(storage.getItem(probe)!=='1')throw Error('Browser storage could not retain order recovery.');storage.removeItem(probe);
  });},
  async save(terms:DirectExitTerms,signature:string){return exclusive(async()=>{
   const p=await validatePendingDirectOrder({version:1,origin,identity:{...i},policy:{...c},terms,signature},c,i,origin),old=await read();
   if(old&&(directExitMessage(old.terms)!==directExitMessage(p.terms)||old.signature!==signature||!sameDirectOrderPolicy(old.policy,c)))throw Error('Another order approval needs confirmation first.');
   const encoded=JSON.stringify(p);if(encoded.length>16384)throw Error('Order recovery is too large.');storage.setItem(key,encoded);
   if(raw()!==encoded)throw Error('Browser storage could not retain this signed approval. Nothing was submitted.');
   return p;
  });},
  async clear(expected:PendingDirectOrder){return exclusive(async()=>{
   const old=await read();if(!old)return;
   if(directExitMessage(old.terms)!==directExitMessage(expected.terms)||old.signature!==expected.signature||!sameDirectOrderPolicy(old.policy,expected.policy))throw Error('Saved order recovery changed.');
   storage.removeItem(key);if(raw()!==null)throw Error('Could not finish saved order recovery.');
  });},
 };
}
