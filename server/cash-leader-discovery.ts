import {CASH_NETWORKS,type CashNetwork} from '../src/cash-route.js';
import {isEvmAddress} from '../src/networks.js';
import {validateCashCopyScope,type CashCopyEvent,type CashCopyScope} from '../src/cash-copy-model.js';
export type CashLeaderCandidate={network:CashNetwork;leader:string;token:string;transaction:string;side:'buy'|'sell'};
export type CashLeaderScan={version:1;permissionId:string;from:number;until:number;phase:'buy'|'sell'|'dispatch';continuation:string|null;cursors:string[];candidates:CashLeaderCandidate[];processed:Record<string,number>};
export interface CashLeaderScanStore{read():Promise<CashLeaderScan|null>;save(expected:CashLeaderScan|null,next:CashLeaderScan):Promise<boolean>}
export type CashLeaderHistoryFilter=({recipient:string}|{user:string})&{startTimestamp:number;endTimestamp:number;continuation?:string};
export type CashLeaderTrade={tradeVerified:true;event:CashCopyEvent;transactionIndex:string};
const hash=(v:unknown):v is string=>typeof v==='string'&&/^0x[0-9a-f]{64}$/.test(v);
const same=(v:unknown,s:string)=>typeof v==='string'&&v.toLowerCase()===s;
export const cashLeaderCandidateKey=(c:CashLeaderCandidate)=>`${c.network}:${c.transaction}`;
function candidates(value:unknown,scope:CashCopyScope,side:'buy'|'sell'){
 const page=value as any;if(!page||!Array.isArray(page.requests)||page.requests.length>20||page.continuation!==undefined&&page.continuation!==null&&(typeof page.continuation!=='string'||!page.continuation.length||page.continuation.length>2048))throw Error('Invalid leader history page.');
 const found:CashLeaderCandidate[]=[];
 for(const r of page.requests){
  if(r.status!=='success')continue;
  const route=r.data?.route?.actual,currency=side==='buy'?route?.destination?.outputCurrency?.currency:route?.origin?.inputCurrency?.currency;
  const network=scope.networks.find(n=>CASH_NETWORKS[n].chainId===currency?.chainId);if(!network)continue;
  if(!same(side==='buy'?r.recipient:r.sender,scope.leader)||!isEvmAddress(currency.address))throw Error('Leader history wallet changed.');
  const token=currency.address.toLowerCase();if(/^0x0{40}$/.test(token))continue;
  const txs=side==='buy'?r.protocol?.settlement?.destination?.fills:[r.protocol?.deposit?.origin];
  if(!Array.isArray(txs)||txs.length!==1||txs[0]?.chainId!==CASH_NETWORKS[network].chainId||!hash(txs[0].transactionId))continue;
  found.push({network,leader:scope.leader,token,transaction:txs[0].transactionId,side});
 }
 return{found,continuation:page.continuation||null as string|null};
}
/** Bounded, restartable discovery. Checkpoint pages before advancing their
 * cursors. Provider rows are only candidates; dispatch requires fresh verified
 * chain evidence. A 30-minute overlap includes delayed finality/index updates.
 * enqueue must be durable/idempotent; a crash after enqueue may replay it. */
