import type {PublishedLaunch} from '../src/launch-publication.js';
import type {LaunchExecutionChain} from './launch-execution-chain.js';
import type {LaunchExecutionStore} from './launch-execution-store.js';
export class LaunchPublicationMissing extends Error { constructor(){super('Published launch not found for this wallet.');} }
// Internal preparation boundary. The HTTP caller must authenticate owner before
// invoking this. No configured treasury fallback and no silent mint replacement.
export function launchPreparation(options:{
 publication:(id:string,owner:string)=>Promise<PublishedLaunch|null>;
 recipient:(handle:string)=>Promise<{address:string;handle:string}>;
 store:LaunchExecutionStore;chain:LaunchExecutionChain;buybackWallet:string;lookupTables:string[];
 pairTables?:(publication:PublishedLaunch,mint:string)=>Promise<string[]>;
}){
 return async(owner:string,publicationId:string,mint:string,replaceId?:string)=>{
  const publication=await options.publication(publicationId,owner);
  if(!publication||publication.owner!==owner||publication.id!==publicationId)throw new LaunchPublicationMissing();
  const previous=await options.store.forPublication(publicationId,owner);
  if(previous&&!replaceId){
   if(previous.plan.mint!==mint)throw Error('An existing launch uses another mint. Recover or explicitly refresh it first.');
   return previous;
  }
  if(replaceId&&(!previous||previous.id!==replaceId||!((previous.state==='prepared'&&!previous.signed&&!previous.signature)||(previous.state==='expired_unresolved'&&previous.nonlandingProof))))throw Error('Only the current unsigned launch can be refreshed.');
  const expiry=replaceId&&previous?await options.chain.expiredUnsigned(previous.plan):null;
  const recipient=await options.recipient(publication.draft.handle);
  if(recipient.handle!==publication.draft.handle||recipient.address!==publication.recipient)throw Error('The Fomo recipient changed. Confirm and publish the updated draft.');
  const plan=await options.chain.prepare(publication,mint,options.buybackWallet,options.pairTables?await options.pairTables(publication,mint):options.lookupTables,expiry?.slot);
  return expiry&&replaceId?options.store.refresh(replaceId,plan,expiry):options.store.save(plan);
 };
}
