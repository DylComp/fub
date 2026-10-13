import {useEffect,useState} from 'react';
import {ArrowLeft,ArrowUpRight,Copy,RefreshCw} from 'lucide-react';
import {validDirectory,type DirectoryToken} from './token-directory-model';
import {TokenMarket} from './TokenMarket';
import {Avatar,Money} from './TokenDirectory';
import {fomoProfileUrl} from './fomo-identity';
import {tokenPagePath} from './token-links';
export function TokenPage({tokenKey}:{tokenKey:string}){
 const [token,setToken]=useState<DirectoryToken|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[refresh,setRefresh]=useState(0),[copied,setCopied]=useState(false);
 useEffect(()=>{setToken(null);setCopied(false);},[tokenKey]);
 useEffect(()=>{
  const c=new AbortController();let timer:ReturnType<typeof setTimeout>;
  async function load(){try{const r=await fetch(`/api/token-directory?token=${tokenKey}`,{cache:'no-store',signal:AbortSignal.any([c.signal,AbortSignal.timeout(15000)])}),d:unknown=await r.json();if(!r.ok||!validDirectory(d,'tokens'))throw Error('Token data is unavailable.');const t=d.tokens.find(t=>t.mint===tokenKey||t.publicationId===tokenKey);if(!c.signal.aborted){setToken(t||null);setError('');}}catch{if(!c.signal.aborted)setError('Token data could not be refreshed.');}finally{if(!c.signal.aborted){setLoading(false);timer=setTimeout(load,15000);}}}
  setLoading(true);void load();return()=>{c.abort();clearTimeout(timer);};
 },[tokenKey,refresh]);
 return <section className="token-directory token-page" aria-label="Token details">
  <div className="directory-toolbar"><a className="word-link" href="#tokens"><ArrowLeft size={16}/>All tokens</a><button className="icon-button" aria-label="Refresh token" onClick={()=>setRefresh(n=>n+1)} disabled={loading}><RefreshCw size={17}/></button></div>
  {error&&<p role="alert" className="error-message">{error}</p>}
  {!token?<div className="directory-empty"><h2>{loading?'Loading token…':'No confirmed launch yet.'}</h2>{!loading&&<p>This page appears when the launch is finalized.</p>}</div>:<>
   <article className="directory-card token-page-header"><div className="directory-token"><img className="directory-coin" src={token.imageUrl} alt=""/><div><h2>{token.name}</h2><p>${token.ticker}</p></div><span className="token-confirmed">Confirmed</span></div>
    {token.description&&<p className="token-description">{token.description}</p>}
    <p className="launch-address">{token.mint}</p><div className="token-page-links"><button className="word-link" onClick={()=>{void navigator.clipboard.writeText(`${location.origin}/${tokenPagePath(token.publicationId||token.mint)}`).then(()=>setCopied(true)).catch(()=>setCopied(false));}}><Copy size={14}/>{copied?'Link copied':'Copy page link'}</button><a className="word-link" href={`https://pump.fun/coin/${token.mint}`} target="_blank" rel="noreferrer">Open on Pump <ArrowUpRight size={14}/></a><a className="word-link" href={`https://solscan.io/tx/${token.signature}`} target="_blank" rel="noreferrer">Launch receipt <ArrowUpRight size={14}/></a>{([['twitter','X'],['telegram','Telegram'],['projectWebsite','Project website']] as const).map(([field,label])=>token[field]?<a className="word-link" key={field} href={token[field]} target="_blank" rel="noreferrer">{label}<ArrowUpRight size={14}/></a>:null)}</div>
    <p className="copy-help">Launched {new Date(token.confirmedAt).toLocaleString()}</p>
   </article>
   <TokenMarket key={token.mint} mint={token.mint} refresh={refresh}/>
   <article className="directory-card"><h2>Creator fees</h2><Money fees={token.fees}/><a className="directory-person" href={fomoProfileUrl(token.profile.handle)} target="_blank" rel="noreferrer"><Avatar profile={token.profile}/><span><strong>{token.profile.name}</strong><small>@{token.profile.handle} · 80% recipient</small></span><ArrowUpRight size={15}/></a><p className="launch-address">{token.profile.wallet}</p><p className="copy-help">20% goes to the Fub buyback treasury. Sent amounts are confirmed payouts recorded by Fub. Unclaimed fees are a recent finalized vault balance; unavailable checks are not shown as zero.</p></article>
  </>}
 </section>;
}
