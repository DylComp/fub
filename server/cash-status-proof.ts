import {CASH_NETWORKS,RELAY_SOLANA} from '../src/cash-route.js';
import type {CashCopyEvent} from '../src/cash-copy-model.js';
import type {readCashLeaderFill} from './cash-leader-fill.js';
import type {readCashLeaderProvisionalBalance} from './cash-leader-receipt.js';
import {readCashSourceDeposit} from './cash-leader-deposit.js';
import type {Rpc} from './funding.js';
type Balance=NonNullable<Awaited<ReturnType<typeof readCashLeaderProvisionalBalance>>>;
type Fill=NonNullable<Awaited<ReturnType<typeof readCashLeaderFill>>>;

export class CashStatusUnavailable extends Error {
 constructor(readonly stage:'status'|'source'){super('Public intent '+stage+' temporarily unavailable.');this.name='CashStatusUnavailable';}
}

/** Uses Relay's documented public status API, not scoped history or v2.
 * This is provider-attested association plus independent chain verification,
 * NOT a reconstruction of the leader's full cryptographic order commitment.
 * The successful, code-checked fill binds request metadata to its receipt;
 * native fills do not assert a Permit2-signed intent or decoded leader minimum.
 * The public status binds that request to an exact source and destination tx.
 * A gift fails the independently checked source owner's signature/debit.
 */
export async function cashStatusProof(input:{balance:Balance;fill:Fill;sourceWallet:string},dependencies:{solana:Rpc;signal:AbortSignal;fetch?:typeof fetch;now?:()=>number}){
 const {balance:b,fill:f,sourceWallet}=input,now=dependencies.now||Date.now;
 const signal=AbortSignal.any([dependencies.signal,AbortSignal.timeout(2000)]);
 let stage:'status'|'source'='status';
 const fresh=()=>{dependencies.signal.throwIfAborted();if(signal.aborted)throw new CashStatusUnavailable(stage);if(now()<b.blockTime||now()-b.blockTime>10000)throw Error('Live fill is stale.');};
 fresh();
 if(b.confirmation!=='provisional'||b.tradeVerified!==false||f.swapVerified!==true||f.tradeVerified!==false||f.sourceAssociation!=='unverified'||f.network!==b.network||f.transaction!==b.transaction||f.blockHash!==b.blockHash||f.token!==b.token||f.recipient!==b.leader||f.outputRaw!==b.deltaRaw||BigInt(b.deltaRaw)<=0n||!/^0x[0-9a-f]{64}$/.test(f.requestId)||/^0x0{64}$/.test(f.requestId))throw Error('Live status evidence differs.');
 const url=new URL('https://api.relay.link/intents/status/v3');url.searchParams.set('requestId',f.requestId);
 let response:Response;
 try{response=await(dependencies.fetch||fetch)(url,{signal,redirect:'error',cache:'no-store',headers:{Accept:'application/json'}});}catch{dependencies.signal.throwIfAborted();throw new CashStatusUnavailable('status');}
 if(!response.ok){if(response.status===429||response.status>=500)throw new CashStatusUnavailable('status');throw Error('Public intent status unavailable.');}
 const reader=response.body?.getReader();if(!reader)throw Error('Missing public status.');
 let size=0,text='';const decoder=new TextDecoder();
 try{for(;;){const {done,value}=await reader.read().catch(()=>{dependencies.signal.throwIfAborted();throw new CashStatusUnavailable('status');});if(done)break;size+=value.byteLength;if(size>16384)throw Error('Public status too large.');text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}finally{await reader.cancel().catch(()=>{});}
 const status=JSON.parse(text);fresh();
 const signature=matchCashPublicStatus(status,b,now());
 if(!signature)return{state:'awaiting-status' as const,event:null};
 stage='source';
 const source=await readCashSourceDeposit({wallet:sourceWallet,signature},async(method,params)=>{
  try{return await dependencies.solana(method,params);}catch(error){dependencies.signal.throwIfAborted();if(error instanceof Error&&['Activity provider unavailable.','Activity read budget exhausted.','fetch failed'].includes(error.message)||error instanceof DOMException&&error.name==='TimeoutError')throw new CashStatusUnavailable('source');throw error;}
 },now);fresh();
 if(!source)return{state:'awaiting-source' as const,event:null};
 if(source.orderId!==f.orderIdHint||source.blockTime>b.blockTime+1000||b.blockTime-source.blockTime>10000)throw Error('Source payment differs from fill.');
 const event:CashCopyEvent={network:b.network,leader:b.leader,transaction:b.transaction,blockHash:b.blockHash,blockNumber:b.blockNumber,transactionIndex:b.transactionIndex,blockTime:b.blockTime,observedAt:now(),token:b.token,side:'buy',leaderTokenBeforeRaw:b.beforeRaw,leaderTokenDeltaRaw:b.deltaRaw,confirmation:'provisional',sourceOrder:{wallet:sourceWallet,signature:source.signature,orderId:source.orderId}};
 return{state:'verified' as const,event,executionEnabled:false as const,evidence:'public-status-and-independent-receipts' as const};
}

/** Association audit; does not authorize a trade or waive live freshness. */
export function matchCashPublicStatus(status:any,b:Pick<Balance,'network'|'transaction'>,timestamp:number){
 if(!status||Array.isArray(status)||!['unknown','waiting','depositing','pending','submitted','success','delayed','refund','failure'].includes(status.status))throw Error('Invalid public status.');
 if(!['submitted','success'].includes(status.status))return null;
 // Indexing can expose a submitted status before its transaction binding.
 // Missing fields never authorize a trade; retry only inside the monitor's
 // existing deadline. Any contradictory field still fails immediately.
 const missing=(value:unknown)=>value===undefined||value===null;
 if(!missing(status.originChainId)&&status.originChainId!==RELAY_SOLANA||
    !missing(status.destinationChainId)&&status.destinationChainId!==CASH_NETWORKS[b.network].chainId||
    !missing(status.inTxHashes)&&(!Array.isArray(status.inTxHashes)||status.inTxHashes.length>1||status.inTxHashes.length===1&&(typeof status.inTxHashes[0]!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(status.inTxHashes[0])))||
    !missing(status.txHashes)&&(!Array.isArray(status.txHashes)||status.txHashes.length>1||status.txHashes.length===1&&(typeof status.txHashes[0]!=='string'||status.txHashes[0].toLowerCase()!==b.transaction))||
    !missing(status.updatedAt)&&(!Number.isSafeInteger(status.updatedAt)||status.updatedAt<=0||status.updatedAt>timestamp+1000)||
    status.failReason&&!['N/A'].includes(status.failReason)||status.refundFailReason&&!['N/A'].includes(status.refundFailReason))throw Error('Public status transaction binding differs.');
 if(missing(status.originChainId)||missing(status.destinationChainId)||missing(status.updatedAt)||missing(status.inTxHashes)||status.inTxHashes.length===0||missing(status.txHashes)||status.txHashes.length===0)return null;
 return status.inTxHashes[0] as string;
}
