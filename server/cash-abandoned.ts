import {VersionedTransaction} from '@solana/web3.js';
import {cashDepositTransaction,inspectSignedCashDeposit,type CashDepositReview} from './cash-deposit.js';
import {MAINNET_GENESIS} from './solana-network.js';
import type {Rpc} from './funding.js';
// A browser may sign/broadcast and disappear before reporting the signature.
// Expiry alone is insufficient: scan finalized source history before releasing
// an unsigned reservation. Missing/pruned/bounded-out history stays unresolved.
export async function recoverUnreportedCashDeposit(review:CashDepositReview,rpc:Rpc):Promise<{state:'pending'}|{state:'expired'}|{state:'found';signed:string}>{
 if(await rpc('getGenesisHash',[])!==MAINNET_GENESIS)throw Error('Wrong cash recovery network.');
 const height=await rpc('getBlockHeight',[{commitment:'finalized'}]);
 if(!Number.isSafeInteger(height)||Number(height)<=review.lastValidBlockHeight)return {state:'pending'};
 const [finalSlot,firstSlot]=await Promise.all([rpc('getSlot',[{commitment:'finalized'}]),rpc('getFirstAvailableBlock',[])]);
 if(!Number.isSafeInteger(finalSlot)||Number(finalSlot)<review.slot||!Number.isSafeInteger(firstSlot)||Number(firstSlot)>review.slot)return {state:'pending'};
 const deadline=Date.now()+15000;
 const expected=cashDepositTransaction(review.quote,review.blockhash,review.version);
 const deposit=expected.message.compiledInstructions.at(-1)!;
 let before:string|undefined,previousSlot=Number.MAX_SAFE_INTEGER;
 const seen=new Set<string>();
 for(let page=0;page<3;page++){
  const rows=await rpc('getSignaturesForAddress',[review.quote.sourceWallet,{commitment:'finalized',minContextSlot:finalSlot,limit:100,...(before?{before}:{})}]) as any;
  if(!Array.isArray(rows)||rows.length>100)throw Error('Cash history unavailable.');
  for(const row of rows){
   if(Date.now()>=deadline)return {state:'pending'};
   if(typeof row.signature!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(row.signature)||!Number.isSafeInteger(row.slot)||row.slot<0||row.slot>previousSlot||seen.has(row.signature)||row.confirmationStatus!=='finalized')throw Error('Invalid cash history.');
   previousSlot=row.slot;seen.add(row.signature);
   if(row.slot<review.slot)return {state:'expired'};
   const tx=await rpc('getTransaction',[row.signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]) as any;
   if(!tx||tx.slot!==row.slot||!Array.isArray(tx.transaction)||tx.transaction[1]!=='base64'||typeof tx.transaction[0]!=='string'||tx.transaction[0].length>1700)return {state:'pending'};
   const bytes=Buffer.from(tx.transaction[0],'base64');if(bytes.toString('base64')!==tx.transaction[0])throw Error('Invalid cash history bytes.');
   const decoded=VersionedTransaction.deserialize(bytes);
   // A wallet may add guards while preserving the deposit. Match the unique
   // Relay order bytes first, then verify the full signed transaction. A
   // payment with unrecognized edits stays unresolved instead of permitting
   // another purchase after expiry.
   if(decoded.message.compiledInstructions.some(ix=>Buffer.from(ix.data).equals(Buffer.from(deposit.data)))){
    let signature:string;
    try{signature=inspectSignedCashDeposit(review,tx.transaction[0]);}catch{return {state:'pending'};}
    if(signature!==row.signature)throw Error('Cash recovery signature mismatch.');
    return {state:'found',signed:tx.transaction[0]};
   }
  }
  if(rows.length<100)return {state:'expired'};
  before=rows.at(-1).signature;
 }
 return {state:'pending'};
}
