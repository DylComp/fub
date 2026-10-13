import {useEffect,useRef,useState} from 'react';
import {tokenSolRate,tokensForSol,solForTokens} from './native-order-amount';
import {exitAmount} from './direct-exit-client';
import type {TokenMarket} from './token-market-model';
type Props={mint:string;quantity:string;decimals:number;maxQuantity?:string;disabled?:boolean;onChange:(tokens:string)=>void;onReady:(ready:boolean)=>void};
// Sizing is a current SOL valuation, not a guarantee of proceeds. The signed
// order still binds a fixed token quantity and an independent minimum return.
export function NativeSellAmount(p:Props){
 const [market,setMarket]=useState<TokenMarket|null>(null),[now,setNow]=useState(Date.now),[entry,setEntry]=useState<string|null>(null),[error,setError]=useState('');
 const callbacks=useRef(p);callbacks.current=p;
 useEffect(()=>{setMarket(null);setEntry(null);setError('');let busy=false;const c=new AbortController();
  async function refresh(){if(busy||document.hidden)return;busy=true;try{const r=await fetch('/api/tokens?market='+encodeURIComponent(p.mint),{signal:c.signal,cache:'no-store'});if(!r.ok)throw Error();const m=await r.json();tokenSolRate(m,p.mint);if(!c.signal.aborted)setMarket(m);}catch{}finally{busy=false;}}
  void refresh();const timer=setInterval(()=>{setNow(Date.now());void refresh();},15000),tick=setInterval(()=>setNow(Date.now()),1000);return()=>{c.abort();clearInterval(timer);clearInterval(tick);};
 },[p.mint]);
 let rate:number|null=null,issue='';try{if(!market)throw Error('Checking the token’s SOL price…');rate=tokenSolRate(market,p.mint,now);}catch(e){issue=(e as Error).message;}
 let display='';try{if(rate&&p.quantity)display=solForTokens(p.quantity,rate);}catch{}
 let balanceIssue='';
 if(p.quantity&&p.maxQuantity!==undefined){
  try{if(p.maxQuantity==='0'||BigInt(exitAmount(p.quantity,p.decimals))>BigInt(exitAmount(p.maxQuantity,p.decimals)))balanceIssue='This amount exceeds your available token balance. Choose Max or enter a smaller amount.';}catch{balanceIssue='Enter a valid token amount.';}
 }
 const ready=!!rate&&!error&&!balanceIssue&&Number(p.quantity)>0;
 useEffect(()=>callbacks.current.onReady(ready),[ready,p.mint]);
 useEffect(()=>{setEntry(null);setError('');},[p.quantity]);
 return <label className="field native-sell-amount"><span>Amount to sell (SOL)</span><div className="input-shell"><input aria-label="Amount to sell (SOL)" inputMode="decimal" autoComplete="off" disabled={p.disabled||!rate} value={entry??display} onChange={e=>{const value=e.target.value;setEntry(value);try{if(!rate)throw Error('Refresh the SOL price.');const quantity=tokensForSol(value,rate,p.decimals);setError('');p.onChange(quantity);}catch(e){setError((e as Error).message);}}}/><span>SOL</span>{p.maxQuantity!==undefined&&<button type="button" className="word-link" aria-label="Sell full token balance" disabled={p.disabled||!rate||!(Number(p.maxQuantity)>0)} onClick={()=>{setEntry(null);setError('');p.onChange(p.maxQuantity!);}}>Max</button>}</div><small className="copy-help">{p.quantity?`${p.quantity} tokens at the current SOL price. `:''}The order fixes this token quantity; actual proceeds depend on its limit and the available route.</small>{(error||balanceIssue||issue)&&<small role="status" className="copy-help">{error||balanceIssue||issue}</small>}</label>;
}
