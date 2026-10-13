import {useEffect, useState} from 'react';
import {TokenIcon} from './TokenSearch';
import {isMint, type DiscoveredToken} from './assets';
import {parseTokenSearch, TOKEN_SEARCH_MAX_LENGTH} from './fomo-token';
import {SOL_PAIR_MINT} from './launch-pairs';

const sol: DiscoveredToken = {address: SOL_PAIR_MINT, name: 'Solana', symbol: 'SOL', price: 0, liquidity: null, volume: null};
function displayToken(value: unknown): value is DiscoveredToken {
  if (!value || typeof value !== 'object') return false;
  const t = value as DiscoveredToken;
  return isMint(t.address) && typeof t.name === 'string' && t.name.length > 0 && t.name.length <= 100 &&
    typeof t.symbol === 'string' && t.symbol.length > 0 && t.symbol.length <= 40;
}
function safeImage(image: string | undefined) {
  try { const u = new URL(image || ''); return u.protocol === 'https:' && u.hostname === 'cdn.dexscreener.com' && !u.username && !u.password ? u.href : undefined; } catch { return undefined; }
}
function Identity({token}: {token: DiscoveredToken}) {
  return <><TokenIcon token={{id: token.address === SOL_PAIR_MINT ? 'SOL' : token.address, symbol: token.symbol, image: safeImage(token.image)}}/><div className="launch-pair-identity"><strong>{token.symbol}</strong><span>{token.name}</span><small>{token.address}</small></div></>;
}
export function LaunchPairPicker({selectedMint,onSelect,onPendingChange,customEnabled=false,eligible=false,checking=false,failure=false}: {selectedMint: string; customEnabled?:boolean; eligible?:boolean; checking?:boolean; failure?:boolean; onSelect: (mint: string) => void; onPendingChange: (pending: boolean) => void}) {
  const [query,setQuery] = useState(''), [selected,setSelected] = useState<DiscoveredToken|null>(null), [retry,setRetry] = useState(0);
  const [result,setResult] = useState<{query:string;tokens:DiscoveredToken[];error?:string}|null>(null);
  const parsed = parseTokenSearch(query), term = parsed.query;
  // A restored address is still selected even when its display metadata is unavailable.
  useEffect(()=>{
    if(selectedMint === SOL_PAIR_MINT || selected?.address === selectedMint)return;
    const c=new AbortController();
    void fetch(`/api/tokens?q=${encodeURIComponent(selectedMint)}`,{signal:AbortSignal.any([c.signal,AbortSignal.timeout(10000)])})
      .then(async r=>{if(!r.ok)return;const data=await r.json();if(c.signal.aborted)return;const t=Array.isArray(data.tokens)?data.tokens.find((t:unknown)=>displayToken(t)&&t.address===selectedMint):null;if(t)setSelected(t);}).catch(()=>{});
    return()=>c.abort();
  },[selectedMint,selected?.address]);
  useEffect(()=>{
    if(term.length<2 || parsed.error)return;
    const c=new AbortController();
    const timer=setTimeout(()=>{
      void fetch(`/api/tokens?q=${encodeURIComponent(term)}`,{signal:AbortSignal.any([c.signal,AbortSignal.timeout(10000)])})
        .then(async r=>{
          if(!r.ok)throw Error('Token search is unavailable. Try again.');
          const data=await r.json();if(!Array.isArray(data.tokens))throw Error('Token search is unavailable. Try again.');
          const tokens=data.tokens.filter((t:unknown)=>displayToken(t)&&(!parsed.exactMint||t.address===parsed.exactMint)).slice(0,12);
          if(!c.signal.aborted)setResult({query:term,tokens});
        }).catch(()=>{if(!c.signal.aborted)setResult({query:term,tokens:[],error:'Token search is unavailable. Try again.'});});
    },300);
    return()=>{clearTimeout(timer);c.abort();};
  },[term,parsed.exactMint,parsed.error,retry]);
  function choose(token:DiscoveredToken){setSelected(token);setQuery('');setResult(null);onPendingChange(false);onSelect(token.address);}
  const current=selectedMint===SOL_PAIR_MINT?sol:selected?.address===selectedMint?selected:null;
  return <div className="launch-pair-picker">
    <div className="launch-selected-pair" aria-label="Selected pair">
      {current?<Identity token={current}/>:<div className="launch-pair-identity"><strong>Selected token</strong><small>{selectedMint}</small><span>Token details unavailable. Your selected mint is unchanged.</span></div>}
      <span className="launch-pair-state">{selectedMint===SOL_PAIR_MINT?'Selected':failure?'Pair check failed':checking?'Checking pair…':customEnabled&&eligible?'Selected':'Pair launches paused'}</span>
    </div>
    <label className="field"><span>Find a pair</span><input aria-label="Find a pair" placeholder="Coin name, ticker or mint address" maxLength={TOKEN_SEARCH_MAX_LENGTH} value={query} spellCheck={false} autoComplete="off" onKeyDown={e=>{if(e.key==='Enter')e.preventDefault();}} onChange={e=>{setQuery(e.target.value);setResult(null);onPendingChange(!!e.target.value.trim());}}/></label>
    {!!query.trim() && <div className="launch-pair-results" aria-live="polite">
      {parsed.error?<p role="alert">{parsed.error}</p>:term.length<2?<p>Enter at least two characters.</p>:result?.query!==term?<p>Finding tokens…</p>:result.error?<p role="alert">{result.error} <button type="button" className="word-link" onClick={()=>{setResult(null);setRetry(n=>n+1);}}>Retry</button></p>:!result.tokens.length?<p>No matching token found. Check the mint address. Your pair has not changed.</p>:result.tokens.map(token=><button type="button" key={token.address} className="launch-pair-result" aria-label={`Select ${token.symbol} ${token.address}`} onClick={()=>choose(token)}><Identity token={token}/><span>Choose</span></button>)}
      <p className="copy-help">Select a result or clear the search before launching. A search does not change your selected pair.</p>
      <button type="button" className="word-link" onClick={()=>{setQuery('');setResult(null);onPendingChange(false);}}>Cancel search</button>
    </div>}
    {selectedMint!==SOL_PAIR_MINT&&<button type="button" className="word-link" onClick={()=>choose(sol)}>Use SOL instead</button>}
    <p className="copy-help">Choose a token. Fub checks whether Pump supports it as a pair.</p>
  </div>;
}
