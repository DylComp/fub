import {useEffect,useRef,useState} from 'react';
import canonicalize from 'canonicalize';
import type {PublishedLaunch} from './launch-publication';
import {launchHash} from './launch-publication';
import type {LaunchExecutionPlan,LaunchExecutionState} from '../server/launch-execution-model';
import {launchExecutionAuthorization} from './launch-execution-request';
import type {WalletConnection} from './useWallet';
import {launchRecoveryAuthorization} from './launch-recovery';
import type {createLaunchMint} from './launch-signing';
type Attempt={id:string;plan:LaunchExecutionPlan;state:LaunchExecutionState;signature:string|null;expiryVerified?:boolean};
const states={prepared:'Ready for review',pending:'Awaiting confirmation',expired_unresolved:'Confirmation unresolved',confirmed:'Launched',failed:'Failed on chain',superseded:'Replaced after expiry'};
const sol=(n:string)=>(Number(BigInt(n))/1e9).toLocaleString('en-US',{maximumFractionDigits:9});
export function LaunchExecutionPanel({publication,buybackWallet,connection}:{publication:PublishedLaunch;buybackWallet:string;connection:WalletConnection}){
 const [attempt,setAttempt]=useState<Attempt|null>(null),[busy,setBusy]=useState(false),[accepted,setAccepted]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [now,setNow]=useState(Date.now());
 useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(t);},[]);
 const mint=useRef<Awaited<ReturnType<typeof createLaunchMint>>|null>(null),signed=useRef<{id:string;wallet:string;bytes:string}|null>(null),request=useRef<AbortController|null>(null);
 useEffect(()=>()=>{request.current?.abort();mint.current=null;signed.current=null;},[]);
 useEffect(()=>{request.current?.abort();mint.current=null;signed.current=null;setAttempt(null);setBusy(false);setAccepted(false);setNotice('');setError('');},[publication.id,connection.session?.address,buybackWallet]);
 const owner=publication.owner;
 async function receive(raw:unknown,controller:AbortController){
  controller.signal.throwIfAborted();
  if(raw===null){setAttempt(null);setNotice('No prepared transaction for this draft.');return;}
  const a=raw as Attempt;
  if(!a||!/^[a-f0-9]{64}$/.test(a.id)||!a.plan||!Object.hasOwn(states,a.state)||canonicalize(a.plan.publication)!==canonicalize(publication)||a.plan.buybackWallet!==buybackWallet||
     a.id!==await launchHash(canonicalize(a.plan)!)||(['prepared','superseded'].includes(a.state)!==(a.signature===null))||(a.signature!==null&&!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(a.signature)))throw Error('The returned launch does not match this draft.');
  const {inspectLaunch}=await import('./launch-signing');
  await inspectLaunch(a.plan.unsigned,a.plan,{publication,mint:a.plan.mint,buybackWallet});
  controller.signal.throwIfAborted();if(a.state==='prepared'&&signed.current?.id!==a.id)signed.current=null;setAttempt(a);setAccepted(false);
 }
 async function post(body:object,controller:AbortController,path='/api/launch-execute'){
  controller.signal.throwIfAborted();
  const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Fomo-Request':'1'},body:JSON.stringify(body),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(95000)])});
  const data=await response.json();controller.signal.throwIfAborted();if(!response.ok)throw Error(data.message||'Launch request unavailable.');return data;
 }
 async function run(action:'prepare'|'refresh'|'load'|'sign'|'retry'|'check'){
  if(connection.session?.address!==owner){setError('Connect the wallet that published this coin.');return;}
  request.current?.abort();const controller=new AbortController();request.current=controller;setBusy(true);setError('');setNotice('');
  try{
   if(action==='check'){
    if(!attempt)return;const payload={id:attempt.id},authorization=await launchRecoveryAuthorization('check',owner,payload),signature=await connection.signLaunchRecovery(authorization);
    const data=await post({authorization,payload,signature},controller,'/api/launch-history');
    if(data.launch?.id!==attempt.id||data.launch.owner!==owner||!Object.hasOwn(states,data.launch.state)||data.launch.signature!==attempt.signature)throw Error('Confirmation response did not match.');
    setAttempt({...attempt,state:data.launch.state,expiryVerified:data.launch.expiryVerified===true});return;
   }
   if(action==='sign'||action==='retry'){
    if(!attempt)throw Error('Prepare the launch first.');
    if(action==='sign'){
     if(Date.now()-attempt.plan.preparedAt>35000)throw Error('This review is too old to sign. Refresh the expired transaction first.');
     if(!accepted||attempt.state!=='prepared'||mint.current?.address!==attempt.plan.mint)throw Error('Review this launch and its fee split first.');
     const intent={publication,mint:mint.current.address,buybackWallet},partial=await mint.current.sign(attempt.plan,intent);
     controller.signal.throwIfAborted();
     const bytes=await connection.signLaunchTransaction(partial,attempt.plan,intent);
     controller.signal.throwIfAborted();signed.current={id:attempt.id,wallet:owner,bytes};
    }
    const packet=signed.current;if(!packet||packet.id!==attempt.id||packet.wallet!==owner)throw Error('The original signed transaction is no longer in this tab. Check its saved result.');
    const data=await post({action:'submit',id:packet.id,wallet:owner,signed:packet.bytes},controller);
    await receive(data.launch,controller);
    if(data.sendingPaused)setNotice('Your signed transaction is saved. Sending is paused.');
    else setNotice('The signed transaction is saved. Check confirmation for its finalized result.');
    return;
   }
   let payload:object={publicationId:publication.id};
   if(action!=='load'){
    if(!mint.current)mint.current=await (await import('./launch-signing')).createLaunchMint();
    payload={publicationId:publication.id,mint:mint.current.address,...(action==='refresh'?{replaceId:attempt?.id}:{})};
   }
   const authorization=await launchExecutionAuthorization(action,owner,payload);controller.signal.throwIfAborted();
   const signature=await connection.signLaunchExecution(authorization),data=await post({authorization,payload,signature},controller);
   await receive(data.launch,controller);
  }catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Launch request unavailable.');}
  finally{if(!controller.signal.aborted)setBusy(false);}
 }
 const ownsMint=attempt?.plan.mint===mint.current?.address;
 return <section className="launch-execution" aria-label="Launch transaction">
  {!attempt&&<div className="launch-actions"><button className="button primary" disabled={busy} onClick={()=>void run('prepare')}>{busy?'Preparing…':'Prepare transaction'}</button><button className="word-link" disabled={busy} onClick={()=>void run('load')}>Load existing transaction</button></div>}
  {attempt&&<><h4>{attempt.expiryVerified?'Expired without landing':states[attempt.state]}</h4><p className="launch-address">{attempt.plan.mint}</p><dl className="launch-costs"><div><dt>Initial buy</dt><dd>{publication.draft.initialBuy||'0'} SOL</dd></div><div><dt>Network fee</dt><dd>{sol(attempt.plan.feeLamports)} SOL</dd></div><div><dt>Simulated wallet debit</dt><dd>{sol(attempt.plan.maxWalletDebitLamports)} SOL</dd></div></dl>
   {attempt.state==='prepared'&&<>
    <p className="copy-help">{now-attempt.plan.preparedAt>35000?'This review is too old to sign. Refresh after its blockhash expires.':`Open your wallet within ${Math.max(0,Math.ceil((35000-(now-attempt.plan.preparedAt))/1000))} seconds. Confirm promptly; Solana transactions expire.`}</p>
    {!ownsMint&&<p className="copy-help">This transaction was prepared in another session. After it expires, refresh it to create a new mint key in this tab.</p>}
    {ownsMint&&<><label className="copy-toggle"><input type="checkbox" disabled={busy} checked={accepted} onChange={e=>setAccepted(e.target.checked)}/><span>I confirm this coin, the initial buy, and the permanent 80/20 creator-fee split.</span></label><button className="button primary full" disabled={busy||!accepted||!!signed.current||now-attempt.plan.preparedAt>35000} onClick={()=>void run('sign')}>{busy?'Checking launch…':'Sign and launch'}</button></>}
    <button className="word-link" disabled={busy||!!signed.current} onClick={()=>void run('refresh')}>Refresh expired transaction</button>
   </>}
   {attempt.expiryVerified&&<><p className="copy-help">Every finalized block through expiration was checked. This transaction did not land. Its signed record is preserved.</p><button className="button primary full" disabled={busy} onClick={()=>void run('refresh')}>Prepare fresh transaction</button></>}
   {!attempt.expiryVerified&&['pending','expired_unresolved'].includes(attempt.state)&&<><p className="copy-help">Check this transaction before preparing another. An unknown result is kept for recovery.</p><button className="word-link" disabled={busy} onClick={()=>void run('check')}>Check confirmation</button></>}
   {!attempt.expiryVerified&&signed.current&&['prepared','pending'].includes(attempt.state)&&<button className="word-link" disabled={busy} onClick={()=>void run('retry')}>Retry same transaction</button>}
   {attempt.signature&&<p><a className="word-link" href={`https://solscan.io/tx/${attempt.signature}`} target="_blank" rel="noreferrer">View transaction ↗</a></p>}
  </>}
  {error&&<p role="alert" className="error-message">{error}</p>}{notice&&<p role="status" className="copy-help">{notice}</p>}
 </section>;
}
