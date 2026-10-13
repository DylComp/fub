import {useCompletedTask} from "../task-completion";
import {useVisibleRefresh} from '../useVisibleRefresh';
import {purchaseSplitDraft,PURCHASE_SPLIT_KEY} from '../pay-purchase-split';
import {MerchantLogo} from './MerchantLogo';
import {useEffect,useRef,useState} from 'react';
import {useWalletSetup} from '../WalletSetup';
import {walletSessionRequest} from '../wallet-session-client';
import {verifyWalletLogin,type WalletLogin} from '../wallet-session-model';
import {giftStatus,usdcDisplay,type GiftOrder,type GiftSelection} from '../gift-checkout-model';
import {inspectPayTransfer,type PayTransferReview} from '../pay-transfer-model';
import {giftPaymentResult,loadGiftCheckoutRecovery,shouldRefreshGiftOrder,type GiftCheckoutResult,type GiftStatusChecks} from '../gift-checkout-recovery';
import {giftFundingAmount,type GiftFundingReadiness} from '../gift-funding-model';
type Session={address:string|null;csrf?:string};
type Payment={state:string;signature:string};
type Packet={review:PayTransferReview;signed:string};
type Result=GiftCheckoutResult;
type Product={id:string;name:string;country:string;currency:string;recipientType:string;requiresPrepayment:boolean;paymentMethods:string[];packages:{value:string;currency:string;price:string;priceCurrency:string}[]};
async function request(csrf:string,body:object,signal?:AbortSignal):Promise<Result>{const timeout=AbortSignal.timeout(45000);const r=await fetch('/api/gift-checkout',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-Fomo-Request':'1','X-Fub-Csrf':csrf},body:JSON.stringify(body),signal:signal?AbortSignal.any([signal,timeout]):timeout});const result=await r.json();if(!r.ok)throw Error(result.message||'Purchase unavailable. Check its status.');return result;}
export function GiftCheckout({product,country,onDelivered}:{product:Product|null;country:string;onDelivered?:()=>void}){
 const {connection,openConnect}=useWalletSetup(),owner=connection.session?.address;
 const [enabled,setEnabled]=useState(false),[value,setValue]=useState(''),[email,setEmail]=useState(''),[agreed,setAgreed]=useState(false);
 const [orders,setOrders]=useState<GiftOrder[]>([]),[order,setOrder]=useState<GiftOrder|null>(null),[payment,setPayment]=useState<Payment|null>(null),[review,setReview]=useState<PayTransferReview|null>(null),[packet,setPacket]=useState<Packet|null>(null);
 const [busy,setBusy]=useState(''),[error,setError]=useState(''),[tick,setTick]=useState(Date.now());
 const [historyReady,setHistoryReady]=useState(false);
 const [checks,setChecks]=useState<GiftStatusChecks|null>(null);
 const [funding,setFunding]=useState<GiftFundingReadiness|null>(null);
 const [refreshError,setRefreshError]=useState('');
 const background=useRef<AbortController|null>(null);
 const checkoutRef=useRef<HTMLElement>(null);
 useCompletedTask(order?.status==='complete'&&order.delivery?.status==='delivered'?order.id:null,()=>{onDelivered?.();checkoutRef.current?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});});
 const orderRef=useRef(order?.id);orderRef.current=order?.id;
 const generation=useRef(0),active=useRef(owner),task=useRef<symbol|null>(null),session=useRef<Session|null>(null);active.current=owner;
 useEffect(()=>{const c=new AbortController();fetch('/api/gift-checkout',{signal:c.signal}).then(r=>r.json()).then(v=>{if(!c.signal.aborted)setEnabled(v.enabled===true);}).catch(()=>{});return()=>c.abort();},[]);
 useEffect(()=>{
  setValue('');setAgreed(false);setFunding(null);
  // Selecting another product leaves a delivered receipt in history. Never
  // replace an invoice with a pending payment or unresolved delivery.
  if(product&&order?.status==='complete'&&order.delivery?.status==='delivered'){
   setOrder(null);setReview(null);setPayment(null);setPacket(null);setError('');setChecks(null);
  }
 },[product?.id,country]);
 useEffect(()=>{generation.current++;task.current=null;background.current?.abort();session.current=null;setOrders([]);setOrder(null);setReview(null);setPayment(null);setPacket(null);setError('');setBusy('');setHistoryReady(false);setChecks(null);setFunding(null);setRefreshError('');},[owner]);
 useEffect(()=>()=>{generation.current++;task.current=null;background.current?.abort();},[]);
 const supported=product&&product.country===country&&product.recipientType==='none'&&!product.requiresPrepayment&&product.paymentMethods.includes('usdc_solana');
 const packetKey=(id:string)=>`fub.gift.packet.v1:${owner}:${id}`;
 async function authenticate(check:()=>void){
  if(!owner)throw Error('Connect your Fomo wallet first.');
  let s=await walletSessionRequest<Session>('status');check();
  if(s.address!==owner||!s.csrf){const r=await walletSessionRequest<{challenge:WalletLogin;message:string}>('challenge',{wallet:owner});check();const challenge=verifyWalletLogin(r,owner,location.origin),signature=await connection.signWalletSession(challenge);check();s=await walletSessionRequest<Session>('verify',{wallet:owner,signature});check();}
  if(s.address!==owner||!s.csrf)throw Error('Wallet sign-in could not be confirmed.');session.current=s;return s.csrf;
 }
 async function run(label:string,job:(csrf:string,check:()=>void)=>Promise<void>){if(task.current)return;background.current?.abort();const operation=Symbol();task.current=operation;const gen=generation.current,expected=owner;setBusy(label);setError('');const check=()=>{if(gen!==generation.current||active.current!==expected)throw Error('Wallet changed. Reopen your purchase history.');};try{const csrf=await authenticate(check);check();await job(csrf,check);}catch(e){if(gen===generation.current)setError(e instanceof Error?e.message:'Purchase unavailable.');}finally{if(task.current===operation){task.current=null;if(gen===generation.current)setBusy('');}}}
 function accept(r:Result){
  setRefreshError('');
  if(r.checks)setChecks(r.checks);
  if(r.funding)setFunding(r.funding);
  else if(r.order&&orderRef.current!==r.order.id)setFunding(null);
  if(r.order){setOrder(r.order);setOrders(old=>[r.order!,...old.filter(o=>o.id!==r.order!.id)]);}
  const state=giftPaymentResult(r);
  if('payment'in r||state.externalReceipt)setPayment(state.externalReceipt?{state:'verified',signature:''}:state.payment);
  if(state.terminal){setPacket(null);setReview(null);if(r.order)try{localStorage.removeItem(packetKey(r.order.id));}catch{/* The server record still prevents another payment. */}}
 }
 async function restorePacket(r:Result,check:()=>void){
  if(!r.order?.terms||giftPaymentResult(r).terminal)return;
  const raw=localStorage.getItem(packetKey(r.order.id));if(!raw)return;
  const saved=JSON.parse(raw) as Packet;await inspectPayTransfer(saved.review,owner!,r.order.terms,saved.signed,false);check();setPacket(saved);
 }
 async function recover(csrf:string,check:()=>void){
  const savedId=localStorage.getItem(`fub.gift.last:${owner}`);
  const restored=await loadGiftCheckoutRecovery(body=>request(csrf,body),savedId,check);
  setOrders(restored.orders);setHistoryReady(true);
  if(restored.result){accept(restored.result);await restorePacket(restored.result,check);}
  return !!restored.result;
 }
 async function history(){await run('Opening purchases…',async(csrf,check)=>{await recover(csrf,check);});}
 async function open(id:string){await run('Checking purchase…',async(csrf,check)=>{setReview(null);if(order?.id!==id){setPacket(null);setPayment(null);setOrder(null);setChecks(null);setFunding(null);}const r=await request(csrf,{action:'status',id});check();accept(r);await restorePacket(r,check);});}
 // Existing wallet sessions restore receipts without another signature. If the
 // session expired, the user explicitly opens history or checkout to sign in.
 useEffect(()=>{
  if(!enabled||!owner)return;let stopped=false;const gen=generation.current;
  const check=()=>{if(stopped||gen!==generation.current||active.current!==owner)throw Error('Wallet changed.');};
  void(async()=>{const current=await walletSessionRequest<Session>('status');check();
   if(current.address!==owner||!current.csrf||task.current)return;
   const operation=Symbol();task.current=operation;setBusy('Checking purchases…');session.current=current;
   try{await recover(current.csrf,check);}finally{if(task.current===operation){task.current=null;if(!stopped&&gen===generation.current)setBusy('');}}
  })().catch(()=>{if(!stopped&&gen===generation.current)setError('Could not restore purchases. Open purchase history before paying again.');});
  return()=>{stopped=true;};
 // Wallet changes cancel restoration before any receipt enters the new view.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[owner,enabled]);
 async function create(){await run('Creating invoice…',async(csrf,check)=>{if(await recover(csrf,check))return;if(!supported||!value||!agreed)throw Error('Choose an amount and review the merchant terms.');const selection:GiftSelection={product:product!.id,value,country,email:email.trim()};const id=crypto.randomUUID();
  // Keep the request ID before calling the non-idempotent invoice endpoint.
  localStorage.setItem(`fub.gift.last:${owner}`,id);
  const r=await request(csrf,{action:'create',id,selection});check();accept(r);if(r.order){const current=await request(csrf,{action:'status',id});check();accept(current);}
 });}
 async function prepare(){await run('Checking payment balance…',async(csrf,check)=>{if(!order?.terms||packet)throw Error('Check the saved payment first.');setReview(null);const r=await request(csrf,{action:'prepare',id:order.id});check();accept(r);if(r.review){await inspectPayTransfer(r.review,owner!,order.terms);check();setReview(r.review);}});}
 async function pay(){await run('Waiting for wallet…',async(csrf,check)=>{if(!order?.terms||!review)throw Error('Review this purchase first.');await inspectPayTransfer(review,owner!,order.terms);check();const signed=await connection.signPayTransfer(review,order.terms);check();const saved={review,signed};localStorage.setItem(packetKey(order.id),JSON.stringify(saved));if(localStorage.getItem(packetKey(order.id))!==JSON.stringify(saved))throw Error('Signed payment could not be saved. Nothing was submitted.');setPacket(saved);setReview(null);setBusy('Submitting payment…');const r=await request(csrf,{action:'submit',id:order.id,...saved});check();accept(r);});}
 async function retry(){await run('Checking saved payment…',async(csrf,check)=>{if(!order||!packet)throw Error('No saved payment.');const r=await request(csrf,{action:'submit',id:order.id,...packet});check();accept(r);});}
 async function close(){await run('Closing expired invoice…',async(csrf,check)=>{if(!order)return;await request(csrf,{action:'close',id:order.id});check();try{if(localStorage.getItem(`fub.gift.last:${owner}`)===order.id)localStorage.removeItem(`fub.gift.last:${owner}`);}catch{}setOrder(null);setPacket(null);setReview(null);setPayment(null);setChecks(null);setFunding(null);const r=await request(csrf,{action:'list'});check();setOrders(r.orders||[]);});}
 useEffect(()=>{if(!order?.expiresAt)return;const timer=setInterval(()=>setTick(Date.now()),1000);return()=>clearInterval(timer);},[order?.expiresAt]);
 useVisibleRefresh(!!order&&!!session.current?.csrf&&shouldRefreshGiftOrder(order),(owner||'')+':'+order?.id,order?.status==='unpaid'&&!payment?15000:5000,async signal=>{
  if(!order||!session.current?.csrf||task.current)return;
  const gen=generation.current,id=order.id,c=new AbortController();background.current=c;
  const active=AbortSignal.any([signal,c.signal]),valid=()=>!active.aborted&&gen===generation.current&&orderRef.current===id;
  try{const r=await request(session.current.csrf,{action:'status',id},active);if(valid())accept(r);}
  catch(e){if(valid()){setRefreshError('Purchase updates are temporarily unavailable. Your saved receipt is unchanged.');setChecks({delivery:'unavailable',payment:'unavailable'});}throw e;}
  finally{if(background.current===c)background.current=null;}
 });
 if(!enabled)return null;
 const expiry=order?.expiresAt?Math.max(0,Math.ceil((order.expiresAt-tick)/1000)):0;
 const checksAvailable=checks?.delivery!=='unavailable'&&checks?.payment!=='unavailable';
 const payable=checksAvailable&&order?.status==='unpaid'&&expiry>90&&!packet&&(!payment||payment.state==='failed');
 return <section ref={checkoutRef} className="bitrefill-checkout" aria-labelledby="gift-checkout-title"><div className="bitrefill-detail-heading"><h2 id="gift-checkout-title">{order?.status==='complete'?'Your gift-card receipt':order?'Your purchase':'Pay from your Fomo wallet'}</h2><button type="button" disabled={!!busy} onClick={()=>void history()}>Purchase history</button></div>
 {!owner?<button type="button" className="primary-button" onClick={openConnect}>Connect Fomo wallet</button>:session.current?.address&&session.current.address!==owner?<p>Checking this wallet’s purchases…</p>:<>
 {!order&&!product&&!historyReady&&<p>Open purchase history to restore receipts and unfinished payments for this wallet.</p>}
 {!order&&!product&&historyReady&&orders.length===0&&<p>No purchases for this wallet yet. <a href="#pay/gift-cards">Browse gift cards</a></p>}
 {!order&&supported&&<form onSubmit={e=>{e.preventDefault();void create();}}><label>Gift-card amount<select required value={value} onChange={e=>{setValue(e.target.value);setFunding(null);}}><option value="">Choose amount</option>{product!.packages.map(p=><option key={p.value} value={p.value}>{p.value} {p.currency} · quoted {p.price} {p.priceCurrency}</option>)}</select></label><label>Receipt email<input required type="email" maxLength={254} autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)}/></label><label className="gift-terms"><input type="checkbox" required checked={agreed} onChange={e=>setAgreed(e.target.checked)}/>I checked the merchant’s terms and redemption country.</label><p>We check this wallet’s USDC and SOL before creating an invoice. Bitrefill receives your receipt email. You’ll review the exact price and network fee before approving payment.</p><button type="submit" className="primary-button" disabled={!!busy||!value||!agreed}>{busy||(funding&&!funding.ready?'Check balance and continue':'Continue to payment')}</button></form>}
 {funding&&funding.wallet===owner&&!funding.ready&&(!order||expiry>90)&&<div role="status" className="gift-funding"><p>{order?'Add funds to pay this existing invoice.':'No invoice was created. Add funds before continuing.'}</p><p>Available: {giftFundingAmount(funding.balanceUsdcRaw)} USDC and {giftFundingAmount(funding.balanceSolLamports,9)} SOL.</p>{funding.missingUsdcRaw!=='0'&&<p>Add {giftFundingAmount(funding.missingUsdcRaw)} USDC{funding.estimate?' for the estimated gift-card price':''}.</p>}{funding.missingSolLamports!=='0'&&<p>Add {giftFundingAmount(funding.missingSolLamports,9)} SOL for the network fee and receiving account.</p>}<p>Use this wallet’s Solana balance in Fomo, then check again. {funding.estimate?'The final USDC price is checked before payment.':'Keep the same invoice open; no second purchase is needed.'}</p><p className="gift-address">Your Solana wallet: {owner}</p></div>}
 {order&&<div className="gift-order"><h3 className="merchant-heading"><MerchantLogo product={order.product} />{order.name}</h3><p>{order.value} {order.currency} gift card</p><p role="status">{giftStatus(order.status)}</p>
 {checks?.delivery==='unavailable'&&<p role="status">Bitrefill could not refresh delivery. Your saved purchase is shown; check again before making a payment.</p>}
 {checks?.payment==='unavailable'&&<p role="status">Payment confirmation could not refresh. Your saved receipt is unchanged; check again before making a payment.</p>}
 {order.state==='creating'||order.state==='uncertain'?<p>Check this purchase before creating another invoice. No payment has been requested.</p>:<>
 {order.terms&&<p className="gift-total">{usdcDisplay(order.terms.rawAmount)} USDC</p>}
 {order.status==='unpaid'&&<p>{expiry>90?`Payment window: ${Math.floor(expiry/60)}:${String(expiry%60).padStart(2,'0')}`:'The payment window is closed. Check status before starting another purchase.'}</p>}
 {review&&<><p>Network fee: {Number(review.feeLamports)/1e9} SOL{review.rentLamports!=='0'?`. Receiving account: up to ${Number(review.rentLamports)/1e9} SOL.`:''}</p><p className="gift-address">To {order.terms?.recipient}</p></>}
 {payment&&<p>{payment.state==='verified'?'USDC transfer confirmed. Bitrefill confirms gift-card delivery separately.':payment.state==='failed'?'Payment failed on Solana. No USDC was transferred.':'Your signed payment is saved. Confirmation is pending.'}{payment.signature&&<> <a href={`https://solscan.io/tx/${payment.signature}`} target="_blank" rel="noreferrer">View transaction</a></>}</p>}
 {payable&&<button type="button" className="primary-button" disabled={!!busy} onClick={()=>void(review&&tick-review.preparedAt<55000?pay():prepare())}>{busy||(funding&&!funding.ready?'Check balances':review&&tick-review.preparedAt<55000?'Approve payment':'Review payment')}</button>}
 {packet&&(!payment||payment.state==='pending')&&<button type="button" disabled={!!busy} onClick={()=>void retry()}>Retry saved payment</button>}
 {owner&&purchaseSplitDraft(order,owner)&&<button type="button" className="word-link" onClick={()=>{try{const draft=purchaseSplitDraft(order,owner);if(!draft)throw Error('This purchase cannot be split.');sessionStorage.setItem(PURCHASE_SPLIT_KEY,JSON.stringify(draft));location.hash='#pay/split';}catch{setError('Could not open the split. Create it from Pay using this purchase’s USDC cost.');}}}>Split this purchase</button>}
 {order.delivery?.code&&<details key={order.id} className="gift-redemption"><summary>Reveal gift-card code</summary><p>Use this code at {order.name}. Keep it private.</p><code>{order.delivery.code}</code></details>}
 {order.delivery?.link&&<a className={order.delivery.code?'word-link':'primary-button'} href={order.delivery.link} target="_blank" rel="noreferrer">Open your gift card</a>}
 {order.delivery?.refunded&&<p>Bitrefill reports this order as refunded. Check the receipt for refund details.</p>}
 {order.checkoutUrl&&['blocked','invalid','underpaid','overpaid','refunded','complete'].includes(order.status)&&<a href={order.checkoutUrl} target="_blank" rel="noreferrer">View Bitrefill receipt</a>}
 {checksAvailable&&expiry===0&&!packet&&(!payment||payment.state==='failed')&&['unpaid','expired'].includes(order.status)&&<button type="button" disabled={!!busy} onClick={()=>void close()}>Close expired invoice</button>}
 </>}<button type="button" disabled={!!busy} onClick={()=>void open(order.id)}>Check purchase</button><button type="button" disabled={!!busy} onClick={()=>{setOrder(null);setReview(null);setPacket(null);setPayment(null);setChecks(null);setFunding(null);}}>Back to products</button></div>}
 {session.current?.address===owner&&orders.length>0&&<div className="gift-history">{orders.map(o=><button type="button" key={o.id} disabled={!!busy} onClick={()=>void open(o.id)}><span className="merchant-heading"><MerchantLogo product={o.product} />{o.name} · {o.value} {o.currency}</span><small>{giftStatus(o.status)}</small></button>)}</div>}
 </>}{error&&<p role="alert" className="form-error">{error}</p>}{refreshError&&order&&<p role="status">{refreshError}</p>}</section>;
}
