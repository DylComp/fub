import {useEffect,useState} from 'react';
import {freshMarketTime,validTokenMarket,type TokenMarket as MarketData} from './token-market-model';
const usd=(n:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumSignificantDigits:6}).format(n);
const sol=(n:number)=>`${new Intl.NumberFormat('en-US',{maximumSignificantDigits:7}).format(n)} SOL`;
const checked=(at:number)=>new Date(at).toLocaleTimeString();
export function TokenMarket({mint,refresh}:{mint:string;refresh:number}){
 const [market,setMarket]=useState<MarketData|null>(null),[failed,setFailed]=useState(false),[now,setNow]=useState(Date.now);
 useEffect(()=>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>,busy=false;
  async function load(){
   if(busy||controller.signal.aborted)return;
   clearTimeout(timer);
   if(document.hidden){timer=setTimeout(load,15000);return;}
   busy=true;
   try{
    const r=await fetch(`/api/tokens?market=${encodeURIComponent(mint)}`,{cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(14000)])}),data:unknown=await r.json();
    if(!r.ok||!validTokenMarket(data,mint))throw Error('Market response unavailable');
    if(!controller.signal.aborted){setMarket(previous=>{
     const keep=data.curveUnavailable&&!data.price&&!data.curve&&previous?.mint===mint&&previous.curve&&previous.price?.source==='pump-curve'&&freshMarketTime(previous.curve.checkedAt)&&freshMarketTime(previous.price.checkedAt);
     return keep?{...data,price:previous.price,curve:previous.curve}:data;
    });setFailed(false);setNow(Date.now());}
   }catch{if(!controller.signal.aborted)setFailed(true);}
   finally{busy=false;if(!controller.signal.aborted)timer=setTimeout(load,15000);}
  }
  const visible=()=>{if(!document.hidden)void load();};
  const clock=setInterval(()=>setNow(Date.now()),1000);
  document.addEventListener('visibilitychange',visible);window.addEventListener('focus',visible);void load();
  return()=>{controller.abort();clearTimeout(timer);clearInterval(clock);document.removeEventListener('visibilitychange',visible);window.removeEventListener('focus',visible);};
 },[mint,refresh]);
 const same=market?.mint===mint?market:null;
 const price=same?.price&&freshMarketTime(same.price.checkedAt,now)?same.price:null;
 const dollarPrice=price?.usd!==null&&price?.usd!==undefined&&freshMarketTime(price.usdCheckedAt,now)?price.usd:null;
 const volume=same?.volume24h&&freshMarketTime(same.volume24h.checkedAt,now)?same.volume24h:null;
 const liquidity=same?.liquidity&&freshMarketTime(same.liquidity.checkedAt,now)?same.liquidity:null;
 const curve=same?.curve&&freshMarketTime(same.curve.checkedAt,now)?same.curve:null;
 return <article className="directory-card" aria-label="Token market"><h2>Market</h2>
  <dl className="directory-money">
   <div><dt>Price</dt><dd>{dollarPrice!==null?usd(dollarPrice):price?.sol!==null&&price?.sol!==undefined?sol(price.sol):'Unavailable'}</dd></div>
   <div><dt>Volume · 24h</dt><dd>{volume?usd(volume.value):'Unavailable'}</dd></div>
   <div><dt>{same?.curve?'Curve reserves':'Liquidity'}</dt><dd>{same?.curve?curve?sol(curve.reservesSol):'Unavailable':liquidity?usd(liquidity.value):'Unavailable'}</dd></div>
  </dl>
  {price?.source==='pump-curve'&&<p className="copy-help">Pump curve · checked {checked(dollarPrice!==null?price.usdCheckedAt!:price.checkedAt)}. Spot price before fees{dollarPrice!==null&&price.sol!==null?` (${sol(price.sol)})`:''}. {dollarPrice!==null?'USD conversion uses DEX Screener’s SOL price. ':''}Curve reserves are actual SOL held for trading.</p>}
  {same?.dexPair&&(volume||liquidity||price?.source==='dexscreener')&&<p className="copy-help"><a className="word-link" href={`https://dexscreener.com/solana/${same.dexPair}`} target="_blank" rel="noreferrer">DEX Screener</a> · checked {checked(volume?.checkedAt||liquidity?.checkedAt||price!.checkedAt)}. {same.curve?'Volume is from the Pump market.':'Values cover this market, not every pool.'}</p>}
  {!price&&!volume&&!liquidity&&!curve&&<p className="copy-help">Market data is unavailable. Retrying automatically.</p>}
  {(failed||same?.refreshDelayed)&&(price||volume||liquidity||curve)&&<p className="copy-help" role="status">Refresh delayed. Showing the last checked values.</p>}
 </article>;
}
