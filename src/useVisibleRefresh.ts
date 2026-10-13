import {useEffect,useRef} from 'react';

// Read-only refreshes never overlap or run in a hidden/offline tab. A failed
// read backs off; returning to the page retries immediately without a prompt.
export function useVisibleRefresh(enabled:boolean,identity:string,interval:number,refresh:(signal:AbortSignal)=>Promise<void>){
 const latest=useRef(refresh);latest.current=refresh;
 useEffect(()=>{
  if(!enabled)return;
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,running=false,failures=0;
  const visible=()=>document.visibilityState==='visible'&&navigator.onLine;
  const schedule=()=>{if(controller.signal.aborted||!visible())return;timer=setTimeout(()=>void run(),Math.min(60000,interval*2**failures));};
  const run=async()=>{
   if(controller.signal.aborted||running||!visible())return;
   clearTimeout(timer);running=true;
   try{await latest.current(controller.signal);failures=0;}catch{failures=Math.min(failures+1,4);}
   finally{running=false;schedule();}
  };
  const wake=()=>{clearTimeout(timer);if(visible())void run();};
  schedule();document.addEventListener('visibilitychange',wake);window.addEventListener('online',wake);window.addEventListener('offline',wake);window.addEventListener('focus',wake);window.addEventListener('pageshow',wake);
  return()=>{controller.abort();clearTimeout(timer);document.removeEventListener('visibilitychange',wake);window.removeEventListener('online',wake);window.removeEventListener('offline',wake);window.removeEventListener('focus',wake);window.removeEventListener('pageshow',wake);};
 },[enabled,identity,interval]);
}
