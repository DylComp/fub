import {useEffect,useRef,useState,type ReactNode} from 'react';
import {freshMarketSupply,validTokenMarket,type TokenMarket} from './token-market-model';
import {marketCapBuyTokens,marketCapValue,parseMarketCap} from './order-market-cap';
import {isMint} from './assets';

type Props={onModeChange?:(mode:'price'|'mc')=>void;buySpend?:string;buyDecimals?:number;valueKey?:string;mint:string;active?:boolean;disabled?:boolean;hasStop:boolean;quantity?:string;quote?:'USD'|'SOL';places?:number;baseLabel?:string;children:ReactNode;onChange:(target:string,stop?:string)=>void;onReady:(ready:boolean,summary:string|null)=>void};
export function MarketCapEntry({onModeChange,buySpend,buyDecimals,valueKey,mint,active=true,disabled=false,hasStop,quantity='1',quote='USD',places=18,baseLabel='Token price',children,onChange,onReady}:Props){
 const [mode,setMode]=useState<'price'|'mc'>('mc'),[target,setTarget]=useState(''),[stop,setStop]=useState('');
 const [market,setMarket]=useState<TokenMarket|null>(null),[loading,setLoading]=useState(false),[revision,setRevision]=useState(0),[now,setNow]=useState(Date.now);
 const callbacks=useRef({onChange,onReady});callbacks.current={onChange,onReady};
 useEffect(()=>{const id=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(id);},[]);
 useEffect(()=>{setMarket(null);setTarget('');setStop('');setMode('mc');},[mint]);
 useEffect(()=>{
  if(!active||disabled||mode!=='mc'||!isMint(mint))return;
  const controller=new AbortController();let running=false;
  async function refresh(){
   if(running||document.visibilityState==='hidden')return;running=true;setLoading(true);
   try{const r=await fetch(`/api/tokens?market=${encodeURIComponent(mint)}`,{signal:controller.signal,cache:'no-store'});const data=await r.json();if(!r.ok||!validTokenMarket(data,mint))throw Error();if(!controller.signal.aborted){setMarket(data);setNow(Date.now());}}
   catch{/* Retain original timestamps; conversion refuses stale data. */}
   finally{running=false;if(!controller.signal.aborted)setLoading(false);}
  }
  void refresh();const timer=setInterval(()=>void refresh(),15000);const focus=()=>void refresh();window.addEventListener('focus',focus);
  return()=>{controller.abort();clearInterval(timer);window.removeEventListener('focus',focus);};
 },[active,disabled,mode,mint,revision]);
 let converted:{target:string;stop?:string}|null=null,issue='';
 if(active&&mode==='mc'){
  try{if(!market||!freshMarketSupply(market.supply,now))throw Error('Verified token supply is unavailable. Refresh or use '+baseLabel.toLowerCase()+'.');
   converted={target:buySpend!==undefined?marketCapBuyTokens(target,buySpend,market,mint,buyDecimals!,now):marketCapValue(target,market,mint,{quote,quantity,places},now),...(hasStop?{stop:marketCapValue(stop,market,mint,{quote,quantity,places},now)}:{})};
   if(hasStop&&Number(parseMarketCap(stop))>=Number(parseMarketCap(target)))throw Error('Target market cap must exceed stop market cap.');
  }catch(e){converted=null;issue=e instanceof Error?e.message:'Check the market cap.';}
 }
 const targetValue=converted?.target,stopValue=converted?.stop;
 useEffect(()=>{
  if(disabled)return;
  if(!active||mode==='price'){callbacks.current.onReady(true,null);return;}
  if(!targetValue){callbacks.current.onReady(false,null);return;}
  callbacks.current.onChange(targetValue,stopValue);
  const label=(s:string)=>'$'+Number(parseMarketCap(s)).toLocaleString('en-US',{maximumFractionDigits:6});
  if(buySpend!==undefined){callbacks.current.onReady(true,`Buy at a maximum market cap of ${label(target)} using the SOL/USD rate and total supply at review. The signed minimum is ${targetValue} tokens; it stays fixed after approval.`);return;}
  callbacks.current.onReady(true,`MC entry: target ${label(target)}${hasStop?`, stop ${label(stop)}`:''}. Based on on-chain total supply${quote==='SOL'?' and the SOL/USD rate at review':''}. Execution uses the fixed converted ${baseLabel==='Sale proceeds'?(quote==='SOL'?'SOL proceeds':'USDC proceeds'):'price'} thresholds shown below; changes in supply${quote==='SOL'?' or SOL/USD':''} can change the MC at execution.`);
 },[valueKey,active,disabled,mode,targetValue,stopValue,target,stop,hasStop,quote,buySpend]);
 if(!active)return <>{children}</>;
 return <div className="market-cap-entry">
  <div className="filter-tabs" aria-label="Order value unit">
   <button type="button" disabled={disabled} aria-pressed={mode==='mc'} className={mode==='mc'?'selected':''} onClick={()=>{setMode('mc');onModeChange?.('mc');}}>Market cap</button>
   <button type="button" disabled={disabled} aria-pressed={mode==='price'} className={mode==='price'?'selected':''} onClick={()=>{setMode('price');onModeChange?.('price');}}>{baseLabel}</button>
  </div>
  {mode==='price'?children:<>
   <label className="field"><span>Target market cap (USD)</span><input value={target} placeholder="e.g. 1.5M" autoComplete="off" disabled={disabled} onChange={e=>setTarget(e.target.value)}/></label>
   {hasStop&&<label className="field"><span>Stop market cap (USD)</span><input value={stop} placeholder="e.g. 500K" autoComplete="off" disabled={disabled} onChange={e=>setStop(e.target.value)}/></label>}
   <p className="copy-help">MC uses on-chain total supply, not a circulating-supply estimate. Enter a number or use K, M or B.</p>
   {converted&&<p className="copy-help">{buySpend!==undefined?'Minimum tokens received':`Equivalent ${quantity==='1'&&places===18?'token price':'proceeds'}`}: {converted.target} {buySpend!==undefined?'tokens':quote}{hasStop?`, stop ${converted.stop} ${quote}`:''}.</p>}
   {quote==='SOL'&&<p className="copy-help">MC converts to fixed {buySpend!==undefined?'minimum tokens received':'SOL proceeds'}. SOL/USD changes and swap price impact can change the market cap at the fill.</p>}
   {issue&&<p className="copy-help" role="status">{loading&&!market?'Checking token supply…':issue}</p>}
   <button type="button" className="word-link" disabled={disabled||loading} onClick={()=>setRevision(v=>v+1)}>{loading?'Checking…':'Refresh conversion'}</button>
  </>}
 </div>;
}
