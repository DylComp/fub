import {paymentReference,type TransferTerms,type PaymentCheck} from '../src/pay-verification.js';
import {inspectPayTransfer,type PayTransferReview} from '../src/pay-transfer-model.js';
import {preparePayTransfer,simulatePayTransfer} from './pay-transfer-chain.js';
import {verifyPayment,checkPayment} from './pay-receipt.js';
import {MAINNET_GENESIS} from './solana-network.js';
import type {Rpc} from './funding.js';
import type {PayTransferStore,SavedPayTransfer} from './pay-transfer-store.js';
export function publicPayTransfer(saved:SavedPayTransfer){return {state:saved.state,signature:saved.signature,sender:saved.review.sender,reference:saved.review.reference,receipt:saved.receipt};}
export function payTransferService(store:PayTransferStore,rpc:Rpc,operations={prepare:preparePayTransfer,simulate:simulatePayTransfer,verify:verifyPayment,check:checkPayment}){
 async function reconcile(saved:SavedPayTransfer){
  if(saved.state==='verified'||saved.state==='failed')return saved;
  const check=await operations.verify(saved.review.terms,saved.signature,rpc);
  if(check.status==='verified')return store.settle(saved.review.reference,saved.signature,'verified',check);
  if(check.status==='failed')return store.settle(saved.review.reference,saved.signature,'failed');
  // Expiry alone never proves non-delivery. Keep this share locked until a
  // finalized receipt resolves it, even if a provider temporarily loses history.
  if(await rpc('getGenesisHash',[])!==MAINNET_GENESIS)throw Error('Solana mainnet is required.');
  const height=await rpc('getBlockHeight',[{commitment:'finalized',minContextSlot:saved.review.slot}]);
  if(!Number.isSafeInteger(height)||Number(height)<1)throw Error('Payment block height unavailable.');
  if(Number(height)>saved.review.lastValidBlockHeight)return store.settle(saved.review.reference,saved.signature,'expired_unresolved');
  return saved;
 }
 return {
  async status(terms:TransferTerms){const saved=await store.get(await paymentReference(terms));return saved?{payment:publicPayTransfer(await reconcile(saved))}:{payment:null};},
  async prepare(sender:string,terms:TransferTerms){
   const saved=await store.get(await paymentReference(terms));if(saved){const current=await reconcile(saved);if(current.state!=='failed')return {payment:publicPayTransfer(current)};}
   const check=await operations.check(terms,undefined,rpc);if(check.status==='verified')return {externalReceipt:check};
   return {review:await operations.prepare(sender,terms,rpc)};
  },
  async submit(review:PayTransferReview,signed:string,beforeBroadcast?:()=>Promise<void>){
   const signature=await inspectPayTransfer(review,review.sender,review.terms,signed,false);
   let saved=await store.get(review.reference);
   if(!saved||saved.signature!==signature){
    if(saved&&saved.state!=='failed')return {payment:publicPayTransfer(await reconcile(saved))};
    // A fixed-amount, already-signed USDC transfer has no price quote to age.
    // Fresh simulation below checks its blockhash and exact costs. Rejecting by
    // UI review age here would strand a packet during an ordinary slow request.
    const external:PaymentCheck=await operations.check(review.terms,undefined,rpc);if(external.status==='verified')return {externalReceipt:external};
    await operations.simulate(review,rpc,signed);
    saved=await store.bind(review,signed); // Durable bytes BEFORE any broadcast.
   }
   if(saved.signed!==signed)throw Error('Payment packet changed.');
   saved=await reconcile(saved);
   if(saved.state==='pending'){
    if(beforeBroadcast)await beforeBroadcast();
    try {const sent=await rpc('sendTransaction',[saved.signed,{encoding:'base64',skipPreflight:false,preflightCommitment:'confirmed',minContextSlot:saved.review.slot}]);if(sent!==saved.signature)throw Error('Unexpected submission acknowledgement.');}
    catch {/* Delivery may be uncertain. Preserve the packet and return its ID. */}
   }
   return {payment:publicPayTransfer(saved)};
  }
 };
}
