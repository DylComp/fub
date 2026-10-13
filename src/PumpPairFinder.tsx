import {useEffect,useRef,useState} from 'react';
import {ArrowRight} from 'lucide-react';
import {isMint} from './assets';
import {SOL_PAIR_MINT,validResolvedLaunchPair,type LaunchPair} from './launch-pairs';
export function PumpPairFinder({onSelect}:{onSelect:(pair:LaunchPair)=>void}) {
 const [mint,setMint]=useState(''),[pair,setPair]=useState<LaunchPair|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const request=useRef<AbortController|null>(null);
 useEffect(()=>()=>request.current?.abort(),[]);
 function change(value:string){request.current?.abort();setBusy(false);setError('');setPair(null);setMint(value);}
 async function check(){
  const address=mint.trim();request.current?.abort();setPair(null);setError('');
  if(!isMint(address)||address===SOL_PAIR_MINT){setError('Paste a Pump token’s mint address. Select SOL above for a SOL pair.');return;}
  const c=new AbortController();request.current=c;setBusy(true);
  try {
   const r=await fetch(`/api/launch?view=pair&mint=${encodeURIComponent(address)}`,{signal:AbortSignal.any([c.signal,AbortSignal.timeout(30000)])});
   const data=await r.json();c.signal.throwIfAborted();
   if(!r.ok)throw Error(typeof data.message==='string'?data.message:'Pair lookup is unavailable.');
   if(!validResolvedLaunchPair(data,address)||Date.now()-data.checkedAt>30000||data.checkedAt>Date.now()+5000)throw Error('The pair response is stale or does not match this mint. Check again.');
   setPair(data.pair);
  }catch(e){if(!c.signal.aborted)setError(e instanceof Error?e.message:'Pair lookup is unavailable.');}
  finally{if(!c.signal.aborted)setBusy(false);}
 }
 return <div className="pump-pair-finder">
  <label className="field"><span>Pair with a Pump token</span><div className="launch-recipient-input"><input aria-label="Pump pair token mint" placeholder="Paste token mint address" value={mint} onChange={e=>change(e.target.value)} maxLength={44} spellCheck={false} autoComplete="off" onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();void check();}}}/><button type="button" className="word-link" disabled={busy} onClick={()=>void check()}>{busy?'Checking…':'Check token'}<ArrowRight size={16}/></button></div></label>
  {error&&<p className="error-message" role="alert">{error}</p>}
  {pair&&<div className="pump-pair-result" aria-label="Verified pair token"><div><strong>{pair.name}</strong><span>{pair.ticker}{pair.stage?` · ${pair.stage==='pool'?'PumpSwap':'Bonding curve'}`:''}</span><p className="launch-address">{pair.mint}</p></div><button type="button" className="button secondary" onClick={()=>onSelect(pair)}>Use this pair</button></div>}
  <p className="copy-help">Checked against Pump’s on-chain pair rules. Mayhem coins, pairs already nested under another Pump coin, and coins waiting to migrate cannot be used.</p>
 </div>;
}
