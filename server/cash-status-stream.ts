type Socket=Pick<WebSocket,'addEventListener'|'send'|'close'>;
/** Read-only Relay status cache. Every cached result still passes the same
 * status binding and independent chain checks as the HTTP path. */
export function cashStatusStream(options:{connect?:()=>Socket;now?:()=>number}={}){
 const now=options.now||Date.now;
 const entries=new Map<string,{expires:number;status?:any}>();
 let socket:Socket|null=null,ready=false,closed=false,retryAt=0;
 const send=(id:string,type='subscribe')=>socket?.send(JSON.stringify({type,event:'request.status.updated',filters:{id}}));
 function disconnect(){const old=socket;socket=null;ready=false;retryAt=now()+1000;for(const e of entries.values())delete e.status;try{old?.close();}catch{}}
 function open(){
  if(closed||socket||now()<retryAt)return;
  const current=(options.connect||(()=>new WebSocket('wss://ws.relay.link')))();socket=current;
  current.addEventListener('message',event=>{
   if(closed||socket!==current)return;
   try{
    const text=(event as MessageEvent).data;if(typeof text!=='string'||text.length>16384)throw Error();
    const m=JSON.parse(text);
    if(m.type==='connection'&&m.status==='ready'){ready=true;for(const id of entries.keys())send(id);return;}
    if(m.type==='subscribe'||m.type==='unsubscribe'){if(m.status!=='success')throw Error();return;}
    if(m.event!=='request.status.updated')return;
    const d=m.data,e=entries.get(d?.requestId);
    if(!ready||!e||e.expires<=now())return;
    if(!Number.isSafeInteger(m.publishedAt)||m.publishedAt>now()+1000||now()-m.publishedAt>10000)return;
    if(!Number.isSafeInteger(d.updatedAt)||d.updatedAt>now()+1000||now()-d.updatedAt>10000)return;
    if(e.status&&d.updatedAt<e.status.updatedAt)return;
    e.status=structuredClone(d);
   }catch{disconnect();}
  });
  for(const event of ['close','error'])current.addEventListener(event,()=>{if(socket===current)disconnect();});
 }
 return{
  read(id:string):unknown{
   if(closed||!/^0x[0-9a-f]{64}$/.test(id))return undefined;
   for(const [key,e]of entries)if(e.expires<=now()){if(ready)try{send(key,'unsubscribe');}catch{disconnect();}entries.delete(key);}
   if(!entries.has(id)){if(entries.size>=128)return undefined;entries.set(id,{expires:now()+10000});if(ready)try{send(id);}catch{disconnect();}}
   try{open();}catch{disconnect();}
   const d=entries.get(id)?.status;
   // Partial pushes must not suppress the HTTP fallback.
   return d&&['submitted','success'].includes(d.status)&&d.inTxHashes?.length&&d.txHashes?.length?structuredClone(d):undefined;
  },
  snapshot:()=>({connected:ready,subscriptions:entries.size}),
  stop(){closed=true;disconnect();entries.clear();},
 };
}
