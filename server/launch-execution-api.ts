import {LaunchQuoteBalanceError,LaunchNotExpiredError} from './launch-errors.js';
import {configuredPairSponsor} from './launch-pair-sponsor.js';
import {SOL_PAIR_MINT} from '../src/launch-pairs.js';
import {LaunchPairSetupRequired,LaunchPairSetupPending,pairLaunchTables} from './launch-pair-preparation.js';
import {launchTableStore} from './pump-pair-table-journal.js';
import {launchTableChain,launchTableService} from './pump-pair-table-recovery.js';
import {verifyLaunchSession} from './launch-session.js';
import {isFubWebOrigin} from './fub-web-origin.js';
import {blockRecoveryRpc} from './copy-block-recovery.js';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {createHash,createPublicKey,verify} from 'node:crypto';
import bs58 from 'bs58';
import {Connection} from '@solana/web3.js';
import {isMint} from '../src/assets.js';
import {launchExecutionMessage} from '../src/launch-execution-request.js';
import type {LaunchExecutionAuthorization} from '../src/launch-execution-request.js';
import {launchExecutionStore} from './launch-execution-store.js';
import type {LaunchExecutionStore} from './launch-execution-store.js';
import {launchExecutionChain} from './launch-execution-chain.js';
import {launchExecutionService} from './launch-execution-service.js';
import {launchPreparation,LaunchPublicationMissing} from './launch-execution-prepare.js';
import {launchPublicationStore} from './launch-publication-store.js';
import {freshLaunchRecipient} from './launch-api.js';
import {launchExecutionConfig,launchWithinBudget} from './launch-execution-config.js';
import type {LaunchExecution} from './launch-execution-model.js';
import {verifyLaunchSigned} from './launch-execution-model.js';
const shape=(v:unknown,keys:string)=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys;
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const publicTable=(a:import('./pump-pair-table-journal.js').LaunchTableAttempt|null)=>{if(!a)return null;const {signed,...safe}=a;return safe;};
const publicAttempt=(a:LaunchExecution|null)=>a?{id:a.id,plan:a.plan,state:a.state,signature:a.signature,expiryVerified:!!a.nonlandingProof}:null;
export function launchExecutionHandler(options:{
 store?:()=>LaunchExecutionStore;config?:typeof launchExecutionConfig;
 prepare?:(owner:string,publication:string,mint:string,replaceId?:string)=>Promise<LaunchExecution>;
 submit?:(id:string,owner:string,signed:string)=>Promise<LaunchExecution|null>;
}={}){
 const storage=options.store||(()=>launchExecutionStore(process.env.DATABASE_URL!));let pending=0,calls=0,start=0;
 return async(req:IncomingMessage,res:ServerResponse)=>{
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');const send=(status:number,data:unknown)=>{res.statusCode=status;res.end(JSON.stringify(data));};
  if(req.method!=='POST')return send(405,{message:'POST required.'});
  if(!isFubWebOrigin(req.headers.origin)||req.headers['x-fomo-request']!=='1'||req.headers['content-type']?.split(';')[0]!=='application/json'||(req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin'))return send(403,{message:'Open the launch from Fub.'});
  if(new URL(req.url||'/','https://localhost').search)return send(400,{message:'Invalid launch request.'});
  if(Date.now()-start>=60000){start=Date.now();calls=0;}if(calls>=20||pending>=2)return send(429,{message:'Launch requests are busy. Try again shortly.'});pending++;calls++;
  let setupRequest=false;
  try{
   let raw:any,a:LaunchExecutionAuthorization|undefined;
   try{
    let body=(req as IncomingMessage&{body?:unknown}).body;
    if(body===undefined){let size=0;const chunks:Buffer[]=[],timer=setTimeout(()=>req.destroy(),5000);try{for await(const c of req){const b=Buffer.from(c);size+=b.length;if(size>8192)throw Error();chunks.push(b);}body=Buffer.concat(chunks).toString('utf8');}finally{clearTimeout(timer);}}
    const text=typeof body==='string'?body:JSON.stringify(body);if(Buffer.byteLength(text)>8192)throw Error();raw=JSON.parse(text);setupRequest=['prepare-buyback-setup','submit-buyback-setup','prepare-graduated-setup','submit-graduated-setup'].includes(raw.action);
    if(['prepare-buyback-setup','prepare-graduated-setup'].includes(raw.action)){
     if(!shape(raw,'action'))throw Error();
    }else if(['submit-buyback-setup','submit-graduated-setup'].includes(raw.action)){
     if(!shape(raw,'action,review,signed')||!shape(raw.review,'ata,debit,fee,lastValidBlockHeight,preparedAt,unsigned,volume')||typeof raw.signed!=='string'||raw.signed.length>1644)throw Error();
    }else if(raw.action==='prepare-table-setup'){
     if(!shape(raw,'action'))throw Error();
    }else if(raw.action==='submit-pair-table'){
     if(!shape(raw,'action,id,signed,wallet')||!/^[a-f0-9]{64}$/.test(raw.id)||!isMint(raw.wallet)||typeof raw.signed!=='string'||raw.signed.length>1644)throw Error();
    }else if(raw.action==='check-pair-table'){
     if(!shape(raw,'action,id,wallet')||!/^[a-f0-9]{64}$/.test(raw.id)||!isMint(raw.wallet)||!verifyLaunchSession(req,raw.wallet,'session'))throw Error();
    }else if(raw.action==='submit'){
     if(!shape(raw,'action,id,signed,wallet')||!/^[a-f0-9]{64}$/.test(raw.id)||!isMint(raw.wallet)||typeof raw.signed!=='string'||raw.signed.length>1644)throw Error();
    }else{
     if(!shape(raw,'authorization,payload,signature'))throw Error();a=raw.authorization;const message=launchExecutionMessage(a!);
     const expected=a!.action==='load'?'publicationId':a!.action==='refresh'?'mint,publicationId,replaceId':'mint,publicationId';
     if(!shape(raw.payload,expected)||!/^[a-f0-9]{64}$/.test(raw.payload.publicationId)||(a!.action!=='load'&&!isMint(raw.payload.mint))||(a!.action==='refresh'&&!/^[a-f0-9]{64}$/.test(raw.payload.replaceId))||a!.payloadHash!==hash(JSON.stringify(raw.payload))||typeof raw.signature!=='string'||raw.signature.length>88)throw Error();
     if(!verifyLaunchSession(req,a!.wallet,raw.signature)){
     const signature=bs58.decode(raw.signature),key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(bs58.decode(a!.wallet))]),format:'der',type:'spki'});
     if(signature.length!==64||bs58.encode(signature)!==raw.signature||!verify(null,Buffer.from(message),key,signature))throw Error();
     }
    }
   }catch{return send(400,{message:'The launch request did not pass its signature or field checks.'});}
   if(raw.action==='prepare-table-setup')return send(409,{message:'Launch infrastructure is already complete. No further setup transaction is needed.'});
   if(raw.action==='prepare-buyback-setup'){
    const {prepareBuybackSetup}=await import('./buyback-setup.js');
    return send(200,await prepareBuybackSetup());
   }
   if(raw.action==='submit-buyback-setup'){
    const {submitBuybackSetup}=await import('./buyback-setup.js');
    return send(200,await submitBuybackSetup(raw.review,raw.signed));
   }
   if(raw.action==='prepare-graduated-setup'){
    const {prepareGraduatedSetup}=await import('./graduated-setup.js');
    return send(200,await prepareGraduatedSetup());
   }
   if(raw.action==='submit-graduated-setup'){
    const {submitGraduatedSetup}=await import('./graduated-setup.js');
    return send(200,await submitGraduatedSetup(raw.review,raw.signed));
   }
   if(['submit-pair-table','check-pair-table'].includes(raw.action)){
    const tables=launchTableStore(process.env.DATABASE_URL!),prior=await tables.get(raw.id,raw.wallet);
    if(!prior)return send(404,{message:'Pair setup not found for this wallet.'});
    const config=(options.config||launchExecutionConfig)(process.env,{wallet:raw.wallet,publicationId:prior.intent.publicationId,quoteMint:prior.intent.quoteMint});
    const service=launchTableService(tables,launchTableChain(new Connection(process.env.SOLANA_RPC_URL!,'confirmed'),()=>blockRecoveryRpc()),()=>config.enabled&&!!config.customPairsEnabled);
    const result=raw.action==='submit-pair-table'?await service.submit(raw.id,raw.wallet,raw.signed):await service.recover(raw.id,raw.wallet);
    return send(200,{setup:publicTable(result)});
   }
   const store=storage();
   if(raw.action==='submit'){
    const previous=await store.get(raw.id,raw.wallet);if(!previous)return send(404,{message:'Launch not found for this wallet.'});
    try{verifyLaunchSigned(previous.plan,raw.signed);}catch{return send(400,{message:'The transaction does not have both signatures on the exact reviewed launch.'});}
    // Persist first even if sending is paused or RPC is unavailable. A wallet
    // might have sent these same bytes independently; retain recovery evidence.
    const bound=await store.bind(raw.id,raw.wallet,raw.signed);
    const context={wallet:previous.plan.publication.owner,publicationId:previous.plan.publication.id,quoteMint:previous.plan.publication.draft.quoteMint};
    const config=(options.config||launchExecutionConfig)(process.env,context);
    if(!launchWithinBudget(config,previous.plan))return send(200,{launch:publicAttempt(bound),sendingPaused:true});
    const submit=options.submit||((id,owner,signed)=>launchExecutionService(store,launchExecutionChain(new Connection(process.env.SOLANA_RPC_URL!,'confirmed'),()=>blockRecoveryRpc()),()=>launchWithinBudget(launchExecutionConfig(process.env,context),previous.plan)).submit(id,owner,signed));
    return send(200,{launch:publicAttempt(await submit(raw.id,raw.wallet,raw.signed)),sendingPaused:false});
   }
   const owner=a!.wallet,publicationId=raw.payload.publicationId;
   if(a!.action==='load')return send(200,{launch:publicAttempt(await store.forPublication(publicationId,owner))});
   let config=(options.config||launchExecutionConfig)(process.env,{wallet:owner,publicationId});
   if(!config.enabled)return send(409,{message:config.reasons.join(' '),blocked:true});
   if(a!.action==='prepare'){
    const previous=await store.forPublication(publicationId,owner);
    if(previous){config=(options.config||launchExecutionConfig)(process.env,{wallet:owner,publicationId,quoteMint:previous.plan.publication.draft.quoteMint});if(!launchWithinBudget(config,previous.plan))return send(409,{message:'This launch exceeds its supervised spending limit or uses another treasury.',blocked:true});return send(200,{launch:publicAttempt(previous),existing:true});}
   }
   const prepare=options.prepare||await (async()=>{
   const publication=await launchPublicationStore(process.env.DATABASE_URL!).get(publicationId,owner);
   if(!publication||publication.owner!==owner||publication.id!==publicationId)throw new LaunchPublicationMissing();
   const context={wallet:owner,publicationId,quoteMint:publication.draft.quoteMint};
   config=(options.config||launchExecutionConfig)(process.env,context);
   const custom=!!config.customPairsEnabled,connection=new Connection(process.env.SOLANA_RPC_URL!,'confirmed');
   if(publication.draft.quoteMint&&publication.draft.quoteMint!==SOL_PAIR_MINT&&!custom)throw Error('Pair launch is not enabled for this owner.');
   const chain=launchExecutionChain(connection,()=>blockRecoveryRpc(),{customPairs:custom});
   return launchPreparation({publication:async(id,wallet)=>id===publication.id&&wallet===publication.owner?publication:null,recipient:freshLaunchRecipient,store,chain,buybackWallet:config.buybackWallet,lookupTables:config.lookupTables,
    ...(custom?{pairTables:async(publication,mint)=>{
     if(!publication.draft.quoteMint||publication.draft.quoteMint===SOL_PAIR_MINT)return config.lookupTables;
     const tables=launchTableStore(process.env.DATABASE_URL!);
     const service=launchTableService(tables,launchTableChain(connection,()=>blockRecoveryRpc()),()=>{const current=launchExecutionConfig(process.env,context);return current.enabled&&!!current.customPairsEnabled;});
     const sponsor=configuredPairSponsor(process.env,connection,tables,service,AbortSignal.timeout(45000));
     return pairLaunchTables({publication,mint,treasury:config.buybackWallet,tables:config.lookupTables,store:tables,service,chain,sponsor});
    }}:{})});})();
   const attempt=await prepare(owner,publicationId,raw.payload.mint,raw.payload.replaceId);
   if(attempt.plan.publication.owner!==owner||attempt.plan.publication.id!==publicationId)throw Error('Launch owner mismatch');
   config=(options.config||launchExecutionConfig)(process.env,{wallet:owner,publicationId,quoteMint:attempt.plan.publication.draft.quoteMint});
   if(!launchWithinBudget(config,attempt.plan))return send(409,{message:'This launch exceeds its supervised spending limit or uses another treasury.',blocked:true});
   return send(200,{launch:publicAttempt(attempt),existing:false});
  }catch(error){if(error instanceof LaunchNotExpiredError)return send(409,{code:error.code,message:error.message});if(error instanceof LaunchQuoteBalanceError)return send(422,{code:error.code,message:error.message,balance:{mint:error.mint,requiredRaw:error.requiredRaw,availableRaw:error.availableRaw,decimals:error.decimals}});if(error instanceof LaunchPairSetupPending)return send(200,{preparingPair:true,state:error.state});if(error instanceof LaunchPairSetupRequired)return send(200,{setup:publicTable(error.setup)});if(error instanceof LaunchPublicationMissing)return send(404,{message:'This saved draft was not found for your wallet. Save your coin details before launching.'});return send(503,{message:setupRequest?'Treasury setup could not be confirmed. Use Check confirmation to retry the saved transaction. Do not sign a replacement while its result is unknown.':'Launch verification could not complete. Reload your existing attempt before retrying. A signed attempt is never replaced while its result is unknown.'});}
  finally{pending--;}
 };
}
export const handleLaunchExecution=launchExecutionHandler();
