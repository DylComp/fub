import { useEffect, useState } from 'react';
import { ArrowUpRight, CheckCircle2, UserRound } from 'lucide-react';
import { fomoProfileUrl } from './fomo-identity';
import { validRecipientStats } from './fomo-recipient';
import type { FomoRecipient, FomoRecipientStats } from './fomo-recipient';
export function FomoRecipientCard({profile:p,confirmed,onConfirm,onRetry,busy,purpose="recipient"}:{purpose?:"recipient"|"wallet";profile:FomoRecipient;confirmed:boolean;onConfirm:(value:boolean)=>void;onRetry:()=>void;busy:boolean}) {
 const [imageFailed,setImageFailed]=useState(false),[stats,setStats]=useState<FomoRecipientStats|null>(null),[loading,setLoading]=useState(p.statsAvailable);
 useEffect(()=>setImageFailed(false),[p.avatarUrl]);
 useEffect(()=>{const c=new AbortController();setStats(null);setLoading(p.statsAvailable);if(p.statsAvailable)void fetch(`/api/wallet?action=recipient-stats&handle=${encodeURIComponent(p.handle)}`,{signal:AbortSignal.any([c.signal,AbortSignal.timeout(20000)])}).then(async r=>{if(!r.ok)return;const data=await r.json();if(!c.signal.aborted&&validRecipientStats(data.stats,p))setStats(data.stats);}).catch(()=>{}).finally(()=>{if(!c.signal.aborted)setLoading(false);});return()=>c.abort();},[p]);
 const matched=p.state==='matched'&&!!p.address;
 const integer=(n:number)=>new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:1}).format(n);
 return <section className="launch-recipient-card" aria-label={purpose==='wallet'?"Fomo wallet profile":"Fomo recipient profile"} aria-live="polite">
  <div className="recipient-profile-heading">
   {p.avatarUrl&&!imageFailed?<img className="recipient-avatar" src={p.avatarUrl} alt={`${p.displayName}'s Fomo profile picture`} referrerPolicy="no-referrer" onError={()=>setImageFailed(true)}/>:<span className="recipient-avatar recipient-avatar-empty" aria-label="Profile picture unavailable"><UserRound size={25}/></span>}
   <div className="recipient-profile-name"><strong>{p.displayName}</strong><a className="word-link" href={fomoProfileUrl(p.handle)} target="_blank" rel="noreferrer">@{p.handle} <ArrowUpRight size={13}/></a></div>
   <span className={`recipient-match ${matched?'matched':''}`}>{matched&&<CheckCircle2 size={14}/>} {matched?'Wallet matched':p.state==='pending'?'Finding wallet':p.state==='conflict'?'Wallet mismatch':'Profile found'}</span>
  </div>
  {stats && <div className="recipient-stats" aria-label="Fomo profile stats">
   <div><span>24h wallet PnL</span><strong>{stats?.pnlUsd!=null?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2,signDisplay:'exceptZero'}).format(stats.pnlUsd):'Unavailable'}</strong></div>
   <div><span>24h trades</span><strong>{stats?.trades!=null?integer(stats.trades):'Unavailable'}</strong></div>
   <div><span>Followers</span><strong>{stats?.followers!=null?integer(stats.followers):'Unavailable'}</strong></div>
  </div>}
  {p.profileStats && <div className="recipient-stats" aria-label="Fomo profile stats">
   <div><span>Fomo trades</span><strong>{p.profileStats.trades===null?'Unavailable':integer(p.profileStats.trades)}</strong></div>
   <div><span>Followers</span><strong>{p.profileStats.followers===null?'Unavailable':integer(p.profileStats.followers)}</strong></div>
  </div>}
  <p className="copy-help recipient-source">{p.profileStats?`Profile checked ${new Date(p.profileStats.observedAt).toLocaleString()}`:p.profilePending?'Refreshing Fomo profile stats…':loading?'Loading trading stats…':stats?`Stats via FomoScan · ${new Date(stats.updatedAt).toLocaleString()}`:'Trading stats are not available from the connected provider.'}</p>
  {matched?<><span className="recipient-wallet-label">Solana wallet</span><p className="launch-address">{p.address}</p><p className="copy-help">{p.source==='fomo-direct'?'Matched from Fomo’s transfer destination.':`Matched by ${p.source}.`}{p.observedAt ? ` Checked ${new Date(p.observedAt).toLocaleDateString()}.` : ""} {purpose==='recipient'?"Confirm this is the recipient before setting the permanent fee split.":"Public profile match. Viewing this wallet does not grant trading access."}</p>{purpose==='recipient'&&<label className="launch-confirm"><input type="checkbox" checked={confirmed} onChange={e=>onConfirm(e.target.checked)}/><span>This is the recipient I want to pay.</span></label>}</>:<div className="recipient-wallet-pending"><p>{p.state==='conflict'?'The lookup sources returned different wallets. A wallet cannot be selected until the match is resolved.':p.state==='pending'?'Finding this wallet. The result will appear when the lookup completes.':'This profile exists, but its Solana wallet has not been resolved yet.'}</p><button className="word-link" type="button" disabled={busy} onClick={onRetry}>Check wallet again</button></div>}
 </section>;
}
