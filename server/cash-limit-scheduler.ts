// Host supplies a durable fair due queue. One tick at a time per process;
// journal compare-and-swap fences other processes. No timer overlaps a run.
export function cashLimitScheduler(c:{due:()=>Promise<string[]>;tick:(id:string)=>Promise<void>;after?:(id:string)=>Promise<void>;intervalMs?:number}){
 let stopped=false,running=false,timer:ReturnType<typeof setTimeout>|undefined;
 const interval=c.intervalMs??5000;
 if(!Number.isSafeInteger(interval)||interval<1000||interval>60000)throw Error('Invalid limit scheduler interval.');
 const status={running:false,checkedAt:0,lastSuccessAt:0,failures:0,checked:0};
 async function run(){
  if(stopped||running)return;running=true;status.running=true;
  try{
   const ids=await c.due();if(!Array.isArray(ids)||ids.length>100)throw Error('Invalid limit queue.');
   for(const id of ids){if(stopped)break;try{await c.tick(id);status.lastSuccessAt=Date.now();}catch{status.failures++;}finally{status.checked++;await c.after?.(id);}}
  }catch{status.failures++;}finally{status.checkedAt=Date.now();status.running=false;running=false;}
 }
 async function loop(){await run();if(!stopped)timer=setTimeout(loop,interval);}
 return{run,status:()=>({...status}),start(){if(stopped||timer||running)return;void loop();},stop(){stopped=true;if(timer)clearTimeout(timer);timer=undefined;}};
}
