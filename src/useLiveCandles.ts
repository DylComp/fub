import {useEffect, useState} from 'react';
import type {Candle} from './market-data';
import type {Network} from './networks';
import {mergeCandles} from './market-history';

type StreamState={key:string; status:'connecting'|'live'|'unavailable'|'paused'; message?:string; bars:Candle[];updatedAt?:number};
export function useLiveCandles(symbol:string,network:Network,enabled:boolean,retry:number){
 const key=`${network}:${symbol}`;
 const [state,setState]=useState<StreamState>({key,status:'paused',bars:[]});
 useEffect(()=>{
  if(!enabled){setState({key,status:'paused',bars:[]});return;}
  let source:EventSource|undefined,timer:ReturnType<typeof setTimeout>|undefined,stopped=false,failures=0;
  setState({key,status:'connecting',bars:[]});
  function close(){source?.close();source=undefined;clearTimeout(timer);}
  function connect(){
   close();if(stopped||document.hidden||!navigator.onLine)return;
   const current=new EventSource(`/api/market-stream?symbol=${encodeURIComponent(symbol)}&network=${network}`);source=current;
   current.addEventListener('status',(event)=>{
    if(source!==current||stopped)return;
    try{const body=JSON.parse((event as MessageEvent).data);
     if(body.status==='live'){failures=0;setState(s=>({...s,status:'live',message:undefined}));}
     else if(body.status==='unavailable'){close();setState(s=>({...s,status:'unavailable',message:typeof body.message==='string'?body.message:'Live chart unavailable.'}));}
    }catch{close();setState(s=>({...s,status:'unavailable'}));}
   });
   current.addEventListener('candle',(event)=>{
    if(source!==current||stopped)return;
    try{const b=JSON.parse((event as MessageEvent).data) as Candle;
     if(!Number.isInteger(b.time)||b.time<=0||b.time>Date.now()/1000+60||[b.open,b.high,b.low,b.close].some(x=>!Number.isFinite(x)||x<=0)||b.high<Math.max(b.open,b.close)||b.low>Math.min(b.open,b.close))return;
     setState(s=>({...s,status:'live',bars:mergeCandles(s.bars,[b]),updatedAt:Date.now()}));
    }catch{/* Ignore malformed data; never invent candles. */}
   });
   current.onerror=()=>{if(source!==current||stopped)return;close();setState(s=>({...s,status:'connecting'}));timer=setTimeout(connect,Math.min(30000,1000*2**failures++));};
  }
  function visibility(){close();if(document.hidden||!navigator.onLine)setState(s=>({...s,status:'paused'}));else connect();}
  connect();document.addEventListener('visibilitychange',visibility);window.addEventListener('online',visibility);window.addEventListener('offline',visibility);
  return()=>{stopped=true;close();document.removeEventListener('visibilitychange',visibility);window.removeEventListener('online',visibility);window.removeEventListener('offline',visibility);};
 },[key,symbol,network,enabled,retry]);
 return state.key===key?state:{key,status:'connecting' as const,bars:[]};
}
