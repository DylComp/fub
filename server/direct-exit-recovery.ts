import {MAINNET_GENESIS} from './solana-network.js';
import {recoverSignedFromFinalizedBlock} from './copy-block-recovery.js';
import {verifyDirectExitClaim,verifyDirectExitRecord,verifyDirectExitLanded} from './direct-exit-settlement.js';
import type {DirectExitStore} from './direct-exit-store.js';
import type {Rpc} from './funding.js';
// Recovery deliberately ignores execution-enabled flags, expiry and revocation.
// Those stop new sends; they cannot erase a transaction already signed/submitted.
export function directExitRecovery(config:{origin:string;store:DirectExitStore;rpc:Rpc;blockRpc?:Rpc}){
  return async(signal:AbortSignal)=>{
    const counts={checked:0,settled:0,expired:0,pending:0,refused:0};
    signal.throwIfAborted();
    if(await config.rpc('getGenesisHash',[])!==MAINNET_GENESIS)throw Error('Exit recovery requires mainnet.');
    for(const row of await config.store.recoveryBatch()){
      signal.throwIfAborted();counts.checked++;
      try{
        verifyDirectExitClaim(row,config.origin);
        if(row.signed)verifyDirectExitRecord(row,config.origin);
        // A late signature is retained for audit, but must not lock the position
        // forever when its delivery window closed before any executor saw it.
        // Submitted/unknown outcomes still require positive chain evidence.
        if(['signing','uncertain','signed'].includes(row.state)&&!row.deliveryId&&row.review&&
          Math.min(row.terms.expiresAt,row.review.intent.expiresAt)<=Date.now()&&
          await config.store.expireUndelivered(row)){counts.expired++;continue;}
        if(!row.signed){counts.pending++;continue;}
        let reply:unknown=null;
        try{reply=await config.rpc('getTransaction',[row.transactionSignature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]);}
        catch{signal.throwIfAborted();}
        // Only a missing/unavailable index permits the block fallback. A
        // contradictory receipt fails validation and is never overwritten.
        if(reply===null&&config.blockRpc){
          const recovered=await recoverSignedFromFinalizedBlock({signature:row.transactionSignature!,signed:row.signed!,minContextSlot:row.watermark.slot},config.blockRpc);
          reply=recovered.reply;
        }
        signal.throwIfAborted();
        if(reply===null){counts.pending++;continue;}
        const outcome=verifyDirectExitLanded(row,reply,config.origin);
        await config.store.settle(row,outcome);counts.settled++;
      }catch{signal.throwIfAborted();counts.refused++;}
    }
    return counts;
  };
}
