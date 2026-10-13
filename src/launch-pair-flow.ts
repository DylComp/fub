import canonicalize from 'canonicalize';
import {launchHash,type PublishedLaunch} from './launch-publication';
import {inspectPairTable,type PumpPairTablePlan} from './pump-pair-table';
import type {WalletConnection} from './useWallet';
type PublicSetup={id:string;intent:{publicationId:string;owner:string;mint:string;quoteMint:string};plan:PumpPairTablePlan;state:string;signature:string|null;receipt?:{success:boolean;table:string}|null};
export async function completeLaunchPairSetup(input:{setup:unknown;publication:PublishedLaunch;mint:string;connection:WalletConnection;post:(path:string,body:object)=>Promise<any>;pause:(ms:number)=>Promise<void>;progress:(text:string)=>void;signal:AbortSignal;packet:{current:{id:string;bytes:string}|null}}){
 const {publication:p}=input;
 async function check(raw:unknown,id?:string){
  const a=raw as PublicSetup;
  if(!a||!a.plan||a.intent?.publicationId!==p.id||a.intent.owner!==p.owner||a.intent.mint!==input.mint||a.intent.quoteMint!==p.draft.quoteMint||id&&id!==a.id||!['prepared','pending','confirmed','failed','expired_unresolved'].includes(a.state)||a.id!==await launchHash(canonicalize({intent:a.intent,plan:a.plan})!))throw Error('Pair setup does not match your coin.');
  inspectPairTable(a.plan,p.owner,p.draft.quoteMint!,a.plan.rentLamports);input.signal.throwIfAborted();return a;
 }
 let a=await check(input.setup);const id=a.id;
 if(a.state==='prepared'){
  if(input.packet.current?.id!==id){
   const r=await fetch(`/api/launch?view=pair-rent&count=${a.plan.addresses.length}`,{signal:AbortSignal.any([input.signal,AbortSignal.timeout(12000)])});
   const rent=await r.json();if(!r.ok||rent.count!==a.plan.addresses.length)throw Error('Pair setup costs could not be verified.');
   inspectPairTable(a.plan,p.owner,p.draft.quoteMint!,rent.rentLamports);
   input.progress(`Approve pair setup: ${(a.plan.rentLamports+a.plan.feeLamports)/1e9} SOL. Your launch approval follows.`);
   const bytes=await input.connection.signPairTable(a.plan,p.draft.quoteMint!,rent.rentLamports);
   input.signal.throwIfAborted();input.packet.current={id,bytes};
  }
  input.progress('Confirming pair setup…');
  a=await check((await input.post('/api/launch-execute',{action:'submit-pair-table',id,wallet:p.owner,signed:input.packet.current.bytes})).setup,id);
 }
 for(let n=0;n<24;n++){
  if(a.state==='confirmed'){
   if(!a.receipt?.success||a.receipt.table!==a.plan.table)throw Error('Pair setup confirmation is incomplete.');return;
  }
  if(a.state==='failed')throw Error('Pair setup failed on chain. Check its receipt before retrying.');
  if(a.state==='expired_unresolved')throw Error('Pair setup is awaiting a verified result. Resume checks the saved transaction without another setup payment.');
  await input.pause(4000);
  a=await check((await input.post('/api/launch-execute',{action:'check-pair-table',id,wallet:p.owner})).setup,id);
 }
 throw Error('Pair setup confirmation is still pending. Resume to check the same transaction.');
}
