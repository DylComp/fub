import type {CashCopyCas} from './cash-copy-journal.js';
import type {CashCopyEvent} from '../src/cash-copy-model.js';
import type {CashNetwork} from '../src/cash-route.js';
import type {Rpc} from './funding.js';
const TRANSFER='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const hash=(v:unknown):v is string=>typeof v==='string'&&/^0x[0-9a-f]{64}$/.test(v);
const quantity=(v:unknown)=>{if(typeof v!=='string'||!/^0x(0|[1-9a-f][0-9a-f]*)$/.test(v))throw Error('Invalid sale recovery block.');return BigInt(v);};
/** Recover missed leader sales directly from finalized token logs. History APIs
 * are not an authority or dependency. Only already-acquired copy inventory is
 * scanned; transactions are classified independently before execution. */
export async function recoverCashLeaderSales(c:{cas:CashCopyCas;planId:string;wallet:string;enabled:()=>boolean;rpc:(n:CashNetwork)=>Rpc;allowsAsset:(n:CashNetwork,t:string)=>boolean;verify:(input:{network:CashNetwork;leader:string;token:string;transaction:string})=>Promise<{event:CashCopyEvent}|null>;enqueue:(e:CashCopyEvent)=>Promise<void>;now?:()=>number},signal:AbortSignal){
 const now=c.now||Date.now,initial=await c.cas.read(c.planId,c.wallet);if(!initial)return;
 const d=initial.value,s=d.grant.scope;
 if(!c.enabled()||d.revoked||!s.copySells||now()>=s.expiresAt)return;
 if(Object.values(d.jobs).some(j=>j.event.side==='sell'&&!['complete','stopped'].includes(j.state)))return;
 const holdings=Object.entries(d.positions).filter(([,n])=>BigInt(n)>0n);
 if(holdings.length>20)throw Error('Sale recovery inventory exceeds its bound.');
 for(const [key] of holdings){
  signal.throwIfAborted();const [network,token]=key.split(':') as [CashNetwork,string];
  if(!s.networks.includes(network)||!c.allowsAsset(network,token))continue;
  const buys=Object.values(d.jobs).filter(j=>j.event.side==='buy'&&j.event.network===network&&j.event.token===token&&!j.leaderInvalidatedAt&&(j.state==='complete'||j.provisionalCredit));
  if(!buys.length)continue;
  const first=buys.reduce((a,b)=>quantity(a.event.blockNumber)<quantity(b.event.blockNumber)||(a.event.blockNumber===b.event.blockNumber&&quantity(a.event.transactionIndex||'0x0')<quantity(b.event.transactionIndex||'0x0'))?a:b),checkpoint=d.saleRecovery?.[key];
  const from=checkpoint?.permissionId===s.id?quantity(checkpoint.through)+1n:quantity(first.event.blockNumber);
  const rpc=c.rpc(network),head=await rpc('eth_getBlockByNumber',['finalized',false]) as any;
  const height=quantity(head?.number);if(from>height)continue;
  const to=from+9n<height?from+9n:height;
  const logs=await rpc('eth_getLogs',[{address:token,fromBlock:'0x'+from.toString(16),toBlock:'0x'+to.toString(16),topics:[TRANSFER,'0x'+s.leader.slice(2).padStart(64,'0')]}]) as any[];
  if(!Array.isArray(logs)||logs.length>1000)throw Error('Sale recovery logs exceed their bound.');
  const candidates=new Map<string,any>();
  for(const l of logs){
   if(l.removed!==false||l.address?.toLowerCase()!==token||!hash(l.transactionHash)||!hash(l.blockHash)||quantity(l.blockNumber)<from||quantity(l.blockNumber)>to||l.topics?.length!==3||l.topics[0]!==TRANSFER||l.topics[1]!=='0x'+s.leader.slice(2).padStart(64,'0')||!hash(l.data))throw Error('Sale recovery log changed.');
   quantity(l.transactionIndex);candidates.set(l.transactionHash,l);
  }
  const sorted=[...candidates.values()].sort((a,b)=>Number(quantity(a.blockNumber)-quantity(b.blockNumber))||Number(quantity(a.transactionIndex)-quantity(b.transactionIndex)));
  for(const l of sorted){
   if(Object.values(d.jobs).some(j=>j.event.network===network&&j.event.transaction===l.transactionHash))continue;
   const proof=await c.verify({network,leader:s.leader,token,transaction:l.transactionHash});signal.throwIfAborted();if(!proof)continue;
   const e=proof.event;
   if(e.side!=='sell'||e.network!==network||e.token!==token||e.leader!==s.leader||e.transaction!==l.transactionHash||e.blockHash!==l.blockHash||e.blockNumber!==l.blockNumber||e.transactionIndex!==l.transactionIndex||e.confirmation==='provisional')throw Error('Sale recovery classification changed.');
   if(e.blockTime<s.issuedAt||e.blockTime<first.event.blockTime||now()-e.blockTime>1800000)continue;
   if(e.blockNumber===first.event.blockNumber&&quantity(e.transactionIndex)<=quantity(first.event.transactionIndex||'0x0'))continue;
   const latest=await c.cas.read(c.planId,c.wallet);
   if(!c.enabled()||!latest||latest.value.revoked||latest.value.grant.scope.id!==s.id||now()>=s.expiresAt)return;
   await c.enqueue(e);return; // exact event is durable before another scan
  }
  for(let attempt=0;attempt<4;attempt++){
   const current=await c.cas.read(c.planId,c.wallet);if(!current||current.value.revoked||current.value.grant.scope.id!==s.id||!c.enabled()||now()>=s.expiresAt)return;
   const previous=current.value.saleRecovery?.[key];
   if(previous?.permissionId===s.id&&quantity(previous.through)>=to)break;
   const next=structuredClone(current.value);(next.saleRecovery??={})[key]={permissionId:s.id,through:'0x'+to.toString(16)};
   if(await c.cas.write(c.planId,c.wallet,current.revision,next))break;
   if(attempt===3)throw Error('Sale recovery checkpoint is busy.');
  }
 }
}
