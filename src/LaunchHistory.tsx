import {useEffect,useRef,useState} from 'react';
import type {WalletConnection} from './useWallet';
import {launchRecoveryAuthorization,validLaunchHistoryEntry} from './launch-recovery';
import type {LaunchHistoryEntry} from './launch-recovery';
const labels={prepared:'Awaiting signatures',pending:'Awaiting confirmation',expired_unresolved:'Confirmation unresolved',confirmed:'Launched',failed:'Failed on chain',superseded:'Replaced after expiry'};
export function LaunchHistory({connection,onConnect}:{connection:WalletConnection;onConnect:()=>void}){
 const [entries,setEntries]=useState<LaunchHistoryEntry[]|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');const request=useRef<AbortController|null>(null);
 useEffect(()=>{request.current?.abort();setEntries(null);setError('');setBusy(false);return()=>request.current?.abort();},[connection.session?.address]);
 async function load(id?:string){
  const owner=connection.session?.address;if(!owner){onConnect();return;}
  request.current?.abort();const controller=new AbortController();request.current=controller;setBusy(true);setError('');
  try{
   const payload=id?{id}:{},authorization=await launchRecoveryAuthorization(id?'check':'history',owner,payload),signature=await connection.signLaunchRecovery(authorization);
   if(controller.signal.aborted)return;
   const response=await fetch('/api/launch-history',{method:'POST',headers:{'Content-Type':'application/json','X-Fomo-Request':'1'},body:JSON.stringify({authorization,payload,signature}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])});const result=await response.json();if(controller.signal.aborted)return;
   if(!response.ok)throw Error(result.message||'Launch history unavailable.');
   if(id){if(!validLaunchHistoryEntry(result.launch,owner)||result.launch.id!==id)throw Error('The launch response did not match.');setEntries(previous=>previous?.map(p=>p.id===id?result.launch:p)??[result.launch]);}
   else{if(!Array.isArray(result.launches)||result.launches.length>25||!result.launches.every((p:unknown)=>validLaunchHistoryEntry(p,owner)))throw Error('Invalid launch history.');setEntries(result.launches);}
  }catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Launch history unavailable.');}
  finally{if(!controller.signal.aborted)setBusy(false);}
 }
 return <section className="launch-history" aria-label="Your launch history">
  <button className="word-link" disabled={busy} onClick={()=>void load()}>{busy?'Checking launches…':'Your launches'} <span aria-hidden="true">↗</span></button>
  {error&&<p role="alert">{error}</p>}
  {entries?.length===0&&<p className="copy-help" role="status">No launch attempts for this wallet.</p>}
  {entries?.map(p=><article key={p.id} className="launch-history-entry"><div><strong>{p.name} <span className="muted">${p.ticker}</span></strong><span>{labels[p.state]}</span></div><p className="launch-address">{p.mint}</p>
   {p.state==='expired_unresolved'&&<p className="copy-help">The transaction expired, but its outcome is not confirmed. Check this attempt before creating another coin.</p>}
   {p.signature&&<a className="word-link" href={`https://solscan.io/tx/${p.signature}`} target="_blank" rel="noreferrer">Transaction ↗</a>}
   {['pending','expired_unresolved'].includes(p.state)&&<button className="word-link" disabled={busy} onClick={()=>void load(p.id)}>Check confirmation</button>}
  </article>)}
 </section>;
}
