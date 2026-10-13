import {CASH_NETWORKS, type CashNetwork} from '../src/cash-route.js';
import {isEvmAddress} from '../src/networks.js';

type Socket = Pick<WebSocket, 'addEventListener'|'send'|'close'|'readyState'>;
export type CashLeaderHint = {
  network: CashNetwork; leader: string; token: string; transaction: string;
  blockHash: string; blockNumber: string; logIndex: string;
  direction: 'incoming'|'outgoing'; confirmation:'preconfirmed'|'included'; removed: boolean; receivedAt: number;
  // A transfer notification is not proof of a trade or permission to copy it.
  tradeVerified: false;
};
const transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const hash=(v:unknown):v is string=>typeof v==='string'&&/^0x[0-9a-f]{64}$/i.test(v);
const quantity=(v:unknown):v is string=>typeof v==='string'&&/^0x(0|[1-9a-f][0-9a-f]{0,63})$/i.test(v);
const subscription=(v:unknown):v is string=>typeof v==='string'&&/^0x[0-9a-f]{1,128}$/i.test(v);

/** Read-only event ingress. No indexer, polling interval or finality wait stands
 * between receipt of a matching log and onHint. Consumers must independently
 * classify the swap and check permissions; a gift is just as capable of
 * emitting Transfer. Removed logs invalidate a hint, never authorize a sale.
 * A reconnect reports a gap. It must not silently replay old buys as new ones. */
