import {CASH_NETWORKS, type CashNetwork} from '../src/cash-route.js';
import { publicProviderJson } from './public-provider-json.js';
import type { Rpc } from './funding.js';
// Public fallback endpoints from the providers' chain registry. These are
// read-only; execution uses a separately configured and verified connection.
// Robinhood's default public RPC lacks finalized historical state. The dRPC
// endpoint passed the pinned chain-ID and finalized-code checks.
const PUBLIC = {base:'https://mainnet.base.org',bnb:'https://bsc-rpc.publicnode.com',monad:'https://rpc.monad.xyz',robinhood:'https://robinhood.drpc.org',arc:'https://rpc.drpc.mainnet.arc.io',ethereum:'https://ethereum-rpc.publicnode.com'};
const METHODS=new Set(['debug_traceTransaction','eth_chainId','eth_getStorageAt','eth_getLogs','eth_getCode','eth_call','eth_getTransactionReceipt','eth_getBlockByNumber','eth_simulateV1','eth_getBalance','eth_getTransactionCount','eth_feeHistory','eth_getTransactionByHash']);
export function cashEvmRpc(network:CashNetwork,fetcher:typeof fetch=fetch,options:{endpoint?:string;archive?:boolean;signal?:AbortSignal;timeoutMs?:number}={}):Rpc{
 const timeoutMs=options.timeoutMs??10000;
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>10000)throw Error('Invalid cash RPC timeout.');
 const endpoint=options.endpoint||process.env[`CASH_${network.toUpperCase()}_RPC_URL`]||PUBLIC[network];
 const archive=options.archive===false?undefined:process.env[`CASH_${network.toUpperCase()}_ARCHIVE_RPC_URL`]||(network==='bnb'?'https://bsc-mainnet.public.blastapi.io':network==='base'?'https://base.drpc.org':undefined);
 if(!endpoint||new URL(endpoint).protocol!=='https:')throw Error('Cash network RPC is not configured.');
 if(archive&&new URL(archive).protocol!=='https:')throw Error('Cash archive RPC is not configured.');
 const request=async(url:string,method:string,params:unknown[],timeout=timeoutMs)=>{
  const signal=AbortSignal.any([AbortSignal.timeout(timeout),...(options.signal?[options.signal]:[])]);
  let response:Response;
  for(let attempt=0;;attempt++){
   response=await fetcher(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),redirect:'error',signal});
   if(response.status!==429||attempt>=2||timeoutMs<3000)break;
   // Retry only the identical read, inside the original deadline. Never
   // retry signing/broadcast or substitute a different block for evidence.
   await response.body?.cancel();
   const hint=response.headers.get('retry-after'),seconds=hint&&/^\d+$/.test(hint)?Number(hint):0;
   const delay=Math.min(1000,Math.max(500*(attempt+1),seconds*1000));
   await new Promise<void>((resolve,reject)=>{signal.throwIfAborted();const abort=()=>{clearTimeout(timer);reject(signal.reason);};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},delay);signal.addEventListener('abort',abort,{once:true});});
  }
  const body=await publicProviderJson(response) as any;
  if(body.error||!Object.hasOwn(body,'result'))throw Error('Cash network verification is unavailable.');
  return body.result;
 };
 return async(method,params)=>{
  if(method==='debug_traceTransaction'&&(params.length!==2||typeof params[0]!=='string'||!/^0x[0-9a-f]{64}$/i.test(params[0])||JSON.stringify(params[1])!==JSON.stringify({tracer:'prestateTracer',tracerConfig:{diffMode:true}})))throw Error('Invalid gas delivery trace.');
  if(!METHODS.has(method))throw Error('This cash RPC is read-only.');
  if(method==='eth_getStorageAt'&&(params.length!==3||typeof params[0]!=='string'||!/^0x[0-9a-f]{40}$/i.test(params[0])||typeof params[1]!=='string'||!/^0x[0-9a-f]{64}$/i.test(params[1])||typeof params[2]!=='string'||!/^0x(0|[1-9a-f][0-9a-f]{0,63})$/i.test(params[2])))throw Error('Storage evidence requires an exact address, slot and block.');
  if(method==='eth_getLogs'){
   const f=params[0] as any,hash=(v:unknown)=>typeof v==='string'&&/^0x[0-9a-f]{64}$/i.test(v);
   const quantity=(v:unknown):v is string=>typeof v==='string'&&/^0x(0|[1-9a-f][0-9a-f]{0,63})$/i.test(v);
   const keys=f&&Object.keys(f).sort().join(',');
   const exact=keys==='address,blockHash,topics'&&hash(f.blockHash);
   const bounded=keys==='address,fromBlock,toBlock,topics'&&quantity(f.fromBlock)&&quantity(f.toBlock)&&BigInt(f.toBlock)>=BigInt(f.fromBlock)&&BigInt(f.toBlock)-BigInt(f.fromBlock)<10n;
   if(params.length!==1||!f||!exact&&!bounded||typeof f.address!=='string'||!/^0x[0-9a-f]{40}$/i.test(f.address)||!Array.isArray(f.topics)||f.topics.length<1||f.topics.length>4||!hash(f.topics[0])||!f.topics.every((t:unknown)=>t===null||hash(t)))throw Error('Leader logs require an exact block or bounded range and token.');
  }
  // Recent-state/simulation access does not establish archive capability.
  // Preserve exact block tags and receipt hashes on the independent reader.
  const historical=method==='debug_traceTransaction'||method==='eth_getStorageAt'||method==='eth_getLogs'||['eth_getTransactionReceipt','eth_getTransactionByHash'].includes(method)||
   method==='eth_getBlockByNumber'&&typeof params[0]==='string'&&params[0].startsWith('0x')||
   ['eth_call','eth_getCode','eth_getBalance','eth_getTransactionCount'].includes(method)&&typeof params[1]==='string'&&params[1].startsWith('0x');
  try{
   const result=await request(endpoint,method,params);
   if(result!==null||!historical||!archive||archive===endpoint)return result;
  }catch(e){if(options.signal?.aborted)throw e;if(!historical||!archive||archive===endpoint)throw e;}
  // No broadcasts, simulations, latest-state substitutions or provider URLs
  // from quotes. Verify the fallback chain before returning any evidence.
  const [chain,result]=await Promise.all([request(archive!,'eth_chainId',[],5000),request(archive!,method,params,5000)]);
  if(typeof chain!=='string'||!/^0x[0-9a-f]+$/i.test(chain)||BigInt(chain)!==BigInt(CASH_NETWORKS[network].chainId))throw Error('Wrong cash archive network.');
  return result;
 };
}
