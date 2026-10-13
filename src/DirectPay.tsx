import {useEffect,useRef,useState} from 'react';
import {useWalletSetup} from './WalletSetup';
import {inspectPayTransfer,type PayTransferReview} from './pay-transfer-model';
import {paymentReference,paymentRawAmount,validPaymentSignature,type PayTerms,type PaymentReceipt} from './pay-verification';
import {USDC} from './funding-model';
import {payAmount,payShares} from './pay-model';
import {isMint} from './assets';
type Payment={state:'pending'|'verified'|'failed'|'expired_unresolved';signature:string;sender:string;reference:string;receipt:PaymentReceipt|null};
type Result={review?:PayTransferReview;payment?:Payment|null;externalReceipt?:PaymentReceipt};
type Packet={review:PayTransferReview;signed:string};
async function api(body:object,signal?:AbortSignal):Promise<Result>{const r=await fetch('/api/pay-transfer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.any([AbortSignal.timeout(45000),...(signal?[signal]:[])])});const result=await r.json();if(!r.ok)throw Error(typeof result.message==='string'?result.message:'Payment unavailable. Check its status.');return result;}
export function DirectPay({terms,onVerified,onLocked}:{terms:PayTerms;onVerified:(receipt:PaymentReceipt,justPaid?:boolean)=>void;onLocked:(locked:boolean)=>void}){
 const {connection,openConnect}=useWalletSetup(),owner=connection.session?.address;
 const [statusReady,setStatusReady]=useState(false);
 const [blockedLocal,setBlockedLocal]=useState(false);
 const [enabled,setEnabled]=useState(false),[review,setReview]=useState<PayTransferReview|null>(null),[payment,setPayment]=useState<Payment|null>(null),[busy,setBusy]=useState(''),[error,setError]=useState(''),[packet,setPacket]=useState<Packet|null>(null);
 const active=useRef(owner);active.current=owner;const generation=useRef(0),task=useRef<number|null>(null),alive=useRef(true),key=useRef(''),ref=useRef('');
 const manual=useRef<AbortController|null>(null),background=useRef<AbortController|null>(null);
 const termsKey=JSON.stringify(terms);
 const initiated=useRef(false);
 useEffect(()=>{onLocked(enabled&&!statusReady||blockedLocal||!!packet||!!payment&&payment.state!=='failed');},[enabled,statusReady,blockedLocal,packet,payment,onLocked]);
 function receipt(r:PaymentReceipt){if(r.status!=='verified'||r.reference!==ref.current||r.recipient!==terms.recipient||r.mint!==USDC||r.rawAmount!==paymentRawAmount(terms)||!validPaymentSignature(r.signature)||!isMint(r.sender)||!Number.isSafeInteger(r.slot)||r.slot<0||!(r.blockTime===null||Number.isSafeInteger(r.blockTime)&&r.blockTime>=0))throw Error('Payment receipt could not be verified.');onVerified(r,initiated.current);initiated.current=false;setReview(null);setPacket(null);try{localStorage.removeItem(key.current);}catch{/* The finalized server record still prevents another payment. */}}
 function accept(result:Result){
  if(result.externalReceipt){receipt(result.externalReceipt);return;}
  if(result.payment){const p=result.payment;if(!['pending','verified','failed','expired_unresolved'].includes(p.state)||!validPaymentSignature(p.signature)||!isMint(p.sender)||p.reference!==ref.current)throw Error('Payment status could not be verified.');if(p.state==='verified'){if(!p.receipt||p.receipt.signature!==p.signature||p.receipt.sender!==p.sender)throw Error('Payment receipt is missing or changed.');receipt(p.receipt);}setPayment(p);setReview(null);if(p.state==='failed'){initiated.current=false;setPacket(null);try{localStorage.removeItem(key.current);}catch{}}}
 }
 useEffect(()=>{generation.current++;alive.current=true;manual.current?.abort();background.current?.abort();task.current=null;const c=new AbortController();setBusy('');setReview(null);setPacket(null);setPayment(null);setError('');setBlockedLocal(false);setStatusReady(false);setEnabled(false);initiated.current=false;
  void (async()=>{const reference=await paymentReference(terms);if(c.signal.aborted)return;ref.current=reference;key.current='fub.pay.packet.v1:'+reference;
   let saved:string|null=null;try{saved=localStorage.getItem(key.current);}catch{setBlockedLocal(true);throw Error('Payment storage is unavailable.');}if(saved){try{const p=JSON.parse(saved) as Packet;await inspectPayTransfer(p.review,p.review.sender,terms,p.signed,false);if(!c.signal.aborted)setPacket(p);}catch{if(!c.signal.aborted){setBlockedLocal(true);setError('The saved payment could not be read. Check its status before making another payment.');}}}
   const r=await fetch('/api/pay-transfer',{signal:c.signal});const config=await r.json();if(c.signal.aborted)return;const allowed=config.enabled===true&&(!config.pilotWallet||config.pilotWallet===owner);setEnabled(allowed);if(!allowed&&!saved)return;
   const status=await api({action:'status',terms},c.signal);if(!c.signal.aborted){accept(status);setStatusReady(true);}
  })().catch(()=>{if(!c.signal.aborted)setError('Payment status is unavailable. Check again before sending.');});
  return()=>{alive.current=false;generation.current++;c.abort();manual.current?.abort();background.current?.abort();};
 // Terms are a stable share identity; the parent remounts on share changes.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[termsKey,owner]);
 async function run(label:string,job:(expected:string|undefined,epoch:number,signal:AbortSignal)=>Promise<void>){
  if(task.current!==null)return;const epoch=generation.current,expected=owner,controller=new AbortController();
  task.current=epoch;manual.current=controller;background.current?.abort();setBusy(label);setError('');
  try{await job(expected,epoch,controller.signal);}catch(e){
   if(alive.current&&generation.current===epoch&&active.current===expected&&!controller.signal.aborted){setError(e instanceof Error?e.message:'Payment status is unknown. Check before retrying.');if(e instanceof Error&&e.message.includes('Refresh the payment review'))setReview(null);}
  }finally{if(task.current===epoch)task.current=null;if(manual.current===controller)manual.current=null;if(alive.current&&generation.current===epoch)setBusy('');}
 }
 function guard(expected:string|undefined,epoch:number){if(!alive.current||generation.current!==epoch||active.current!==expected)throw Error('Wallet changed. Check the recorded payment before retrying.');}
 async function prepare(){await run('Checking payment…',async(expected,epoch,signal)=>{if(!expected)throw Error('Connect your wallet first.');if(!statusReady)throw Error('Check payment status before preparing a payment.');if(blockedLocal)throw Error('Resolve the saved payment record before preparing another payment.');if(packet)throw Error('A signed payment is saved. Check or retry it first.');const result=await api({action:'prepare',sender:expected,terms},signal);guard(expected,epoch);if(result.review){await inspectPayTransfer(result.review,expected,terms);guard(expected,epoch);setReview(result.review);}else accept(result);});}
 async function send(){await run('Waiting for wallet…',async(expected,epoch,signal)=>{if(!expected||!review)throw Error('Review this payment first.');const signed=await connection.signPayTransfer(review,terms);guard(expected,epoch);initiated.current=true;await inspectPayTransfer(review,expected,terms,signed,true);guard(expected,epoch);const p={review,signed};localStorage.setItem(key.current,JSON.stringify(p));if(localStorage.getItem(key.current)!==JSON.stringify(p))throw Error('This browser cannot retain the signed payment. Nothing was submitted.');setPacket(p);setReview(null);setBusy('Submitting payment…');const result=await api({action:'submit',...p},signal);guard(expected,epoch);accept(result);});}
 async function check(){await run('Checking payment…',async(expected,epoch,signal)=>{const result=await api({action:'status',terms},signal);guard(expected,epoch);accept(result);setStatusReady(true);if(!result.payment&&!result.externalReceipt)setError(packet?'The signed payment is saved on this device. Retry its submission below.':'No payment is recorded yet.');});}
 async function retry(){await run('Retrying saved payment…',async(expected,epoch,signal)=>{if(!packet||packet.review.sender!==expected)throw Error('Reconnect the wallet that signed this payment.');await inspectPayTransfer(packet.review,expected,terms,packet.signed,false);guard(expected,epoch);initiated.current=true;const result=await api({action:'submit',...packet},signal);guard(expected,epoch);accept(result);});}
 useEffect(()=>{
  if(payment?.state!=='pending')return;const epoch=generation.current;let checks=0,inFlight=false,stopped=false,read:AbortController|null=null;
  const timer=setInterval(()=>{if(document.visibilityState!=='visible'||task.current!==null||inFlight)return;if(++checks>24){clearInterval(timer);return;}inFlight=true;
   const controller=new AbortController();read=controller;background.current=controller;
   void api({action:'status',terms},controller.signal).then(result=>{if(!stopped&&!controller.signal.aborted&&generation.current===epoch)accept(result);}).catch(()=>{/* Retain the pending packet; manual recovery remains available. */}).finally(()=>{inFlight=false;if(background.current===controller)background.current=null;});
  },5000);
  return()=>{stopped=true;clearInterval(timer);read?.abort();};
 // Poll only an already-signed payment. No preparation, signature or broadcast.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[payment?.signature,payment?.state,termsKey,owner]);
 if(!enabled&&!packet&&!blockedLocal)return null;
 return <section className="pay-verification" aria-label="Pay with connected wallet"><h3>Pay this share</h3>
 {!owner?<button className="button primary" onClick={openConnect}>Use your Fomo wallet</button>:<p className="pay-note">From {owner}</p>}
 {error&&<p role="alert" className="form-error">{error}</p>}
 {payment?.state==='verified'?<p role="status">Payment finalized on Solana.</p>:<>
 {review&&<dl className="pay-details"><div><dt>Send</dt><dd>{payAmount(payShares(terms.cents,terms.people)[terms.index])} USDC</dd></div><div><dt>To</dt><dd>{terms.recipient}</dd></div><div><dt>Network fee</dt><dd>{(Number(review.feeLamports)/1e9).toFixed(9)} SOL</dd></div>{review.rentLamports!=='0'&&<div><dt>Receiving token account</dt><dd>Up to {(Number(review.rentLamports)/1e9).toFixed(9)} SOL</dd></div>}</dl>}
 {payment&&<p role="status" className="pay-note">{payment.state==='pending'?'Your signed payment is saved. Confirmation is pending.':payment.state==='failed'?'The transaction failed on Solana. It did not transfer this share. Network fees may still apply.':'Delivery is unresolved after expiry. A new payment is blocked until this transaction is resolved.'} <a href={`https://solscan.io/tx/${payment.signature}`} target="_blank" rel="noreferrer">View transaction</a></p>}
 <div className="pay-request-actions">
 {enabled&&owner&&statusReady&&!blockedLocal&&!packet&&(!payment||payment.state==='failed')&&<button className="button primary" disabled={!!busy} onClick={()=>void(review?send():prepare())}>{busy|| (review?'Approve payment':'Review payment')}</button>}
 {(packet||payment||!statusReady||blockedLocal)&&<button className="button secondary" disabled={!!busy} onClick={()=>void check()}>{busy||'Check payment status'}</button>}
 {packet&&packet.review.sender===owner&&(!payment||payment.state==='pending')&&<button className="button secondary" disabled={!!busy} onClick={()=>void retry()}>Retry same signed payment</button>}
 </div></>}
 </section>;
}
