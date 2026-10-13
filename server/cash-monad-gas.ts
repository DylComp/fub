import type {Rpc} from './funding.js';

// Monad charges the supplied gas limit and reports that charged amount in
// eth_simulateV1. It is not an estimate of the instructions actually needed.
// Probe the same sequential calls at the same real block, with no overrides,
// then simulate the final buffered limits before returning any signing input.
export async function narrowMonadGas(rpc:Rpc,calls:Record<string,unknown>[],blockTag:string,first:number,count:number){
 const indices=Array.from({length:count},(_,i)=>first+i);
 const run=async(limits:bigint[])=>{
  const next=calls.map((call,i)=>indices.includes(i)?{...call,gas:'0x'+limits[i-first].toString(16)}:call);
  const result:any=await rpc('eth_simulateV1',[{blockStateCalls:[{calls:next}],validation:true,traceTransfers:false},blockTag]);
  if(!Array.isArray(result)||result.length!==1||result[0]?.number!=='0x'+(BigInt(blockTag)+1n).toString(16)||!Array.isArray(result[0]?.calls)||result[0].calls.length!==calls.length)throw Error('Incomplete Monad gas simulation.');
  if(result[0].calls.some((c:any)=>!c||!['0x0','0x1'].includes(c.status)))throw Error('Invalid Monad gas simulation.');
  return {result,passed:result[0].calls.every((c:any)=>c.status==='0x1'&&!c.error)};
 };
 if(count<1||count>2||first<0||first+count>calls.length)throw Error('Invalid Monad gas calls.');
 const ceiling=indices.map(i=>BigInt(String(calls[i].gas)));
 if(ceiling.some(n=>n<21000n||n>2000000n))throw Error('Invalid Monad gas ceiling.');
 const initial=await run(ceiling);if(!initial.passed)throw Error('Cash sale simulation failed.');
 const low=indices.map(()=>21000n),high=[...ceiling];
 // Nine bounded rounds give a successful upper bound within 3,866 gas.
 // Probe one transaction at a time while keeping the other at its known-good
 // ceiling. Candidate failure never authorizes a transaction.
 for(let round=0;round<9;round++){
  const mids=high.map((n,i)=>(low[i]+n)/2n);
  const probes=await Promise.all(indices.map(async(_,i)=>{const limits=[...ceiling];limits[i]=mids[i];return (await run(limits)).passed;}));
  probes.forEach((passed,i)=>{if(passed)high[i]=mids[i];else low[i]=mids[i]+1n;});
 }
 const limits=high.map((n,i)=>{const buffered=(n*13n+9n)/10n+10000n;return buffered<ceiling[i]?buffered:ceiling[i];});
 const final=await run(limits);if(!final.passed)throw Error('Cash sale simulation failed.');
 return {result:final.result,limits:limits.map(String)};
}
