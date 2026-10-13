import {parseFomoProfileDetails} from './fomo-profile-details.js';
import type {FomoProfileDetails} from '../src/fomo-profile-details.js';
import {parseFomoTradingProfile,type FomoTradingProfile} from './fomo-trading-profile.js';
import { fomoHandle } from '../src/fomo-identity.js';
import { fomoAvatar } from '../src/fomo-recipient.js';
import type { FomoRecipient } from '../src/fomo-recipient.js';
import type { FomoResolverStore, ResolverPause, ResolverJob } from './fomo-resolver-store.js';
import { decodeFomoDraft, decodeFomoSolDraft, type ResolverCurrency } from './fomo-draft-decoder.js';
import type { Rpc } from './funding.js';
export class ResolverFailure extends Error {
  constructor(readonly reason: ResolverPause | 'missing' | 'retry') { super(reason); }
}
export type DirectProfile = {id:string;handle:string;displayName:string;avatarUrl:string|null;followers:number|null;trades:number|null;details?:FomoProfileDetails;tradingWallets?:FomoTradingProfile};
export type ResolverBrowser = {profile(handle:string):Promise<DirectProfile>;draft(profileId:string):Promise<unknown>};
export function parseDirectProfile(value:unknown,handle:string):DirectProfile {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new ResolverFailure('upstream_changed');
  const p=value as Record<string,unknown>;
  if(p.private===true)throw new ResolverFailure('missing');
  if(typeof p.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(p.id)||typeof p.userHandle!=='string'||fomoHandle(p.userHandle)!==handle)throw new ResolverFailure('upstream_changed');
  const count=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0?n:null;
  let tradingWallets:FomoTradingProfile|null=null;
  try{tradingWallets=parseFomoTradingProfile(p,handle);}catch{/* Malformed optional trading fields cannot replace unsigned transfer proof. */}
  return {...(p.private===false?{details:parseFomoProfileDetails(p,p.publicBalances,p.publicSpotlight,Date.now(),p.publicSnapshot)}:{}),...(tradingWallets?{tradingWallets}:{}),id:p.id,handle,displayName:typeof p.displayName==='string'&&p.displayName.trim()?p.displayName.trim().slice(0,100):handle,avatarUrl:fomoAvatar(p.profilePictureLink),followers:count(p.followers),trades:count(p.numTrades)};
}
export async function resolveFomoJob(job:ResolverJob,store:FomoResolverStore,browser:ResolverBrowser,operator:string,rpc:Rpc,currency:ResolverCurrency='usdc') {
  let profile:DirectProfile|null=null;
  try {
    profile=await browser.profile(job.handle);
    if(profile.handle!==job.handle)throw new ResolverFailure('upstream_changed');
    // Trading attribution has its own conflict fence and private endpoint. A
    // rejected optional mapping must not change recipient draft semantics.
    if(profile.tradingWallets)await store.recordTradingProfile(profile.tradingWallets).catch(()=>{});
    let proof;
    try {
      const draft = await browser.draft(profile.id);
      proof = await (currency === 'sol' ? decodeFomoSolDraft : decodeFomoDraft)(draft, operator, rpc);
    } catch(e) {
      if(e instanceof ResolverFailure)throw e;
      throw new ResolverFailure('upstream_changed');
    }
    const now=Date.now();
    const recipient:FomoRecipient={handle:profile.handle,address:proof.address,source:'fomo-direct',state:'matched',fetchedAt:now,observedAt:now,displayName:profile.displayName,avatarUrl:profile.avatarUrl,retryAfter:null,statsAvailable:false,profileStats:{...(profile.details?{details:profile.details}:{}),followers:profile.followers,trades:profile.trades,observedAt:now}};
    await store.complete(job,profile.id,recipient,proof);
    return {state:'matched' as const};
  } catch(e) {
    const reason=e instanceof ResolverFailure?e.reason:'retry';
    // Retain authentic profile stats while refusing an unresolved fee recipient.
    // Record them separately: a failed finalization must never overwrite a prior match.
    const now=Date.now();
    if(profile)await store.observe(job,profile.id,{
      handle:profile.handle,address:null,source:'fomo-direct',state:'unresolved',fetchedAt:now,observedAt:now,displayName:profile.displayName,avatarUrl:profile.avatarUrl,retryAfter:null,statsAvailable:false,
      profileStats:{...(profile.details?{details:profile.details}:{}),followers:profile.followers,trades:profile.trades,observedAt:now},
    });
    await store.fail(job,reason);
    return {state:'paused' as const,reason};
  } finally {await store.release(job.lease);}
}
