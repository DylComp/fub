import {Connection,PublicKey,AddressLookupTableProgram,AddressLookupTableAccount,VersionedTransaction,type VersionedTransactionResponse} from '@solana/web3.js';
import {MAINNET_GENESIS} from './solana-network.js';
import {verifyTableSigned,type LaunchTableAttempt,type LaunchTableReceipt,launchTableStore} from './pump-pair-table-journal.js';
import {recoverWorkerReceipt} from './worker-block-recovery.js';
import type {Rpc} from './funding.js';
export function finalizedTableReceipt(a:LaunchTableAttempt,tx:VersionedTransactionResponse):LaunchTableReceipt{
 if(!a.signed||!a.signature||verifyTableSigned(a.intent,a.plan,a.signed)!==a.signature)throw Error('Table signature unavailable.');
 const expected=VersionedTransaction.deserialize(Buffer.from(a.signed,'base64')),m=tx.meta,keys=tx.transaction.message.staticAccountKeys;
 if(!m||!Number.isSafeInteger(tx.slot)||tx.slot<a.plan.slot||tx.transaction.signatures[0]!==a.signature||!Buffer.from(tx.transaction.message.serialize()).equals(Buffer.from(expected.message.serialize()))||m.fee!==a.plan.feeLamports||m.preBalances.length!==keys.length||m.postBalances.length!==keys.length||m.loadedAddresses&&(m.loadedAddresses.readonly.length||m.loadedAddresses.writable.length))throw Error('Table receipt does not match review.');
 const tableIndex=keys.findIndex(k=>k.toBase58()===a.plan.table);
 if(tableIndex<1||keys[0].toBase58()!==a.plan.owner)throw Error('Table receipt accounts mismatch.');
 for(let i=0;i<keys.length;i++){
  if(!Number.isSafeInteger(m.preBalances[i])||!Number.isSafeInteger(m.postBalances[i])||m.preBalances[i]<0||m.postBalances[i]<0)throw Error('Invalid table receipt balances.');
  const change=i===0?a.plan.feeLamports+(m.err?0:a.plan.rentLamports):i===tableIndex&&!m.err?-a.plan.rentLamports:0;
  if(m.preBalances[i]-m.postBalances[i]!==change)throw Error('Unexpected table setup spending.');
 }
 if(!m.err&&m.preBalances[tableIndex]!==0)throw Error('Table already existed.');
 return{slot:tx.slot,debitLamports:a.plan.feeLamports+(m.err?0:a.plan.rentLamports),table:a.plan.table,success:!m.err};
}
export function launchTableChain(c:Connection,recoveryRpc?:()=>Rpc){
 const mainnet=async()=>{if(await c.getGenesisHash()!==MAINNET_GENESIS)throw Error('Mainnet required.');};
 return{
  async expiredUnsigned(a:LaunchTableAttempt){
   await mainnet();if(a.state!=='prepared'||a.signature||a.signed)throw Error('Signed pair setup cannot be refreshed.');
   const epoch=await c.getEpochInfo('finalized');
   if(!Number.isSafeInteger(epoch.blockHeight)||epoch.blockHeight!<=a.plan.lastValidBlockHeight)return null;
   const r=await c.getAccountInfoAndContext(new PublicKey(a.plan.table),{commitment:'finalized',minContextSlot:epoch.absoluteSlot});
   if(r.context.slot<epoch.absoluteSlot||r.value)throw Error('Previous pair table already exists or absence is unverified.');
   return{blockHeight:epoch.blockHeight!,slot:r.context.slot};
  },
  async reconcile(a:LaunchTableAttempt){
   await mainnet();if(!a.signed||!a.signature||verifyTableSigned(a.intent,a.plan,a.signed)!==a.signature)throw Error('Signed table evidence missing.');
   let tx=await c.getTransaction(a.signature,{commitment:'finalized',maxSupportedTransactionVersion:0}).catch(error=>{if(!recoveryRpc)throw error;return null;});
   if(!tx&&recoveryRpc)tx=await recoverWorkerReceipt({signature:a.signature,signed:a.signed,minContextSlot:a.plan.slot},recoveryRpc());
   if(!tx)return{state:await c.getBlockHeight('finalized')>a.plan.lastValidBlockHeight?'expired_unresolved':'pending'} as const;
   const receipt=finalizedTableReceipt(a,tx);
   if(receipt.success){
    const r=await c.getAccountInfoAndContext(new PublicKey(a.plan.table),{commitment:'finalized',minContextSlot:tx.slot});
    if(r.context.slot<tx.slot||!r.value||!r.value.owner.equals(AddressLookupTableProgram.programId)||r.value.executable||r.value.lamports<a.plan.rentLamports)throw Error('Finalized table account mismatch.');
    const s=AddressLookupTableAccount.deserialize(r.value.data);
    if(s.authority||s.deactivationSlot!==18446744073709551615n||s.lastExtendedSlot>=r.context.slot||s.addresses.map(a=>a.toBase58()).join()!==a.plan.addresses.join())throw Error('Finalized table is not frozen and active.');
   }
   return{state:receipt.success?'confirmed':'failed',receipt} as const;
  },
  async send(a:LaunchTableAttempt){
   await mainnet();if(!a.signed||verifyTableSigned(a.intent,a.plan,a.signed)!==a.signature)throw Error('Table signature mismatch.');
   if(await c.getBlockHeight('confirmed')>a.plan.lastValidBlockHeight)return'expired' as const;
   if(await c.sendRawTransaction(Buffer.from(a.signed,'base64'),{skipPreflight:false,preflightCommitment:'confirmed'})!==a.signature)throw Error('Table submission mismatch.');return'sent' as const;
  }
 };
}
export function launchTableService(store:ReturnType<typeof launchTableStore>,chain:ReturnType<typeof launchTableChain>,enabled:()=>boolean){
 const recover=async(id:string,owner:string,send=false)=>{
  const claimed=await store.claim(id,owner);if(!claimed)return store.get(id,owner);
  const {attempt:a,lease}=claimed;
  try{
   const r=await chain.reconcile(a);
   // A lagging provider cannot reopen an unresolved expired attempt.
   if(a.state==='expired_unresolved'&&r.state==='pending')await store.settle(id,lease,'expired_unresolved');
   else await store.settle(id,lease,r.state,'receipt'in r?r.receipt:undefined);
   if(send&&r.state==='pending'&&a.state==='pending'&&enabled()&&await store.maySend(id,lease))await chain.send(a);
   return await store.get(id,owner);
  }catch(error){await store.failedCheck(id,lease);throw error;}finally{await store.release(id,lease);}
 };
 return{recover,async sweep(signal:AbortSignal){
  signal.throwIfAborted();const due=await store.due(),results:{id:string;checked:boolean}[]=[];
  for(const a of due){if(signal.aborted)break;try{await recover(a.id,a.owner);results.push({id:a.id,checked:true});}catch{results.push({id:a.id,checked:false});}}
  return results;
 },async refreshUnsigned(a:LaunchTableAttempt,prepare:()=>Promise<LaunchTableAttempt['plan']>){const proof=await chain.expiredUnsigned(a);return proof?store.refreshUnsigned(a,await prepare(),proof):a;},async submit(id:string,owner:string,signed:string){await store.bind(id,owner,signed);return recover(id,owner,true);}};
}
