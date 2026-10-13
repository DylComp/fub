import {verifyLaunchSession} from './launch-session.js';
import {isFubWebOrigin} from './fub-web-origin.js';
import {blockRecoveryRpc} from './copy-block-recovery.js';
import type {ActivityReport} from '../src/activity-model.js';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {createHash,createPublicKey,verify} from 'node:crypto';
import bs58 from 'bs58';
import {Connection} from '@solana/web3.js';
import {launchRecoveryMessage} from '../src/launch-recovery.js';
import type {LaunchRecoveryAuthorization,LaunchHistoryEntry} from '../src/launch-recovery.js';
import type {LaunchExecution} from './launch-execution-model.js';
import {launchExecutionStore} from './launch-execution-store.js';
import {launchExecutionService} from './launch-execution-service.js';
import {launchExecutionChain} from './launch-execution-chain.js';
export function launchHistoryEntry(a:LaunchExecution):LaunchHistoryEntry{return {id:a.id,owner:a.plan.publication.owner,mint:a.plan.mint,name:a.plan.publication.draft.name,ticker:a.plan.publication.draft.ticker,recipient:a.plan.publication.recipient,buybackWallet:a.plan.buybackWallet,state:a.state,signature:a.signature,openingTokens:a.receipt?.openingTokens??null,expiryVerified:!!a.nonlandingProof};}
export function launchRecoveryHandler(options:{allowedActions?:LaunchRecoveryAuthorization['action'][];activity?:(owner:string)=>Promise<ActivityReport>;list?:(owner:string)=>Promise<LaunchExecution[]>;check?:(id:string,owner:string)=>Promise<LaunchExecution|null>}={}){
 let pending=0,windowStart=0,calls=0;
 return async(req:IncomingMessage,res:ServerResponse)=>{
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');const send=(status:number,data:unknown)=>{res.statusCode=status;res.end(JSON.stringify(data));};
  if(req.method!=='POST')return send(405,{message:'POST required.'});
  if(!isFubWebOrigin(req.headers.origin)||req.headers['x-fomo-request']!=='1'||req.headers['content-type']?.split(';')[0]!=='application/json'||(req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin'))return send(403,{message:'Open launch history on Fub.'});
  if(new URL(req.url||'/','https://localhost').search)return send(400,{message:'Invalid history request.'});
  if(Date.now()-windowStart>=60000){windowStart=Date.now();calls=0;}
  if(calls>=20||pending>=2)return send(429,{message:'Launch checks are busy. Try again shortly.'});pending++;calls++;
  try{
   let a:LaunchRecoveryAuthorization,payload:any;
   try{
    let body=(req as IncomingMessage&{body?:unknown}).body;
    if(body===undefined){let size=0;const chunks:Buffer[]=[],timer=setTimeout(()=>req.destroy(),5000);try{for await(const c of req){const b=Buffer.from(c);size+=b.length;if(size>8192)throw Error();chunks.push(b);}body=Buffer.concat(chunks).toString('utf8');}finally{clearTimeout(timer);}}
    const text=typeof body==='string'?body:JSON.stringify(body);if(Buffer.byteLength(text)>8192)throw Error();const raw=JSON.parse(text);
    if(Object.keys(raw).sort().join()!=='authorization,payload,signature')throw Error();a=raw.authorization;payload=raw.payload;if(!(options.allowedActions||['history','check']).includes(a.action))throw Error();
    if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).sort().join()!==(['history','activity'].includes(a.action)?'':'id')||(a.action==='check'&&!/^[a-f0-9]{64}$/.test(payload.id)))throw Error();
    const message=launchRecoveryMessage(a);if(a.payloadHash!==createHash('sha256').update(JSON.stringify(payload)).digest('hex')||typeof raw.signature!=='string'||raw.signature.length>88)throw Error();
    if(!verifyLaunchSession(req,a.wallet,raw.signature)){
    const bytes=bs58.decode(raw.signature),key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(bs58.decode(a.wallet))]),format:'der',type:'spki'});
    if(bytes.length!==64||bs58.encode(bytes)!==raw.signature||!verify(null,Buffer.from(message),key,bytes))throw Error();
    }
   }catch{return send(400,{message:'Sign a fresh launch history request with its owning wallet.'});}
   if(a.action==='activity'){if(!options.activity)return send(400,{message:'Open activity on Fub.'});const result=await options.activity(a.wallet);if(result.wallet!==a.wallet)throw Error('Activity owner mismatch');return send(200,result);}
   if(a.action==='history'){
    const attempts=await (options.list||((owner)=>launchExecutionStore(process.env.DATABASE_URL!).list(owner)))(a.wallet);
    if(attempts.some(x=>x.plan.publication.owner!==a.wallet))throw Error('History owner mismatch');return send(200,{launches:attempts.map(launchHistoryEntry)});
   }
   const check=options.check||((id,owner)=>{if(!process.env.SOLANA_RPC_URL)throw Error('RPC unavailable');const store=launchExecutionStore(process.env.DATABASE_URL!);return launchExecutionService(store,launchExecutionChain(new Connection(process.env.SOLANA_RPC_URL,'confirmed'),()=>blockRecoveryRpc()),()=>false).recover(id,owner,false);});
   const attempt=await check(payload.id,a.wallet);if(!attempt)return send(404,{message:'Launch not found for this wallet.'});if(attempt.plan.publication.owner!==a.wallet||attempt.id!==payload.id)throw Error('History owner mismatch');return send(200,{launch:launchHistoryEntry(attempt)});
  }catch{return send(503,{message:'Launch verification is unavailable. Your existing attempt is retained. Do not create a replacement while its result is unknown.'});}
  finally{pending--;}
 };
}
export const handleLaunchRecovery=launchRecoveryHandler();
