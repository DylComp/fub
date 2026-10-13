import {CashCopyRecovery} from './CashCopyRecovery';
import {useEffect,useRef,useState} from 'react';
import {useVisibleRefresh} from './useVisibleRefresh';
import {cashWalletChains} from './cash-wallet-chains';
import {CASH_MINT,CASH_NETWORKS,RELAY_SOLANA} from './cash-route';
import {cashCopyClient} from './cash-copy-client';
import {readCashCopyHistory,cashCopyAmount,cashCopyTradeLabel,type CashCopyTrade} from './cash-copy-history';
type Props={serviceOrigin:string;wallet:string;planId:string;getToken:()=>Promise<string|null>;current:()=>boolean};
const receiptUrl=(chainId:number,transaction:string)=>{const base=chainId===RELAY_SOLANA?'https://solscan.io':cashWalletChains.find(c=>c.id===chainId)?.blockExplorers?.default.url;return base?base+'/tx/'+transaction:null;};
const short=(s:string)=>s.slice(0,6)+'…'+s.slice(-4);
export function CashCopyHistory(p:Props){
 const pages=useRef<(string|null)[]>([null]),refreshOffset=useRef(1),[refreshError,setRefreshError]=useState('');
 const [trades,setTrades]=useState<CashCopyTrade[]>([]),[cursor,setCursor]=useState<string|null>(null),[busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false),[error,setError]=useState('');
 const alive=useRef(true),lock=useRef(false),generation=useRef(0),controller=useRef<AbortController|null>(null),latest=useRef(p);latest.current=p;
 const current=()=>alive.current&&latest.current.wallet===p.wallet&&latest.current.planId===p.planId&&latest.current.serviceOrigin===p.serviceOrigin&&latest.current.current();
 async function load(after:string|null=null){
  if(lock.current||!current())return;lock.current=true;setBusy(true);setError('');const c=new AbortController();controller.current=c;const gen=++generation.current,valid=()=>generation.current===gen&&current();
  try{const client=cashCopyClient(p.serviceOrigin,p.getToken,valid),h=readCashCopyHistory(await client('history',{wallet:p.wallet,planId:p.planId,after},c.signal),p.planId);if(!valid())return;
   setTrades(old=>after?[...old.filter(o=>!h.trades.some(n=>n.id===o.id)),...h.trades]:h.trades);setCursor(h.nextCursor);setLoaded(true);setRefreshError('');if(after){if(!pages.current.includes(after))pages.current.push(after);}else{pages.current=[null];refreshOffset.current=1;}
  }catch{if(valid()&&!c.signal.aborted)setError('Could not refresh trade history. Previously loaded receipts remain below.');}
  finally{if(gen===generation.current){lock.current=false;if(valid())setBusy(false);}}
 }
 useEffect(()=>{alive.current=true;lock.current=false;setTrades([]);setLoaded(false);setCursor(null);setRefreshError('');pages.current=[null];refreshOffset.current=1;void load();return()=>{alive.current=false;generation.current++;controller.current?.abort();};},[p.wallet,p.planId,p.serviceOrigin]);
 useVisibleRefresh(loaded,p.wallet+':'+p.planId+':'+p.serviceOrigin,5000,async signal=>{
  if(lock.current||!current())return;
  const gen=generation.current,valid=()=>!signal.aborted&&gen===generation.current&&current(),client=cashCopyClient(p.serviceOrigin,p.getToken,valid);
  // Keep older receipts open while following new fills. Rotate one additional
  // loaded page per refresh so an older pending receipt also reaches finality.
  const anchors:[string|null,...(string|null)[]]=[null];
  if(pages.current.length>1){const index=1+(refreshOffset.current-1)%(pages.current.length-1);anchors.push(pages.current[index]);refreshOffset.current=index+1;}
  const results=await Promise.allSettled(anchors.map(async after=>({after,page:readCashCopyHistory(await client('history',{wallet:p.wallet,planId:p.planId,after},signal),p.planId)})));
  if(!valid())return;
  const updates=results.flatMap(r=>r.status==='fulfilled'?[r.value]:[]),incoming=new Map(updates.flatMap(r=>r.page.trades).map(t=>[t.id,t]));
  setTrades(old=>[...old.filter(t=>!incoming.has(t.id)),...incoming.values()].sort((a,b)=>b.observedAt-a.observedAt||b.id.localeCompare(a.id)));
  const edge=updates.find(r=>r.after===pages.current.at(-1));if(edge)setCursor(edge.page.nextCursor);
  const failed=results.some(r=>r.status==='rejected');setRefreshError(failed?'Live trade status could not refresh. Saved receipts remain below.':'');if(failed)throw Error('History refresh unavailable');
 });
 return <div aria-label="Copy trade history">
  <button className="word-link" disabled={busy} onClick={()=>void load()}>Refresh trades</button>
  {busy&&<p role="status" className="copy-help">Loading trades…</p>}
  {loaded&&!trades.length&&<p className="copy-help">No copied trades in this plan.</p>}
  {trades.map(t=>{const receipt=t.receipt||t.returnedCash;return <article key={t.id} className="copy-boundary">
   <strong>{t.side==='buy'?'Buy':'Sell'} · {CASH_NETWORKS[t.network].name}</strong>
   <p className="copy-help"><a className="word-link" href={`https://fomo.family/tokens/${t.network}/${t.token}`} target="_blank" rel="noreferrer">{short(t.token)}</a> · <time dateTime={new Date(t.observedAt).toISOString()}>{new Date(t.observedAt).toLocaleString()}</time></p>
   <p className="copy-help">{cashCopyTradeLabel(t)}. {t.side==='buy'?cashCopyAmount(t.amountRaw,6)+' USDC budget':t.tokenDecimals===null?t.amountRaw+' token base units':cashCopyAmount(t.amountRaw,t.tokenDecimals)+' tokens to sell'}.</p>
   {receipt&&<p className="copy-help">{receipt.currency===CASH_MINT?cashCopyAmount(receipt.receivedRaw,6)+' USDC received':receipt.currency===t.token&&t.tokenDecimals!==null?cashCopyAmount(receipt.receivedRaw,t.tokenDecimals)+' tokens received':'Refund received'}.
    {receiptUrl(receipt.chainId,receipt.transaction)?<a className="word-link" target="_blank" rel="noreferrer" href={receiptUrl(receipt.chainId,receipt.transaction)!}> View confirmed receipt</a>:<span title={receipt.transaction}> Confirmed transaction: {short(receipt.transaction)}</span>}
   </p>}
   {t.side==='sell'&&['needs-attention','submitted'].includes(t.state)&&!t.returnedCash&&!t.receipt&&<CashCopyRecovery {...p} trade={t} refresh={()=>void load()}/>}
  </article>;})}
  {cursor&&<button className="word-link" disabled={busy} onClick={()=>void load(cursor)}>Load older trades</button>}
  {error&&<p className="error-message" role="alert">{error}</p>}
  {refreshError&&<p className="copy-help" role="status">{refreshError}</p>}
 </div>;
}
