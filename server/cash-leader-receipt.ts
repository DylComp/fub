import {CASH_NETWORKS,type CashNetwork} from '../src/cash-route.js';
import {isEvmAddress} from '../src/networks.js';
import type {Rpc} from './funding.js';
const transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const hash=(v:unknown):v is string=>typeof v==='string'&&/^0x[0-9a-f]{64}$/i.test(v);
const same=(a:unknown,b:string)=>typeof a==='string'&&a.toLowerCase()===b.toLowerCase();
const quantity=(v:unknown)=>{if(typeof v!=='string'||!/^0x(0|[1-9a-f][0-9a-f]{0,63})$/i.test(v))throw Error('Invalid leader chain evidence.');return BigInt(v);};
const word=(v:unknown)=>{if(!hash(v))throw Error('Invalid leader token balance.');return BigInt(v);};
export type CashLeaderBalance={network:CashNetwork;leader:string;transaction:string;sender:string;target:string;input:string;token:string;blockHash:string;blockNumber:string;blockTime:number;transactionIndex:string;beforeRaw:string;afterRaw:string;deltaRaw:string;receipt:Record<string,any>;tradeVerified:false};
// This is balance evidence, NOT a trade classification. A separate protocol
// adapter must prove a swap; gifts/airdrops/transfers must never trigger buys.
// Reconstruct the balance immediately before the transaction, not merely at
// the previous block. Multiple leader trades can occur in the same block.
type BalanceInput={network:CashNetwork;leader:string;token:string;transaction:string};
export function readCashLeaderBalance(input:BalanceInput,rpc:Rpc):Promise<CashLeaderBalance|null>{
 return readBalance(input,rpc,'finalized');
}
// Shadow observation only. This does not replace finalized execution evidence.
// A latest-block receipt can be reorganized, even after this call returns.
export async function readCashLeaderProvisionalBalance(input:BalanceInput,rpc:Rpc,now=Date.now){
 const result=await readBalance(input,rpc,'latest',now);
 return result?{...result,confirmation:'provisional' as const}:null;
}
export async function readCashLeaderCapturedBalance(input:BalanceInput,rpc:Rpc,now=Date.now){
 return readBalance(input,rpc,'latest',now,120000);
}
async function readBalance(input:BalanceInput,rpc:Rpc,confirmation:'finalized'|'latest',now=Date.now,maxAge=10000):Promise<CashLeaderBalance|null>{
 const {network,leader,token,transaction}=input;
 if(!Object.hasOwn(CASH_NETWORKS,network)||!isEvmAddress(leader)||!isEvmAddress(token)||leader!==leader.toLowerCase()||token!==token.toLowerCase()||!hash(transaction))throw Error('Invalid leader receipt request.');
 if(quantity(await rpc('eth_chainId',[]))!==BigInt(CASH_NETWORKS[network].chainId))throw Error('Wrong leader network.');
 const [r,tx,finalized]=await Promise.all([rpc('eth_getTransactionReceipt',[transaction]),rpc('eth_getTransactionByHash',[transaction]),rpc('eth_getBlockByNumber',[confirmation,false])]) as any[];
 if(!r)return null;
 if(quantity(finalized?.number)<quantity(r.blockNumber))return null;
 const block=await rpc('eth_getBlockByNumber',[r.blockNumber,false]) as any;
 if(!block||!same(block.hash,r.blockHash))return null;
 if(!hash(r.blockHash)||quantity(block.number)!==quantity(r.blockNumber)||!same(r.transactionHash,transaction)||!tx||!same(tx.hash,transaction)||!same(tx.blockHash,r.blockHash)||quantity(tx.blockNumber)!==quantity(r.blockNumber)||quantity(tx.transactionIndex)!==quantity(r.transactionIndex)||quantity(tx.chainId)!==BigInt(CASH_NETWORKS[network].chainId)||!isEvmAddress(tx.from)||!isEvmAddress(tx.to)||!same(r.from,tx.from)||!same(r.to,tx.to)||typeof tx.input!=='string'||!/^0x(?:[0-9a-f]{2}){0,70000}$/i.test(tx.input))throw Error('Leader transaction does not match its receipt.');
 if(quantity(r.status)!==1n)return null;
 if(!Array.isArray(r.logs)||r.logs.length>2000)throw Error('Leader receipt logs unavailable.');
 const height=quantity(r.blockNumber),index=quantity(r.transactionIndex),seconds=quantity(block.timestamp);if(height===0n||seconds>BigInt(Math.floor(Number.MAX_SAFE_INTEGER/1000)))throw Error('Invalid leader block.');
 if(confirmation==='latest'&&(now()-Number(seconds)*1000>maxAge||now()<Number(seconds)*1000))return null;
 const fingerprint=(log:any)=>JSON.stringify([log.address.toLowerCase(),log.blockHash.toLowerCase(),String(quantity(log.blockNumber)),log.transactionHash.toLowerCase(),String(quantity(log.transactionIndex)),String(quantity(log.logIndex)),log.topics.map((t:string)=>t.toLowerCase()),log.data.toLowerCase(),log.removed]);
 const owner='0x'+leader.slice(2).padStart(64,'0'),balanceCall={to:token,data:'0x70a08231'+owner.slice(2)};
 const [beforeValue,afterValue,outgoing,incoming]=await Promise.all([
  rpc('eth_call',[balanceCall,'0x'+(height-1n).toString(16)]),rpc('eth_call',[balanceCall,r.blockNumber]),
  rpc('eth_getLogs',[{blockHash:r.blockHash,address:token,topics:[transfer,owner]}]),
  rpc('eth_getLogs',[{blockHash:r.blockHash,address:token,topics:[transfer,null,owner]}]),
 ]);
 const previous=word(beforeValue),end=word(afterValue),logs=new Map<string,any>();
 function checked(log:any){
  if(!log||!same(log.address,token)||log.removed!==false||!same(log.blockHash,r.blockHash)||quantity(log.blockNumber)!==height||!hash(log.transactionHash)||!Array.isArray(log.topics)||log.topics.length!==3||!log.topics.every(hash)||!same(log.topics[0],transfer)||!hash(log.data))throw Error('Invalid leader transfer log.');
  const position=quantity(log.logIndex).toString();quantity(log.transactionIndex);
  if(!same(log.topics[1],owner)&&!same(log.topics[2],owner))throw Error('Unrelated leader log.');return position;
 }
 for(const group of [outgoing,incoming]){
  if(!Array.isArray(group)||group.length>10000)throw Error('Leader balance history is too large.');
  const seen=new Set<string>();for(const log of group){const id=checked(log);if(seen.has(id))throw Error('Duplicate leader transfer log.');seen.add(id);
   const old=logs.get(id);if(old&&fingerprint(old)!==fingerprint(log))throw Error('Conflicting leader transfer log.');logs.set(id,log);
  }
 }
 const ownLogs=r.logs.filter((l:any)=>same(l.address,token)&&same(l.topics?.[0],transfer)&&(same(l.topics?.[1],owner)||same(l.topics?.[2],owner)));
 const receiptIndices=new Set<string>();for(const log of ownLogs){const id=checked(log);if(receiptIndices.has(id)||!same(log.transactionHash,transaction)||quantity(log.transactionIndex)!==index)throw Error('Invalid leader receipt transfer.');receiptIndices.add(id);
  const chainLog=logs.get(id);if(!chainLog||fingerprint(chainLog)!==fingerprint(log))throw Error('Leader block history differs from receipt.');
 }
 let current=previous,before=previous,delta=0n,lastIndex=-1n;
 for(const log of [...logs.values()].sort((a,b)=>{const x=quantity(a.logIndex),y=quantity(b.logIndex);return x<y?-1:x>y?1:0;})){
  const txIndex=quantity(log.transactionIndex),amount=word(log.data),change=(same(log.topics[2],owner)?amount:0n)-(same(log.topics[1],owner)?amount:0n);
  if(txIndex<lastIndex)throw Error('Leader log order changed.');lastIndex=txIndex;
  if(txIndex<index)before+=change;
  if(txIndex===index){if(!same(log.transactionHash,transaction)||!receiptIndices.has(quantity(log.logIndex).toString()))throw Error('Unexpected transfer in leader transaction.');delta+=change;}
  current+=change;if(current<0n||current>=2n**256n)throw Error('Leader transfer history is inconsistent.');
 }
 if(current!==end||before<0n||before+delta<0n)throw Error('Token logs do not match historical balances.');
 if(confirmation==='latest'){const currentBlock=await rpc('eth_getBlockByNumber',[r.blockNumber,false]) as any;if(!currentBlock||!same(currentBlock.hash,r.blockHash)||quantity(currentBlock.number)!==height||now()-Number(seconds)*1000>maxAge)return null;}
 return{network,leader,token,transaction:transaction.toLowerCase(),sender:tx.from.toLowerCase(),target:tx.to.toLowerCase(),input:tx.input.toLowerCase(),blockHash:r.blockHash.toLowerCase(),blockNumber:r.blockNumber.toLowerCase(),blockTime:Number(seconds)*1000,transactionIndex:r.transactionIndex,beforeRaw:String(before),afterRaw:String(before+delta),deltaRaw:String(delta),receipt:r,tradeVerified:false};
}
