import {ViewedTokenChart} from "./ViewedTokenChart";
import {directOrderRecovery,sameDirectOrderPolicy,type PendingDirectOrder} from './direct-order-recovery';
import {limitBuyTokens} from './order-market-cap';
import {NativeSellAmount} from "./NativeSellAmount";
import {MarketCapEntry} from "./MarketCapEntry";
import {useEffect,useRef,useState} from 'react';
import {enrollmentClient,type EnrollmentConfig,type EnrollmentIdentity} from './enrollment-client';
import {assertOrderFunding,buildLimitBuyTerms,buildPilotExitTerms,buildExitTerms,exitBalanceReview,exitOrderList,exitUnits,exitStatus,sameExitTerms,type ExitBalanceReview,type ExitDraft,type ExitOrderView} from './direct-exit-client';
import {isLimitBuy,exitInputDecimals,directExitMessage,validateExitTerms,exitProceeds,type DirectExitTerms} from './direct-exits';
import {shortAddress} from './assets';
import {WSOL} from './funding-model';
const proceedsText=(raw:string,t:DirectExitTerms)=>`${exitUnits(raw,exitProceeds(t).decimals)} ${exitProceeds(t).symbol}`;

type Props={config:EnrollmentConfig;identity:EnrollmentIdentity;origin:string;getToken:()=>Promise<string|null>;sign:(terms:DirectExitTerms)=>Promise<string>;manageAccess:()=>void;initialMint?:string};
const initial:ExitDraft={amount:'',kind:'limit',target:'',stop:'',trail:'10',slippage:'1',duration:86400000};
export function DirectExits({config,identity,origin,getToken,sign,manageAccess,initialMint=''}:Props){
 const [side,setSide]=useState<'buy'|'sell'>('sell'),[buyPrice,setBuyPrice]=useState('');
 const [mint,setMint]=useState(initialMint),[holding,setHolding]=useState<ExitBalanceReview|null>(null),[draft,setDraft]=useState(initial),[review,setReview]=useState<DirectExitTerms|null>(null);
 const [orders,setOrders]=useState<ExitOrderView[]>([]),[enabled,setEnabled]=useState(false),[buyEnabled,setBuyEnabled]=useState(false),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[persisted,setPersisted]=useState(false),[retryReady,setRetryReady]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [now,setNow]=useState(Date.now);
 const [amountReady,setAmountReady]=useState(false);
 const [recoveryBlocked,setRecoveryBlocked]=useState(false),[mcReady,setMcReady]=useState(true),[mcSummary,setMcSummary]=useState<string|null>(null);
 const alive=useRef(true),locked=useRef(false),request=useRef<AbortController|null>(null),pending=useRef<PendingDirectOrder|null>(null);
 const binding=JSON.stringify([config,identity,origin]),latest=useRef(binding);latest.current=binding;
 const current=()=>alive.current&&latest.current===binding;
 const send=enrollmentClient(config,origin,getToken,current);
 const recovery=()=>directOrderRecovery(localStorage,config,identity,origin);
 useEffect(()=>{alive.current=true;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>{alive.current=false;request.current?.abort();clearInterval(timer);};},[]);
 function check(signal:AbortSignal){signal.throwIfAborted();if(!current())throw Error('Wallet or account changed.');}
 async function run(work:(signal:AbortSignal)=>Promise<unknown>){
  if(locked.current)return;locked.current=true;setBusy(true);setError('');setNotice('');const c=new AbortController();request.current=c;
  try{await work(c.signal);}catch(e){if(current())setError(e instanceof Error?e.message:'Could not verify the order.');}
  finally{locked.current=false;if(current())setBusy(false);}
 }
 async function refresh(signal:AbortSignal){
  let storageIssue='';
  if(!pending.current){
   try{
    const saved=await recovery().read();check(signal);setRecoveryBlocked(false);
    if(saved){pending.current=saved;setPersisted(true);setRetryReady(false);setReview(saved.terms);setMint(saved.terms.mint);setUncertain(true);setNotice('Checking your existing signed approval. Do not create a replacement order.');}
   }catch(e){check(signal);storageIssue=e instanceof Error?e.message:'Order recovery could not be read.';setRecoveryBlocked(true);}
  }
  const result=exitOrderList(await send('direct-exit-list',{wallet:identity.wallet},signal),identity.wallet,origin);check(signal);
  setOrders(result.orders);setBuyEnabled(result.buyExecutionEnabled);setEnabled(result.executionEnabled);setLoaded(true);
  if(pending.current){
   const saved=pending.current;
   let found=result.orders.find(o=>o.terms.id===saved.terms.id);
   if(!found){
    const value=await send('direct-exit-recover',{walletId:identity.walletId,terms:saved.terms,signature:saved.signature},signal) as {id:string;checkedAt:number;retryAllowed:boolean};check(signal);
    const exact=exitOrderList(value,identity.wallet,origin);
    if(typeof value.retryAllowed!=='boolean'||value.id!==saved.terms.id||!Number.isSafeInteger(value.checkedAt)||value.checkedAt>Date.now()+5000||value.checkedAt<Date.now()-30000||exact.orders.length>1||exact.orders.some(o=>o.terms.id!==saved.terms.id))throw Error('Exact order recovery could not be verified.');
    setRetryReady(value.retryAllowed);found=exact.orders[0];
    if(found)setOrders([found,...result.orders.filter(o=>o.terms.id!==found!.terms.id)].slice(0,100));
   }
   if(found){
    if(!sameExitTerms(found.terms,saved.terms))throw Error('The saved order differs from your approval.');
    await recovery().clear(saved);check(signal);pending.current=null;setUncertain(false);setPersisted(false);setRetryReady(false);setRecoveryBlocked(false);setReview(null);setNotice('Your order is recorded. Its current status is below.');
   }
  }
  if(storageIssue)setError('New order approvals are blocked because browser recovery could not be verified. Existing order history and cancellation remain available. '+storageIssue);
  return result;
 }
 useEffect(()=>{
  const start=setTimeout(()=>void run(refresh),0);
  const timer=setInterval(()=>{if(document.visibilityState==='visible'&&!locked.current)void run(refresh);},15000);
  return()=>{clearTimeout(start);clearInterval(timer);};
  // This component is keyed by the complete owner identity in wallet setup.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[binding]);
 async function loadHolding(signal:AbortSignal){
  const value=exitBalanceReview(await send('direct-exit-review',{walletId:identity.walletId,wallet:identity.wallet,mint:mint.trim()},signal),identity.wallet,mint.trim());check(signal);
  setHolding(value);setEnabled(value.executionEnabled);setReview(null);setDraft(d=>({...d,amount:''}));
 }
 useEffect(()=>{
  if(!loaded||recoveryBlocked||! /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint.trim()))return;
  let cancelled=false;
  const checkBalance=()=>{
   if(cancelled||!current()||pending.current)return;
   if(locked.current){timer=setTimeout(checkBalance,250);return;}
   void run(loadHolding);
  };
  let timer=setTimeout(checkBalance,350);
  return()=>{cancelled=true;clearTimeout(timer);};
  // Only a selected contract or owner change starts an automatic read. Editing
  // an amount, refreshing history or signing must not reset the user's draft.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[mint,loaded,recoveryBlocked,binding]);
 async function reviewOrder(signal:AbortSignal){
  if(!holding||!mcReady||side==='sell'&&!amountReady)throw Error('Refresh the market cap conversion.');
  let balance=holding;
  if(balance.expiresAt<=Date.now()){
   balance=exitBalanceReview(await send('direct-exit-review',{walletId:identity.walletId,wallet:identity.wallet,mint:holding.mint},signal),identity.wallet,holding.mint);check(signal);
   if(balance.decimals!==holding.decimals||balance.tokenProgram!==holding.tokenProgram)throw Error('Token details changed. Check the token again.');
   setHolding(balance);setEnabled(balance.executionEnabled);
  }
  setReview((side==='buy'?buildLimitBuyTerms:buildExitTerms)(draft,balance,origin));
 }
 async function approve(signal:AbortSignal){
  if(!review)throw Error('Review an order first.');
  if(pending.current&&!retryReady)throw Error('Check this saved approval before retrying.');
  if(!pending.current){
   if(!holding||!enabled||!holding.permissionReady)throw Error('Wallet access and direct execution must be available first.');
   await recovery().writable();check(signal);
   if(Date.now()>=review.expiresAt)throw Error('This order expired. Review a new order.');
   const fresh=exitBalanceReview(await send('direct-exit-review',{walletId:identity.walletId,wallet:identity.wallet,mint:review.mint},signal),identity.wallet,review.mint);check(signal);
   if(!fresh.executionEnabled||!fresh.permissionReady||isLimitBuy(review)&&!fresh.buyEnabled)throw Error('Wallet access or execution availability changed.');
   assertOrderFunding(review,fresh);
   // Stamp consent when the user approves, after the live holding check. Keep
   // every financial term and the original order ID/deadline unchanged.
   const terms={...review,issuedAt:Date.now()};validateExitTerms(terms);
   if(fresh.pilotOrders&&!fresh.pilotOrders.some(t=>sameExitTerms(t,{...terms,issuedAt:t.issuedAt})))throw Error('The bounded test policy changed. Review it again.');
   setReview(terms);const signature=await sign(terms);check(signal);
   pending.current={version:1,origin,identity:{...identity},policy:{...config},terms,signature};setUncertain(true);
   await recovery().save(terms,signature);check(signal);setPersisted(true);
  }
  const saved=pending.current;check(signal);
  if(!sameDirectOrderPolicy(saved.policy,config))throw Error('This approval uses an older signing policy. Check its existing status; do not replace it.');
  if(Date.now()>=saved.terms.expiresAt||Date.now()-saved.terms.issuedAt>300000)throw Error('This approval expired. Its existing outcome must be confirmed before another order.');
  await recovery().save(saved.terms,saved.signature);check(signal);setPersisted(true);
  const retained=await recovery().read();check(signal);
  if(!retained||!sameExitTerms(retained.terms,saved.terms)||retained.signature!==saved.signature||!sameDirectOrderPolicy(retained.policy,saved.policy))throw Error('Saved approval changed. Check this existing order before retrying.');
  try{
   const value=await send('direct-exit-activate',{walletId:identity.walletId,terms:saved.terms,signature:saved.signature},signal) as {id:string;state:string};
   if(value?.id!==saved.terms.id)throw Error('Order identity did not match.');
   await refresh(signal);
   if(pending.current)throw Error('The order is not visible in history yet.');
  }catch{
   check(signal);
   try{await refresh(signal);if(!pending.current)return;}catch{check(signal);}
   throw Error('Approval needs confirmation. Check status or retry this same approval. Do not create a replacement order.');
  }
 }
 async function cancel(id:string,signal:AbortSignal){
  try{const value=await send('direct-exit-cancel',{id},signal) as {id:string;state:string};if(value?.id!==id||value.state!=='cancelled')throw Error();}
  catch{
   const latest=await refresh(signal);
   if(!latest.orders.some(order=>order.terms.id===id&&order.state==='cancelled'))throw Error('Cancellation was not confirmed. Check the latest status; signing may already have started.');
   setNotice('Order cancelled. No new trade will be signed for this order.');return;
  }
  await refresh(signal);setNotice('Order cancelled. No new trade will be signed for this order.');
 }
 function edit(){if(uncertain)return;setReview(null);setError('');setNotice('');}
 const symbol=holding?.outputMint===WSOL?'SOL / WSOL':'USDC';
 return <section className="direct-exits" aria-label="Fomo wallet limit orders">
  <p className="copy-help">Buy or sell from {shortAddress(identity.wallet)} at your chosen limit. Tokens and proceeds stay in this wallet.</p>
  {loaded&&!enabled&&<p className="wallet-notice">Direct execution is not enabled for this wallet. You can review a holding and check existing orders.</p>}
  {!review?<>
   <div className="filter-tabs" aria-label="Limit order side">{(['buy','sell'] as const).map(value=><button type="button" key={value} disabled={busy} aria-pressed={side===value} className={side===value?'selected':''} onClick={()=>{setSide(value);setDraft(initial);setBuyPrice('');setMcReady(false);setMcSummary(null);}}>{value==='buy'?'Buy':'Sell'}</button>)}</div>
   <label className="field"><span>Token contract</span><input value={mint} disabled={busy} autoComplete="off" spellCheck={false} onChange={e=>{setMint(e.target.value);setHolding(null);setError('');}} /></label>
   <button className="button secondary full" disabled={busy||!loaded||recoveryBlocked} onClick={()=>void run(loadHolding)}>{busy?'Checking…':holding?'Refresh balance':'Check token and balance'}</button>
   {holding&&<ViewedTokenChart address={holding.mint}/> }
   {holding&&<>
    <p className="copy-help">Available: {side==='buy'?`${holding.solBalanceRaw===undefined?'Unverified':exitUnits(holding.solBalanceRaw,9)} SOL`:`${exitUnits(holding.balanceRaw,holding.decimals)} tokens`}.</p>
    {side==='sell'&&<p className="copy-help">Sell only tokens already in this wallet. Your balance is checked again before approval; keep the selected amount available until the order fills.</p>}
    {side==='sell'&&BigInt(holding.balanceRaw)===0n&&<p className="wallet-notice">This wallet does not hold this token. Choose a token you own to place a limit sell.</p>}
    {side==='buy'&&!holding.buyEnabled&&<p className="wallet-notice">Limit-buy activation is not enabled. You can prepare and review the order.</p>}
    <p className="copy-help">{side==='buy'?'One fixed SOL purchase. Keep enough SOL for the spend, network fees and account rent.':holding?.outputMint===WSOL?'Supported Pump bonding curves return native SOL. Supported Raydium CLMM and PumpSwap pools return wrapped SOL (WSOL), in the same wallet.':'This exit returns USDC.'}</p>
    {!holding.permissionReady&&<p className="wallet-notice">Approve or renew wallet access before activating an order. <button className="word-link" disabled={busy} onClick={manageAccess}>Manage wallet access</button></p>}
    {holding.pilotOrders?<div className="direct-exit-grid"><p className="copy-help">Run one test at a time. Wait for its confirmed result before starting the next.</p>{holding.pilotOrders.map(t=><button className="button secondary full" key={t.id} disabled={busy||orders.some(o=>o.terms.id===t.id||o.terms.mint===t.mint&&['watching','signing','signed','submitted','uncertain'].includes(o.state))} onClick={()=>void run(async()=>{setReview(buildPilotExitTerms(t,holding,origin));})}>{orders.some(o=>o.terms.id===t.id)?'Test order recorded':t.kind==='bracket'?'Review bounded target + stop test':'Review bounded trailing test'}</button>)}{holding.pilotOrders.length===0&&<p className="copy-help">No test order is available for this token.</p>}</div>:<>
    {side==='buy'?<>
    <label className="field native-sell-amount"><span>Amount to buy (SOL)</span><div className="input-shell"><input aria-label="Amount to buy (SOL)" value={draft.amount} inputMode="decimal" disabled={busy} onChange={e=>{const amount=e.target.value;setDraft(d=>({...d,amount,target:''}));try{const target=limitBuyTokens(amount,buyPrice,holding.decimals);setDraft(d=>({...d,target}));}catch{ /* Review requires a valid price or market cap. */ }}}/><span>SOL</span></div></label>
    <MarketCapEntry key={`${holding.mint}:buy`} mint={holding.mint} buySpend={draft.amount} buyDecimals={holding.decimals} onModeChange={mode=>{setDraft(d=>({...d,target:''}));if(mode==='price'){try{const target=limitBuyTokens(draft.amount,buyPrice,holding.decimals);setDraft(d=>({...d,target}));}catch{ /* A price is required. */ }}}} hasStop={false} quote="SOL" baseLabel="Token price" disabled={busy} onChange={target=>setDraft(d=>({...d,target}))} onReady={(ready,summary)=>{setMcReady(ready);setMcSummary(summary);}}>
     <label className="field"><span>Maximum token price (SOL)</span><input value={buyPrice} inputMode="decimal" disabled={busy} onChange={e=>{setBuyPrice(e.target.value);setDraft(d=>({...d,target:''}));try{const target=limitBuyTokens(draft.amount,e.target.value,holding.decimals);setDraft(d=>({...d,target}));setError('');}catch{ /* Empty input remains editable. */ }}}/></label>
    </MarketCapEntry>
    {draft.target&&<p className="copy-help">Receive at least {draft.target} tokens for this SOL amount. Fees and account rent are additional.</p>}
    </>:<>
    <NativeSellAmount mint={holding.mint} quantity={draft.amount} decimals={holding.decimals} maxQuantity={exitUnits(holding.balanceRaw,holding.decimals)} disabled={busy} onChange={amount=>setDraft(d=>({...d,amount}))} onReady={setAmountReady}/>
    <MarketCapEntry key={holding.mint} mint={holding.mint} hasStop={false} quantity={draft.amount} quote={holding.outputMint===WSOL?'SOL':'USD'} places={holding.outputMint===WSOL?9:6} baseLabel="Sale proceeds" disabled={busy} onChange={target=>setDraft(d=>({...d,target}))} onReady={(ready,summary)=>{setMcReady(ready);setMcSummary(summary);}}>
     <label className="field"><span>Minimum sale proceeds ({symbol})</span><input value={draft.target} inputMode="decimal" disabled={busy} onChange={e=>setDraft(d=>({...d,target:e.target.value}))} /></label>
    </MarketCapEntry>
    <p className="copy-help">Proceeds are the total {symbol} for the amount you sell, not the price of one token.</p>
    </>}
    <div className="direct-exit-grid"><label className="field"><span>Slippage limit (%)</span><input value={draft.slippage} inputMode="decimal" disabled={busy} onChange={e=>setDraft(d=>({...d,slippage:e.target.value}))} /></label>
    <label className="field"><span>Expires in</span><select value={draft.duration} disabled={busy} onChange={e=>setDraft(d=>({...d,duration:Number(e.target.value)}))}><option value={3600000}>1 hour</option><option value={86400000}>24 hours</option><option value={604800000}>7 days</option></select></label></div>
    <button className="button primary full" disabled={busy||recoveryBlocked||!mcReady||side==='sell'&&!amountReady} onClick={()=>void run(reviewOrder)}>Review limit {side}</button>
    </>}
   </>}
  </>:<div className="permission-review">
   <h3>{isLimitBuy(review)?'Review limit buy':review.kind==='limit'?'Review limit sell':review.kind==='bracket'?'Review existing target and stop':'Review existing trailing stop'}</h3>
   {mcSummary&&<p className="copy-help">{mcSummary}</p>}
   <dl className="live-details"><div><dt>{isLimitBuy(review)?'Spend':'Sell'}</dt><dd>{exitUnits(review.amountRaw,exitInputDecimals(review))} {isLimitBuy(review)?'SOL':'tokens'}</dd></div><div><dt>Token</dt><dd className="direct-exit-address">{review.mint}</dd></div>
   {review.kind==='limit'?<div><dt>{isLimitBuy(review)?'Minimum received':'Minimum proceeds'}</dt><dd>{proceedsText(review.targetRaw!,review)}</dd></div>:review.kind==='bracket'?<><div><dt>Target proceeds</dt><dd>{proceedsText(review.targetRaw!,review)}</dd></div><div><dt>Stop proceeds</dt><dd>{proceedsText(review.stopRaw!,review)}</dd></div></>:<div><dt>Trail</dt><dd>{review.trailingBps!/100}%</dd></div>}
   <div><dt>Slippage</dt><dd>{review.slippageBps/100}%</dd></div><div><dt>Network fee cap</dt><dd>{exitUnits(review.maxFeeLamports,9)} SOL</dd></div><div><dt>Account rent cap</dt><dd>{exitUnits(review.maxRentLamports,9)} SOL</dd></div><div><dt>Expires</dt><dd>{new Date(review.expiresAt).toLocaleString()}</dd></div></dl>
   {isLimitBuy(review)?<p className="copy-help">One purchase into this wallet. Fub fills only when the verified transaction guarantees the signed minimum tokens. Funds are not reserved; keep the approved SOL amount and fee buffer available.</p>:<p className="copy-help">One sale from this wallet to {exitProceeds(review).symbol}. {review.version===5?'Curve sales return SOL; pool sales return WSOL.':review.version!==1?'Proceeds remain wrapped SOL.':''} {review.kind==='limit'?'The sale triggers only when the quote’s minimum proceeds meet your limit.':'This existing order retains its originally approved rules.'}</p>}
   <details><summary>Exact approval message</summary><pre className="direct-exit-message">{directExitMessage(review)}</pre></details>
   {uncertain?<><p className="wallet-notice">{persisted?'Your signed approval is saved for recovery. Check this order before creating a replacement.':'This signed approval has not been submitted or saved for recovery. Keep this view open and check status before retrying.'}</p>{retryReady&&pending.current&&sameDirectOrderPolicy(pending.current.policy,config)&&now<review.expiresAt&&now-review.issuedAt<=300000?<button className="button primary full" disabled={busy} onClick={()=>void run(approve)}>{busy?'Checking…':'Retry same approval'}</button>:<p className="copy-help">Check this approval’s status to verify whether its original permission can be retried. Expired approvals and previous signing policies are resolved without another signature.</p>}</>:!enabled||isLimitBuy(review)&&!holding?.buyEnabled?<p className="wallet-notice">Activation is unavailable for this order type.</p>:!holding?.permissionReady?<button className="button secondary full" disabled={busy} onClick={manageAccess}>Manage wallet access</button>:<button className="button primary full" disabled={busy||!uncertain&&now>=review.expiresAt} onClick={()=>void run(approve)}>{busy?'Checking…':uncertain?'Retry same approval':isLimitBuy(review)?'Approve limit buy':'Approve limit sell'}</button>}
   {uncertain?<button className="word-link" disabled={busy} onClick={()=>void run(refresh)}>Check approval status</button>:<button className="word-link" disabled={busy} onClick={edit}>Edit order</button>}
  </div>}
  {error&&<p className="error-message" role="alert">{error}</p>}{notice&&<p className="wallet-notice" role="status">{notice}</p>}
  <div className="section-toolbar"><h3>Your limit orders</h3><button className="word-link" disabled={busy} onClick={()=>void run(refresh)}>Refresh orders</button></div>
  {!loaded?<p role="status">Checking orders…</p>:!orders.length?<p className="copy-help">No limit orders for this wallet.</p>:orders.map(o=><article className="live-order" key={o.terms.id}>
   <div className="live-order-top"><strong>{isLimitBuy(o.terms)?'Limit buy':o.terms.kind==='limit'?'Limit sell':o.terms.kind==='bracket'?'Existing target + stop':'Existing trailing stop'}</strong><span>{exitStatus(o,enabled&&(!isLimitBuy(o.terms)||buyEnabled),now)}</span></div>
   <p className="copy-help">{exitUnits(o.terms.amountRaw,exitInputDecimals(o.terms))} {isLimitBuy(o.terms)?'SOL':'tokens'} · {shortAddress(o.terms.mint)}</p>
   {o.terms.kind==='limit'?<p className="copy-help">{isLimitBuy(o.terms)?'Minimum received':'Minimum proceeds'} {proceedsText(o.terms.targetRaw!,o.terms)}</p>:o.terms.kind==='bracket'?<p className="copy-help">Target {proceedsText(o.terms.targetRaw!,o.terms)} · Stop {proceedsText(o.terms.stopRaw!,o.terms)}</p>:<p className="copy-help">Trail {o.terms.trailingBps!/100}% · Observed high {o.highRaw===null?'awaiting quote':proceedsText(o.highRaw,o.terms)}</p>}
   <p className="copy-help">{o.observedAt?`Last quote ${new Date(o.observedAt).toLocaleString()}`:'No quote observed yet'} · Expires {new Date(o.terms.expiresAt).toLocaleString()}</p>
   {o.state==='watching'&&o.observedAt!==null&&now-o.observedAt>60000&&<p className="copy-help">A recent quote is unavailable. Check wallet access and the token’s available liquidity. Do not assume this position is protected.</p>}
   {['signing','signed','submitted','uncertain'].includes(o.state)&&<p className="copy-help">Do not create a replacement. This order may still settle; Fub is checking the existing attempt.</p>}
   <div className="live-order-actions">{o.signature&&<a className="word-link" href={`https://solscan.io/tx/${o.signature}`} target="_blank" rel="noreferrer">View transaction</a>}{o.state==='watching'&&<button className="word-link" disabled={busy} onClick={()=>void run(signal=>cancel(o.terms.id,signal))}>Cancel order</button>}</div>
  </article>)}
 </section>;
}