export function cashLeaderDiscovery(config:{scope:CashCopyScope;store:CashLeaderScanStore;requests:(filter:CashLeaderHistoryFilter)=>Promise<unknown>;verify:(candidate:CashLeaderCandidate)=>Promise<CashLeaderTrade|null>;enqueue:(event:CashCopyEvent)=>Promise<void>;now?:()=>number}){
 const scope=validateCashCopyScope(config.scope),now=config.now||Date.now;
 const commit=async(old:CashLeaderScan|null,next:CashLeaderScan)=>{if(!await config.store.save(old,next))throw Error('Leader discovery is already running.');};
 return{async tick(signal:AbortSignal){
  signal.throwIfAborted();const time=now();if(time>=scope.expiresAt)return{state:'expired' as const};
  let state=await config.store.read();
  if(state&&state.permissionId!==scope.id)state=null;
  if(!state){
   const previous=await config.store.read(),until=Math.floor((time-5000)/1000),from=Math.max(Math.floor(scope.issuedAt/1000),until-1800);
   if(from>until)return{state:'waiting' as const};
   const next:CashLeaderScan={version:1,permissionId:scope.id,from,until,phase:'buy',continuation:null,cursors:[],candidates:[],processed:{}};
   await commit(previous,next);state=next;
  }
  if(state.version!==1||state.permissionId!==scope.id||state.candidates.length>500||Object.keys(state.processed).length>2000)throw Error('Invalid saved leader scan.');
  if(state.phase!=='dispatch'){
   const filter={...(state.phase==='buy'?{recipient:scope.leader}:{user:scope.leader}),startTimestamp:state.from,endTimestamp:state.until,...(state.continuation?{continuation:state.continuation}:{})};
   const page=candidates(await config.requests(filter),scope,state.phase);signal.throwIfAborted();
   const next=structuredClone(state);
   for(const c of page.found){const key=cashLeaderCandidateKey(c),old=next.candidates.find(v=>cashLeaderCandidateKey(v)===key);
    if(old&&JSON.stringify(old)!==JSON.stringify(c))throw Error('Conflicting leader history event.');
    if(!old&&!next.processed[key])next.candidates.push(c);
   }
   if(next.candidates.length>500)throw Error('Leader history exceeds one scan capacity.');
   if(page.continuation){if(next.cursors.includes(page.continuation)||next.cursors.length>=50)throw Error('Leader history pagination did not advance.');next.cursors.push(page.continuation);next.continuation=page.continuation;}
   else{next.phase=state.phase==='buy'&&scope.copySells?'sell':'dispatch';next.continuation=null;next.cursors=[];}
   await commit(state,next);return{state:'scanning' as const,phase:next.phase,pending:next.candidates.length};
  }
  // Verify the whole bounded batch before ordering. Otherwise a later sale
  // discovered on one history page could run ahead of its preceding buy.
  const trades:CashLeaderTrade[]=[];
  for(const candidate of state.candidates){signal.throwIfAborted();const trade=await config.verify(candidate);if(!trade)continue;
   const e=trade.event;if(trade.tradeVerified!==true||e.network!==candidate.network||e.transaction!==candidate.transaction||e.token!==candidate.token||e.leader!==scope.leader||e.side!==candidate.side||!/^0x(0|[1-9a-f][0-9a-f]*)$/.test(trade.transactionIndex))throw Error('Leader classifier changed the candidate.');
   if(e.blockTime<scope.issuedAt||time-e.blockTime>1800000)continue;
   trades.push(trade);
  }
  trades.sort((a,b)=>{const x=a.event,y=b.event;if(x.network===y.network){const block=BigInt(x.blockNumber)-BigInt(y.blockNumber);if(block!==0n)return block<0n?-1:1;const index=BigInt(a.transactionIndex)-BigInt(b.transactionIndex);return index<0n?-1:index>0n?1:0;}return x.blockTime-y.blockTime||x.network.localeCompare(y.network);});
  for(const trade of trades){signal.throwIfAborted();await config.enqueue(trade.event);
   const next:CashLeaderScan=structuredClone(state!),key=cashLeaderCandidateKey(trade.event);next.processed[key]=trade.event.blockTime;next.candidates=next.candidates.filter(c=>cashLeaderCandidateKey(c)!==key);await commit(state,next);state=next;
  }
  // Unfinalized rows are rediscovered in the overlap; old indexed trades are
  // never backfilled into a new permission. Retain dedup across scan windows.
  const until=Math.floor((now()-5000)/1000),next:CashLeaderScan={...state!,from:Math.max(Math.floor(scope.issuedAt/1000),until-1800),until,phase:'buy',continuation:null,cursors:[],candidates:[],processed:Object.fromEntries(Object.entries(state!.processed).filter(([,t])=>now()-t<=1800000))};
  await commit(state,next);return{state:'complete' as const,dispatched:trades.length};
 }};
}
