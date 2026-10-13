import { inventoryAttempt, type IsolatedCopyInventory } from "./isolated-copy-inventory.js";
import type { Rpc } from "./funding.js";
import { recoverFromFinalizedBlock } from "./copy-block-recovery.js";
import { MAINNET_GENESIS } from "./solana-network.js";
// Finalized reads only. Missing transactions never release sell reservations.
export async function recoverIsolatedInventory(store:IsolatedCopyInventory,rpc:Rpc,signal:AbortSignal,target?:{wallet:string;mint:string}, blockRpc?: () => Rpc) {
  signal.throwIfAborted();
  const rows=target ? await store.recent(target.wallet,target.mint) : await store.pending(8);
  if(!rows.length)return {checked:0,settled:0,pending:0,refused:0};
  if(await rpc('getGenesisHash',[])!==MAINNET_GENESIS)throw Error('Inventory recovery requires Solana mainnet.');
  const report={checked:0,settled:0,pending:0,refused:0};
  let blockReads=0;
  for(const row of rows){
    signal.throwIfAborted();
    // Advance before the remote read so an unavailable/poisoned first row cannot
    // starve later rows after a restart. Concurrent recovery is idempotent.
    await store.defer(row);
    try{
      let value: unknown = null, primaryFailed=false;
      try { value=await rpc('getTransaction',[row.signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]); }
      catch { signal.throwIfAborted(); primaryFailed=true; }
      signal.throwIfAborted();report.checked++;
      // Only background recovery takes the bounded archive path. A malformed
      // positive primary receipt must be refused, never silently replaced.
      if(value===null && blockRpc && !target && blockReads<2){
        blockReads++;
        const attempt=inventoryAttempt(row.evidence,row.signed);
        if(attempt.id!==row.id || attempt.signature!==row.signature)throw Error('Private recovery identity changed.');
        const result=await recoverFromFinalizedBlock(attempt,blockRpc());
        signal.throwIfAborted();value=result.reply;primaryFailed=false;
      }
      if(primaryFailed)throw Error('Receipt provider unavailable.');
      if(value===null){report.pending++;continue;}
      if(await store.settle(row,value))report.settled++;
    }catch{signal.throwIfAborted();report.refused++;}
  }
  return report;
}
