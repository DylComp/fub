import {useCompletedTask} from "./task-completion";
import {confirmLaunchRecipientReady} from './launch-recipient-ready';
import {useEffect,useRef,useState} from 'react';
import canonicalize from 'canonicalize';
import {Check,ArrowUpRight} from 'lucide-react';
import type {LaunchDraft} from './launch-model';
import {SOL_PAIR_MINT} from './launch-pairs';
import {launchAuthorization,launchHash,publicationPayload,validPublishedLaunch, type PublishedLaunch} from './launch-publication';
import {launchExecutionAuthorization} from './launch-execution-request';
import {launchRecoveryAuthorization} from './launch-recovery';
import {walletSessionRequest} from './wallet-session-client';
import {verifyWalletLogin, type WalletLogin} from './wallet-session-model';
import type {WalletConnection} from './useWallet';
import type {LaunchExecutionPlan} from '../server/launch-execution-model';
import {Modal} from './ui';
type Attempt={id:string;plan:LaunchExecutionPlan;state:string;signature:string|null;expiryVerified?:boolean};
export function LaunchFlow({draft,image,recipient,publication,connection,pairTicker,onPublished,onComplete,close}:{draft:LaunchDraft;image:File;recipient:string;publication:PublishedLaunch|null;connection:WalletConnection;pairTicker?:string;onPublished:(p:PublishedLaunch)=>void;onComplete:(mint:string)=>void;close:()=>void}){
 const [stage,setStage]=useState('Preparing your launch…'),[error,setError]=useState(''),[completed,setCompleted]=useState(''),[attempt,setAttempt]=useState<Attempt|null>(null),[retry,setRetry]=useState(0);
 const [canEditBuy,setCanEditBuy]=useState(false);
 const custom=!!draft.quoteMint&&draft.quoteMint!==SOL_PAIR_MINT;
 const owner=connection.session?.address,activeOwner=useRef(owner),task=useRef<Promise<void>|null>(null),abort=useRef<AbortController|null>(null),saved=useRef(publication),packet=useRef<{id:string;bytes:string}|null>(null),current=useRef<Attempt|null>(null),publicationRequest=useRef<object|null>(null),mint=useRef<Awaited<ReturnType<typeof import('./launch-signing')['createLaunchMint']>>|null>(null);
 activeOwner.current=owner;
 const callbacks=useRef({onPublished,onComplete,close});callbacks.current={onPublished,onComplete,close};
 useCompletedTask(completed||null,()=>{callbacks.current.onComplete(completed);callbacks.current.close();});
 useEffect(()=>{
  // A scheduled start avoids duplicate work during React's development effect replay.
  const c=new AbortController();abort.current=c;
  const timer=setTimeout(()=>{if(!task.current)task.current=run(c).finally(()=>{task.current=null;});},0);
  return()=>{clearTimeout(timer);c.abort();};
 },[owner,retry]);
 async function run(c:AbortController){
  const guard=()=>{c.signal.throwIfAborted();if(!owner||activeOwner.current!==owner)throw Error('Reconnect the wallet that started this launch.');};
  const pause=(ms:number)=>new Promise<void>((resolve,reject)=>{const t=setTimeout(done,ms);function done(){c.signal.removeEventListener('abort',stop);resolve();}function stop(){clearTimeout(t);reject(new DOMException('Cancelled','AbortError'));}c.signal.addEventListener('abort',stop,{once:true});});
  let csrf='';
  async function post(path:string,body:object){guard();const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Fomo-Request':'1','X-Fomo-CSRF':csrf},body:JSON.stringify(body),signal:AbortSignal.any([c.signal,AbortSignal.timeout(95000)])});const data=await r.json().catch(()=>{throw Error('The server did not respond. Your saved attempt can be recovered.');});guard();if(!r.ok){if(data.code==='insufficient_pair_balance'&&!packet.current&&!current.current){setCanEditBuy(true);setStage(`Initial buy uses ${pairTicker||'the selected pair token'}.`);}throw Error(data.message||'Launch unavailable.');}return data;}
  function remember(a:Attempt){current.current=a;setAttempt(a);}
  async function check(a:Attempt){const payload={id:a.id},authorization=await launchRecoveryAuthorization('check',owner!,payload);const d=await post('/api/launch-history',{authorization,payload,signature:'session'});if(d.launch?.id!==a.id||d.launch.owner!==owner||d.launch.signature!==a.signature)throw Error('Confirmation does not match this launch.');const next={...a,state:d.launch.state,expiryVerified:d.launch.expiryVerified===true};remember(next);return next;}
  try{
   guard();setError('');setCanEditBuy(false);
   setStage('Connecting your wallet…');
   type Session={configured:boolean;address:string|null;csrf?:string;expiresAt?:number};
   let session=await walletSessionRequest<Session>('status',undefined,c.signal);guard();
   if(!session.configured)throw Error('Wallet sign-in is temporarily unavailable.');
   if(session.address!==owner||!session.csrf||(session.expiresAt||0)<Date.now()+60000){
    setStage('Confirm wallet sign-in. No funds move.');
    const reply=await walletSessionRequest<{challenge:WalletLogin;message:string}>('challenge',{wallet:owner},c.signal),challenge=verifyWalletLogin(reply,owner!,location.origin);
    const signature=await connection.signWalletSession(challenge);guard();session=await walletSessionRequest<Session>('verify',{wallet:owner,signature},c.signal);
   }
   if(session.address!==owner||!session.csrf)throw Error('Wallet sign-in did not match.');csrf=session.csrf;guard();
   if(!current.current){setStage(`Checking @${draft.handle}’s wallet…`);await confirmLaunchRecipientReady(draft.handle,recipient,c.signal);guard();}
   if(!saved.current){
    setStage('Saving your coin…');
    const bytes=new Uint8Array(await image.arrayBuffer());guard();const imageHash=await launchHash(bytes),signedPayload=publicationPayload({draft,recipient,imageHash,imageType:image.type,imageBytes:bytes.length});
    let binary='';for(let offset=0;offset<bytes.length;offset+=8192)binary+=String.fromCharCode(...bytes.subarray(offset,offset+8192));
    const payload={draft,recipient,image:{type:image.type,data:btoa(binary)}},authorization=await launchAuthorization('publish',owner!,signedPayload);
    if(!publicationRequest.current)publicationRequest.current={authorization,payload,signature:'session'};
    const d=await post('/api/launch-assets',publicationRequest.current);
    if(!validPublishedLaunch(d.publication,owner!)||canonicalize(d.publication.draft)!==canonicalize(draft)||d.publication.recipient!==recipient)throw Error('Saved coin does not match your launch.');
    saved.current=d.publication;callbacks.current.onPublished(d.publication);
   }
   const p=saved.current!;
   if(p.owner!==owner||canonicalize(p.draft)!==canonicalize(draft)||p.recipient!==recipient)throw Error('This saved draft belongs to a different launch.');
   setStage('Checking the recipient and fee split…');
   const review=await post('/api/launch',{draft,recipient,publicationId:p.id,wallet:owner});
   if(!review.executable)throw Error(review.blockers?.join(' ')||'This launch is not enabled.');
   if(review.recipient!==recipient||review.handle!==draft.handle||review.split?.length!==2||review.split[0].address!==recipient||review.split[0].shareBps!==8000||review.split[1].shareBps!==2000)throw Error('The creator-fee split changed.');
   const buybackWallet=review.split[1].address,{createLaunchMint,inspectLaunch}=await import('./launch-signing');guard();
   if(!mint.current)mint.current=await createLaunchMint(custom?await (await import('./launch-mint-store')).launchMintKey(p.id):undefined);
   setStage('Preparing and simulating…');
   const payload={publicationId:p.id,mint:mint.current.address},authorization=await launchExecutionAuthorization('prepare',owner!,payload);
   let response=await post('/api/launch-execute',{authorization,payload,signature:'session'});
   if(response.setup)throw Error('This launch needs the updated automatic pair setup. Reload to resume your saved coin.');
   for(let n=0;response.preparingPair&&n<24;n++){
    if(!custom)throw Error('Unexpected pair setup for a SOL launch.');
    if(response.state==='failed')throw Error('Pair setup failed. Your coin has not launched and your wallet has not been charged.');
    if(response.state==='expired_unresolved')throw Error('Pair setup is still being confirmed. Your coin is saved; resume after confirmation.');
    setStage('Preparing your pair…');await pause(4000);guard();
    response=await post('/api/launch-execute',{authorization:await launchExecutionAuthorization('prepare',owner!,payload),payload,signature:'session'});
   }
   if(response.preparingPair)throw Error('Your pair is still being prepared. Resume this saved launch shortly.');
   let a:Attempt=response.launch;
   async function verifyAttempt(value:Attempt){if(!value||value.id!==await launchHash(canonicalize(value.plan)!)||canonicalize(value.plan.publication)!==canonicalize(p)||value.plan.buybackWallet!==buybackWallet)throw Error('Transaction does not match your coin.');await inspectLaunch(value.plan.unsigned,value.plan,{publication:p,mint:value.plan.mint,buybackWallet});guard();remember(value);}
   await verifyAttempt(a);
   if(a.state==='confirmed'){setCompleted(a.plan.mint);return;}
   if(a.state==='failed')throw Error('The launch failed on chain. View the receipt before starting another.');
   if(packet.current?.id===a.id&&['prepared','pending'].includes(a.state)){const d=await post('/api/launch-execute',{action:'submit',id:a.id,wallet:owner,signed:packet.current.bytes});a=d.launch;await verifyAttempt(a);if(d.sendingPaused)throw Error('Your signed launch is saved, but submission is paused.');}
   if(a.state==='pending'||a.state==='expired_unresolved')a=await check(a);
   if(a.state==='confirmed'){setCompleted(a.plan.mint);return;}
   // Refresh only unsigned expired attempts or signed attempts with a full nonlanding proof.
   if((a.state==='prepared'&&(a.plan.mint!==mint.current.address||Date.now()-a.plan.preparedAt>35000))||a.expiryVerified){
    setStage('Refreshing the expired transaction…');const payload={publicationId:p.id,mint:mint.current.address,replaceId:a.id},authorization=await launchExecutionAuthorization('refresh',owner!,payload);
    a=(await post('/api/launch-execute',{authorization,payload,signature:'session'})).launch;await verifyAttempt(a);
   }
   if(a.state==='prepared'){
    if(packet.current?.id!==a.id){
     if(Date.now()-a.plan.preparedAt>35000)throw Error('Preparation took too long. Resume after this transaction expires.');
     if(mint.current.address!==a.plan.mint)throw Error('Recover this launch before signing.');
     setStage('Approve the launch in your wallet.');
     const intent={publication:p,mint:mint.current.address,buybackWallet},partial=await mint.current.sign(a.plan,intent);guard();
     const bytes=await connection.signLaunchTransaction(partial,a.plan,intent);guard();packet.current={id:a.id,bytes};
    }
    setStage('Submitting your signed launch…');
    const d=await post('/api/launch-execute',{action:'submit',id:a.id,wallet:owner,signed:packet.current.bytes});a=d.launch;await verifyAttempt(a);
    if(d.sendingPaused)throw Error('Your signed launch is saved, but submission is paused.');
   }
   setStage('Waiting for on-chain confirmation…');
   for(let n=0;n<18;n++){
    if(a.state==='confirmed'){window.dispatchEvent(new Event('fub-launch-confirmed'));setCompleted(a.plan.mint);return;}
    if(a.state==='failed')throw Error('The launch failed on chain. View the transaction receipt.');
    if(a.expiryVerified)throw Error('This transaction expired without landing. Resume to prepare a fresh transaction.');
    await pause(5000);a=await check(a);
   }
   throw Error('Confirmation is still pending. Resume checks this same launch without creating another.');
  }catch(e){if(!c.signal.aborted)setError(e instanceof Error?e.message:'Launch unavailable.');}
 }
 return <Modal title={completed?'Launch completed':error?'Launch needs attention':'Launching your coin'} close={close}>
  <div className="launch-flow" aria-live="polite">
   {completed?<><Check size={36}/><h3>{draft.name} <span>${draft.ticker}</span></h3><p>Your coin is confirmed and listed in Tokens.</p><a className="button primary" href={`#tokens/${completed}`} onClick={close}>View token <ArrowUpRight size={16}/></a><p className="copy-help">Returning to Launch…</p></>:<><h3>{draft.name} <span>${draft.ticker}</span></h3><p>{stage}</p><p className="copy-help">80% of creator fees to @{draft.handle}. 20% to the Fub treasury.</p>{attempt&&<p className="copy-help">Simulated wallet debit: {(Number(attempt.plan.maxWalletDebitLamports)/1e9).toLocaleString('en-US',{maximumFractionDigits:9})} SOL, {custom?'for rent and network fees. Your opening buy spends the selected pair token.':'including the initial buy, rent and network fee.'}</p>}{error&&<><p role="alert" className="error-message">{error}</p><button className="button primary" onClick={canEditBuy?close:()=>setRetry(n=>n+1)}>{canEditBuy?"Edit initial buy":"Resume launch"}</button>{canEditBuy&&<button className="word-link" onClick={()=>setRetry(n=>n+1)}>Check balance again</button>}</>}{attempt?.signature&&<a className="word-link" href={`https://solscan.io/tx/${attempt.signature}`} target="_blank" rel="noreferrer">View transaction ↗</a>}</>}
  </div>
 </Modal>;
}
