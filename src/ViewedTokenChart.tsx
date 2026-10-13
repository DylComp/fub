import { useEffect, useRef, useState } from 'react';
import { CandlestickSeries, ColorType, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import { useMarket } from './useMarket';
import { candleUpdates } from './chart-updates';
import { PERIODS, type Candle, type Period } from './market-data';
import { shortAddress, priceDecimals } from './assets';
import type { Network } from './networks';
import { NETWORKS } from './networks';
import './viewed-token-chart.css';

/** A read-only chart; no synthetic candles and no trading side effects. */
export function ViewedTokenChart({ address, network='solana', label, active=true }: { address:string; network?:Network; label?:string; active?:boolean }) {
 const [period,setPeriod]=useState<Period>('1S');
 const {market,retry,stream,streamMessage}=useMarket(address,period,active,network);
 const host=useRef<HTMLDivElement>(null), api=useRef<IChartApi|null>(null), series=useRef<ISeriesApi<'Candlestick'>|null>(null);
 const fitted=useRef(false), previous=useRef<Candle[]>([]);
 useEffect(()=>{
  if(!host.current)return;
  const chart=createChart(host.current,{autoSize:true,height:270,layout:{background:{type:ColorType.Solid,color:'#100d17'},textColor:'#aaa6b8',fontFamily:'inherit'},grid:{vertLines:{color:'#211b2b'},horzLines:{color:'#211b2b'}},timeScale:{timeVisible:true,secondsVisible:true},rightPriceScale:{borderVisible:false},handleScroll:{vertTouchDrag:false}});
  api.current=chart;series.current=chart.addSeries(CandlestickSeries,{upColor:'#88d7b8',downColor:'#ef788e',borderVisible:false,wickUpColor:'#88d7b8',wickDownColor:'#ef788e'});
  return()=>{chart.remove();api.current=null;series.current=null;};
 },[]);
 useEffect(()=>{fitted.current=false;previous.current=[];series.current?.setData([]);api.current?.applyOptions({timeScale:{secondsVisible:period==='1S'}});},[address,network,period]);
 useEffect(()=>{
  if(!series.current)return;
  const precision=priceDecimals(market.bars.at(-1)?.close??1);
  series.current.applyOptions({priceFormat:{type:'price',precision,minMove:10**-precision}});
  const updates=candleUpdates(previous.current,market.bars);
  const candle=(b:Candle)=>({time:b.time as UTCTimestamp,open:b.open,high:b.high,low:b.low,close:b.close});
  if(updates===null)series.current.setData(market.bars.map(candle));
  else for(const bar of updates)series.current.update(candle(bar));
  previous.current=market.bars;
  if(market.bars.length&&!fitted.current){api.current?.timeScale().fitContent();fitted.current=true;}
 },[market.bars]);
 return <section className="viewed-token-chart" aria-label={`${label||shortAddress(address)} price chart`}>
  <div className="viewed-chart-heading"><div><strong>{label||shortAddress(address)}</strong><span>{NETWORKS[network].name} · USD</span></div><div className="viewed-chart-periods" aria-label="Chart timeframe">{(Object.keys(PERIODS) as Period[]).map(p=><button key={p} aria-pressed={p===period} onClick={()=>setPeriod(p)}>{p}</button>)}</div></div>
  <div ref={host} className="viewed-chart-canvas"/>
  <div className="viewed-chart-status" role="status">{market.status==='loading'&&!market.bars.length?'Loading chart…':market.bars.length?(market.stale?'Market data is delayed.':period==='1S'?(stream==='live'?'Live · 1-second candles':`1-second candles · ${streamMessage||'live connection pending'}`):'Market prices'):market.message||'No market data is available for this token yet.'}{market.status!=='loading'&&(!market.bars.length||market.stale)&&<button className="word-link" onClick={retry}>Retry</button>}</div>
 </section>;
}