export function cashLeaderStream(config:{
  network:CashNetwork; endpoint:string; leaders:string[];
  mode:'logs'|'pendingLogs'; heartbeat?:'heads'|'poll'; onHint:(hint:CashLeaderHint)=>void;
  onGap:()=>void; connect?:(url:string)=>Socket; now?:()=>number;
}){
  const now=config.now||Date.now,connect=config.connect||(url=>new WebSocket(url));
  const url=new URL(config.endpoint);
  if(url.protocol!=='wss:'||url.username||url.password||url.hash||!Object.hasOwn(CASH_NETWORKS,config.network))throw Error('Invalid cash stream configuration.');
  if(!['logs','pendingLogs'].includes(config.mode)||config.mode==='pendingLogs'&&config.network!=='base')throw Error('Unverified preconfirmation stream.');
  if(!config.leaders.length||config.leaders.length>100||config.leaders.some(v=>!isEvmAddress(v)||/^0x0{40}$/i.test(v)))throw Error('Invalid stream leaders.');
  const leaders=[...new Set(config.leaders.map(v=>v.toLowerCase()))];
  if(leaders.length!==config.leaders.length)throw Error('Duplicate stream leader.');
  const ownerTopics=leaders.map(v=>'0x'+v.slice(2).padStart(64,'0'));
  type Kind='heads'|'incoming'|'outgoing'|'included-incoming'|'included-outgoing';
  const polling=config.heartbeat==='poll';
  const pending=new Map<number,Kind|'chain'|'ping'|'head-poll'>();
  const subscriptions=new Map<string,Kind>();
  const expectedSubscriptions=(config.mode==='pendingLogs'?5:3)-(polling?1:0);
  const seen=new Map<string,number>();
  let socket:Socket|null=null,closed=false,opened=0,lastHead=0,lastHint=0,nextAttempt=0,failures=0,requestId=0,pingAt=0,headPollAt=0;
  let ready=false,accepted=0,removed=0,duplicates=0,gaps=0;
  let timer:ReturnType<typeof setInterval>|undefined;
  const send=(method:string,params:unknown[],kind:Kind|'chain'|'ping'|'head-poll')=>{
    const id=++requestId;pending.set(id,kind);socket!.send(JSON.stringify({jsonrpc:'2.0',id,method,params}));
  };
  const disconnect=(retry:boolean)=>{
    const old=socket;socket=null;ready=false;pending.clear();subscriptions.clear();lastHead=0;pingAt=0;headPollAt=0;
    if(retry){failures=Math.min(failures+1,5);nextAttempt=now()+Math.min(30000,250*2**failures);gaps++;try{config.onGap();}catch{/* Consumer errors cannot keep a broken stream healthy. */}}
    try{old?.close();}catch{/* Never log endpoint credentials. */}
  };
  function acceptHead(r:any){
    if(!r||!quantity(r.number)||!hash(r.hash)||!quantity(r.timestamp))throw Error();
    const age=now()-Number(BigInt(r.timestamp))*1000;
    if(!Number.isSafeInteger(age)||age>30000||age< -5000)throw Error();
    lastHead=now();
  }
  function maintain(){
    if(closed)return;
    const time=now();
    for(const [key,at] of seen)if(time-at>60000)seen.delete(key);
    if(socket){
      if(!ready&&time-opened>=10000||ready&&(!lastHead||time-lastHead>=30000)||pingAt&&time-pingAt>=5000||headPollAt&&time-headPollAt>=5000){disconnect(true);return;}
      if(ready&&polling&&!headPollAt&&time-lastHead>=15000){headPollAt=time;try{send('eth_getBlockByNumber',['latest',false],'head-poll');}catch{disconnect(true);}return;}
      if(ready&&!pingAt&&time-opened>=10000){pingAt=time;try{send('eth_chainId',[],'ping');}catch{disconnect(true);}}
      return;
    }
    if(time<nextAttempt)return;
    let current:Socket;
    try{opened=time;socket=current=connect(url.toString());}catch{disconnect(true);return;}
    current.addEventListener('open',()=>{if(socket!==current||closed)return;try{send('eth_chainId',[],'chain');}catch{disconnect(true);}});
    current.addEventListener('message',event=>{
      if(socket!==current||closed)return;
      try{
        const text=(event as MessageEvent).data;
        if(typeof text!=='string'||text.length>262144)throw Error();
        const m=JSON.parse(text);
        if(!m||m.jsonrpc!=='2.0'||Array.isArray(m))throw Error();
        if(Object.hasOwn(m,'id')){
          const kind=pending.get(m.id);if(!kind||m.error)throw Error();pending.delete(m.id);
          if(kind==='head-poll'){acceptHead(m.result);headPollAt=0;if(subscriptions.size===expectedSubscriptions){ready=true;failures=0;}return;}
          if(kind==='chain'||kind==='ping'){
            if(!quantity(m.result)||BigInt(m.result)!==BigInt(CASH_NETWORKS[config.network].chainId))throw Error();
            if(kind==='ping'){pingAt=0;opened=now();return;}
            if(polling){headPollAt=now();send('eth_getBlockByNumber',['latest',false],'head-poll');}else send('eth_subscribe',['newHeads'],'heads');
            send('eth_subscribe',[config.mode,{topics:[transfer,null,ownerTopics]}],'incoming');
            send('eth_subscribe',[config.mode,{topics:[transfer,ownerTopics]}],'outgoing');
            // Pending receipts carry a zero block hash. Subscribe to inclusion
            // as well so an early hint is never mistaken for canonical evidence
            // or lost permanently while waiting for a sealed block.
            if(config.mode==='pendingLogs'){
              send('eth_subscribe',['logs',{topics:[transfer,null,ownerTopics]}],'included-incoming');
              send('eth_subscribe',['logs',{topics:[transfer,ownerTopics]}],'included-outgoing');
            }
          }else{
            if(!subscription(m.result)||subscriptions.has(m.result))throw Error();
            subscriptions.set(m.result,kind);
            if(subscriptions.size===expectedSubscriptions&&(!polling||lastHead)){ready=true;if(!polling)lastHead=now();failures=0;}
          }
          return;
        }
        const kind=subscriptions.get(m.params?.subscription),r=m.params?.result;
        if(m.method!=='eth_subscription'||!kind||!r)throw Error();
        if(kind==='heads'){
          acceptHead(r);return;
        }
        if(!ready||!isEvmAddress(r.address)||!hash(r.transactionHash)||!hash(r.blockHash)||!quantity(r.blockNumber)||!quantity(r.transactionIndex)||!quantity(r.logIndex)||typeof r.removed!=='boolean'||!hash(r.data)||!Array.isArray(r.topics)||r.topics.length!==3||!r.topics.every(hash)||r.topics[0].toLowerCase()!==transfer||r.topics.slice(1).some((t:string)=>!/^0x0{24}[0-9a-f]{40}$/i.test(t)))throw Error();
        const direction=kind.endsWith('incoming')?'incoming':'outgoing';
        const confirmation=config.mode==='pendingLogs'&&!kind.startsWith('included-')?'preconfirmed':'included';
        if(confirmation==='included'&&/^0x0{64}$/i.test(r.blockHash))throw Error();
        const owner=r.topics[direction==='incoming'?2:1].toLowerCase(),leader='0x'+owner.slice(-40);
        if(!leaders.includes(leader))throw Error();
        const at=now(),key=[r.blockHash,r.transactionHash,r.logIndex,kind,r.removed].join(':').toLowerCase();
        if(seen.has(key)){duplicates++;return;}
        if(seen.size>=10000)throw Error();
        const hint:CashLeaderHint={network:config.network,leader,token:r.address.toLowerCase(),transaction:r.transactionHash.toLowerCase(),blockHash:r.blockHash.toLowerCase(),blockNumber:r.blockNumber.toLowerCase(),logIndex:r.logIndex.toLowerCase(),direction,confirmation,removed:r.removed,receivedAt:at,tradeVerified:false};
        // Mark seen only after a synchronous durable/enqueue handoff succeeds.
        config.onHint(hint);seen.set(key,at);lastHint=at;accepted++;if(r.removed)removed++;
      }catch{disconnect(true);}
    });
    for(const event of ['close','error'])current.addEventListener(event,()=>{if(socket===current)disconnect(true);});
  }
  return{
    start(){if(closed)throw Error('Stream is closed.');if(!timer){timer=setInterval(maintain,250);timer.unref();}maintain();},
    // Exposed for deterministic scheduler tests, not transaction execution.
    maintain,
    status:()=>({network:config.network,mode:config.mode,heartbeat:polling?'poll':'heads',connected:ready&&!!socket&&now()-lastHead<30000,subscriptions:subscriptions.size,lastHeadAt:lastHead||null,lastHintAt:lastHint||null,accepted,removed,duplicates,gaps,tradeExecution:false as const}),
    close(){closed=true;if(timer)clearInterval(timer);timer=undefined;disconnect(false);seen.clear();},
  };
}
