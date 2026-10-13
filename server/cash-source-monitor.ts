import {isMint} from '../src/assets.js';
import {MAINNET_GENESIS} from './solana-network.js';
import {readCashSourceDeposit} from './cash-leader-deposit.js';
import type {Rpc} from './funding.js';
type Socket=Pick<WebSocket,'addEventListener'|'send'|'close'|'readyState'>;
type Deposit=NonNullable<Awaited<ReturnType<typeof readCashSourceDeposit>>>;
/** Read-only source index. Keeps recent confirmed commitments in memory, never
 * creates jobs or authorizes money movement. Destination order payloads must
 * still hash to these commitments; a timestamp match is not sufficient. */
export function cashSourceMonitor(config:{endpoint:string;wallets:string[];rpc:(signal:AbortSignal)=>Rpc;connect?:(url:string)=>Socket;now?:()=>number;read?:typeof readCashSourceDeposit}){
 const url=new URL(config.endpoint),now=config.now||Date.now,read=config.read||readCashSourceDeposit;
 if(url.protocol!=='wss:'||url.username||url.password||url.hash||!config.wallets.length||config.wallets.length>100||config.wallets.some(w=>!isMint(w))||new Set(config.wallets).size!==config.wallets.length)throw Error('Invalid source stream configuration.');
 const connect=config.connect||(url=>new WebSocket(url));
 const pending=new Map<number,string>(),subscriptions=new Map<number,string>(),queue=new Map<string,{wallet:string;signature:string;slot:number;at:number}>(),active=new Map<string,AbortController>();
 const seen=new Map<string,number>(),deposits=new Map<string,{proof:Deposit;receivedAt:number}>();
 let socket:Socket|null=null,closed=false,checking=false,ready=false,openedAt=0,nextAttempt=0,requestId=0,gaps=0,accepted=0,verified=0,refused=0,expired=0,overloaded=0,epoch=0;
 let lastSlot=0,lastAdvance=0,lastCheck=0,timer:ReturnType<typeof setInterval>|undefined;
 const indexKey=(wallet:string,orderId:string)=>wallet+':'+orderId;
 function disconnect(){const old=socket;socket=null;ready=false;epoch++;subscriptions.clear();pending.clear();queue.clear();deposits.clear();for(const c of active.values())c.abort();nextAttempt=now()+1000;try{old?.close();}catch{}if(!closed)gaps++;}
 function drain(){
  while(!closed&&active.size<2&&queue.size){
   const [key,h]=queue.entries().next().value!;queue.delete(key);if(now()-h.at>1000){expired++;continue;}
   const controller=new AbortController(),generation=epoch;active.set(key,controller);
   const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(2500)]);
   void (async()=>{
    const base=config.rpc(signal),rpc:Rpc=async(m,p)=>{signal.throwIfAborted();const r=await base(m,p);signal.throwIfAborted();return r;};
    let proof:Deposit|null=null;
    for(let attempt=0;attempt<3;attempt++){
     proof=await read({wallet:h.wallet,signature:h.signature},rpc,now);if(proof||attempt===2||now()-h.at>750)break;
     await new Promise<void>((resolve,reject)=>{signal.throwIfAborted();const abort=()=>{clearTimeout(t);reject(Error('Source read cancelled.'));};const t=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},75);signal.addEventListener('abort',abort,{once:true});});
    }
    if(closed||generation!==epoch||signal.aborted)return;
    if(!proof||proof.slot!==h.slot||proof.wallet!==h.wallet||proof.signature!==h.signature){refused++;return;}
    if(proof.confirmation!=='provisional'||now()-proof.blockTime>10000||now()<proof.blockTime)throw Error('Invalid source proof.');
    const id=indexKey(h.wallet,proof.orderId),prior=deposits.get(id);
    if(prior&&prior.proof.signature!==proof.signature){deposits.delete(id);throw Error('Conflicting source commitment.');}
    if(!prior&&deposits.size>=128){overloaded++;return;}
    deposits.set(id,{proof,receivedAt:h.at});verified++;
   })().catch(()=>{if(!closed)refused++;}).finally(()=>{active.delete(key);drain();});
  }
 }
 async function health(){
  if(checking||closed)return;checking=true;const generation=epoch;
  try{const rpc=config.rpc(AbortSignal.timeout(3000));if(await rpc('getGenesisHash',[])!==MAINNET_GENESIS)throw Error();const slot=await rpc('getSlot',[{commitment:'confirmed'}]);if(!Number.isSafeInteger(slot)||Number(slot)<=0)throw Error();
   if(closed||generation!==epoch)return;const time=now();if(Number(slot)<lastSlot||lastAdvance&&time-lastAdvance>30000&&slot===lastSlot)throw Error();if(slot!==lastSlot)lastAdvance=time;lastSlot=Number(slot);lastCheck=time;
   if(!socket&&time>=nextAttempt)open();
  }catch{if(!closed&&generation===epoch)disconnect();}finally{checking=false;}
 }
 function open(){
  const current=connect(url.toString());socket=current;openedAt=now();
  current.addEventListener('open',()=>{if(closed||socket!==current)return;try{for(const wallet of config.wallets){const id=++requestId;pending.set(id,wallet);current.send(JSON.stringify({jsonrpc:'2.0',id,method:'logsSubscribe',params:[{mentions:[wallet]},{commitment:'confirmed'}]}));}}catch{disconnect();}});
  current.addEventListener('message',event=>{
   if(closed||socket!==current)return;
   try{const text=(event as MessageEvent).data;if(typeof text!=='string'||text.length>262144)throw Error();const m=JSON.parse(text);
    if(m?.jsonrpc!=='2.0'||Array.isArray(m))throw Error();
    if(Object.hasOwn(m,'id')){const wallet=pending.get(m.id);if(!wallet||m.error||!Number.isSafeInteger(m.result)||m.result<0||subscriptions.has(m.result))throw Error();pending.delete(m.id);subscriptions.set(m.result,wallet);ready=subscriptions.size===config.wallets.length;return;}
    const wallet=subscriptions.get(m.params?.subscription),r=m.params?.result,v=r?.value;
    if(!ready||m.method!=='logsNotification'||!wallet||!v||!Number.isSafeInteger(r.context?.slot)||r.context.slot<=0||typeof v.signature!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(v.signature)||!Object.hasOwn(v,'err'))throw Error();
    if(v.err!==null)return;
    const at=now(),key=wallet+':'+v.signature;if(seen.has(key))return;
    if(seen.size>=1000||queue.size>=32){overloaded++;return;}
    seen.set(key,at);queue.set(key,{wallet,signature:v.signature,slot:r.context.slot,at});accepted++;drain();
   }catch{disconnect();}
  });
  for(const kind of ['close','error'])current.addEventListener(kind,()=>{if(socket===current)disconnect();});
 }
 function maintain(){
  if(closed)return;const time=now();for(const [k,v] of seen)if(time-v>60000)seen.delete(k);for(const [k,v] of deposits)if(time-v.proof.blockTime>10000)deposits.delete(k);
  if(socket&&!ready&&time-openedAt>10000){disconnect();return;}if(!checking&&time>=nextAttempt&&(!socket||time-lastCheck>=15000))void health();
 }
 return{
  start(){if(closed)throw Error('Source monitor closed.');if(!timer){timer=setInterval(maintain,250);timer.unref();}maintain();},maintain,
  find(wallet:string,orderId:string){const v=deposits.get(indexKey(wallet,orderId));return ready&&v&&now()-v.proof.blockTime<=10000&&now()>=v.proof.blockTime?structuredClone(v.proof):null;},
  snapshot:()=>({mode:'shadow',executionEnabled:false,connected:ready&&!!socket&&now()-lastCheck<30000,subscriptions:subscriptions.size,queued:queue.size,active:active.size,cached:deposits.size,accepted,verified,refused,expired,overloaded,gaps,lastCheckAt:lastCheck||null}),
  close(){closed=true;if(timer)clearInterval(timer);disconnect();seen.clear();},
 };
}
