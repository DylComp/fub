import type {PublishedLaunch} from '../src/launch-publication.js';
import type {LaunchExecutionChain} from './launch-execution-chain.js';
import type {launchTableStore,LaunchTableAttempt} from './pump-pair-table-journal.js';
import type {launchTableService} from './pump-pair-table-recovery.js';
export class LaunchPairSetupRequired extends Error{
 constructor(public readonly setup:LaunchTableAttempt){super('This pair requires a launch address setup.');}
}
export class LaunchPairSetupPending extends Error{
 constructor(public readonly state:LaunchTableAttempt['state']){super('Preparing this pair for launch.');}
}
// Called only after authenticating the owner and freshly confirming the Fomo
// recipient. One publication retains one mint and one table across retries.
export async function pairLaunchTables(input:{publication:PublishedLaunch;mint:string;treasury:string;tables:string[];store:ReturnType<typeof launchTableStore>;service:ReturnType<typeof launchTableService>;chain:LaunchExecutionChain;sponsor?:{payer:string;submit:(a:LaunchTableAttempt)=>Promise<LaunchTableAttempt|null>}}){
 const {publication:p,mint,treasury,tables,store,service,chain}=input;
 let a=await store.forPublication(p.id,p.owner);
 if(a&&a.intent.mint!==mint)throw Error('Recover this publication’s original mint before creating a different table.');
 if(!a){
  if(!input.sponsor)throw Error('Automatic pair setup is not configured.');
  const plan=await chain.prepareTable(p,mint,treasury,tables,input.sponsor.payer);a=await store.save({publicationId:p.id,owner:p.owner,mint,quoteMint:p.draft.quoteMint!},plan);
 }
 if(a.state==='prepared')a=await service.refreshUnsigned(a,()=>chain.prepareTable(p,mint,treasury,tables,input.sponsor?.payer||a!.plan.owner));
 if(input.sponsor&&a.plan.owner===input.sponsor.payer&&(a.state==='prepared'||a.state==='pending')){const next=await input.sponsor.submit(a);if(!next)throw Error("Pair setup record unavailable. Retry this launch.");a=next;}
 if(a.state==='pending'||a.state==='expired_unresolved'){const next=await service.recover(a.id,p.owner);if(!next)throw Error("Pair setup record unavailable. Retry this launch.");a=next;}
 if(a.state==='confirmed'){
  if(!a.receipt?.success||a.receipt.table!==a.plan.table||a.intent.quoteMint!==p.draft.quoteMint)throw Error('Pair setup does not match this launch.');
  return [...tables,a.plan.table];
 }
 // Existing customer-funded packets may still be checked and recovered, but
 // the public launch path never asks for a new infrastructure signature.
 throw new LaunchPairSetupPending(a.state);
}
