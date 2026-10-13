import {useEffect,useRef,useState} from 'react';
import type {AccountCopyPlan} from './copy-account';
import {nativeLimits,verifyNativeApproval,freshNativeApproval,type NativeLimitDraft} from './native-copy-approval';
import {token22PermissionMessage,type Token22Permission} from './native-copy-permission';
import {triggerRequest,TriggerError} from './trigger-api';
import {tokenUnits} from './copy-inventory';
const initial:NativeLimitDraft={buy:'0.0001',daily:'0.004',fee:'0.00001',rent:'0.0031',duration:3600000,mint:''};
export function CopyNativeApproval({wallet,csrf,plan,sign,onChange,defaultOpen=false,onBusyChange}:{wallet:string;csrf:string;plan:AccountCopyPlan;sign:(scope:Token22Permission)=>Promise<string>;onChange:()=>void;defaultOpen?:boolean;onBusyChange?:(busy:boolean)=>void}){
 const [open,setOpen]=useState(defaultOpen),[draft,setDraft]=useState(initial),[review,setReview]=useState<Token22Permission|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[retry,setRetry]=useState(false),[blocked,setBlocked]=useState(false);
 const alive=useRef(true),lock=useRef(false),signed=useRef<{scope:Token22Permission;signature:string}|null>(null);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 async function run(fn:()=>Promise<void>){if(lock.current)return;lock.current=true;setBusy(true);onBusyChange?.(true);setError('');try{await fn();}catch(e){if(alive.current){setError(e instanceof Error?e.message:'Approval could not be confirmed.');if(e instanceof TriggerError&&e.code.startsWith('native_approval_')){setBlocked(true);setRetry(false);}}}finally{lock.current=false;if(alive.current){setBusy(false);onBusyChange?.(false);}}}
 async function requestReview(){const reply=await triggerRequest<{scope:Token22Permission;message:string}>('copy-native-prepare',{wallet,id:plan.id,limits:nativeLimits(draft)},csrf);return verifyNativeApproval(reply,wallet,plan,draft);}
 async function prepare(){const scope=await requestReview();if(alive.current){signed.current=null;setRetry(false);setBlocked(false);setReview(scope);setNotice('');}}
 async function approve(){
  if(!review)return;
  if(!signed.current){const scope=await freshNativeApproval(review,requestReview);if(!alive.current)return;setReview(scope);const signature=await sign(scope);if(!alive.current)return;signed.current={scope,signature};}
  setRetry(true);
  const saved=await triggerRequest<{id:string;planId:string;wallet:string;status:string;executionConfigured:boolean}>('copy-native-approve',{wallet,...signed.current},csrf);
  if(saved.id!==signed.current.scope.id||saved.planId!==plan.id||saved.wallet!==wallet||saved.status!=='accepted'||typeof saved.executionConfigured!=='boolean')throw Error('Approval response changed. Refresh the plan.');
  if(alive.current){signed.current=null;setRetry(false);setReview(null);setNotice(saved.executionConfigured?'SOL limits saved. Leader monitoring is enabled. Execution depends on the trading service and wallet access.':'SOL limits saved. Trading is currently disabled. No trade was placed.');onChange();}
 }
 return <div className="native-copy-approval">
  <button className="word-link" aria-expanded={open} disabled={busy} onClick={()=>setOpen(v=>!v)}>{open?'Hide SOL approval':'Set SOL copy limits'}</button>
  {open&&<section aria-label={`SOL limits for ${plan.name||'this trader'}`}>
   <h3>Copy with SOL</h3><p className="copy-help">Uses this Fomo wallet. The daily cap includes buys, network fees and new account rent. These SOL amounts replace the dollar amounts for this permission.</p>
   {!review?<><div className="form-grid">
    {([['buy','SOL per buy'],['daily','Daily SOL cap'],['fee','Network fee cap per trade'],['rent','Account rent cap per trade']] as const).map(([key,label])=><label key={key}>{label}<input inputMode="decimal" value={draft[key]} disabled={busy} onChange={e=>setDraft(v=>({...v,[key]:e.target.value}))}/></label>)}
    <label>Only copy this token (optional)<input value={draft.mint||''} placeholder="Solana token mint" spellCheck={false} autoCapitalize="none" disabled={busy} onChange={e=>setDraft(v=>({...v,mint:e.target.value}))}/></label>
    <label>Permission duration<select value={draft.duration} disabled={busy} onChange={e=>setDraft(v=>({...v,duration:Number(e.target.value)}))}><option value={3600000}>1 hour</option><option value={86400000}>24 hours</option></select></label>
   </div><button className="button secondary compact" disabled={busy||plan.archived} onClick={()=>void run(prepare)}>{busy?'Checking…':'Review SOL limits'}</button></>:<div className="permission-review">
    <h3>Review SOL limits</h3><dl className="live-details">
     <div><dt>Buy</dt><dd>{tokenUnits(review.buyLamports,9)} SOL</dd></div><div><dt>Daily cap</dt><dd>{tokenUnits(review.dailySpendLamports,9)} SOL, including fees and rent</dd></div>
     <div><dt>Network fee cap per trade</dt><dd>{tokenUnits(review.maxFeeLamports,9)} SOL</dd></div><div><dt>Account rent cap per trade</dt><dd>{tokenUnits(review.maxRentLamports,9)} SOL</dd></div>
     <div><dt>Slippage</dt><dd>{review.slippageBps/100}%</dd></div><div><dt>Proportional sells</dt><dd>{review.copySells?'Enabled for this plan’s acquired tokens':'Off'}</dd></div><div><dt>Permission duration</dt><dd>{(review.expiresAt-review.issuedAt)/3600000} hour{review.expiresAt-review.issuedAt===3600000?'':'s'}</dd></div>
     <div><dt>Tokens</dt><dd style={{overflowWrap:"anywhere"}}>{(review.version===2||review.version===4||review.version===6||review.version===8||review.version===10)?review.mint:"Supported tokens traded by this leader"}</dd></div>
    </dl><p className="copy-help">{review.version>=9?'Supported Pump bonding curves, standard SPL PumpSwap pools and Raydium CLMM.':review.version>=7?'Standard SPL through reviewed Raydium CLMM or PumpSwap pools; supported Token-2022 through Raydium CLMM.':review.version>=5?'Standard SPL and supported Token-2022 tokens through reviewed Raydium CLMM pools.':'Supported Token-2022 tokens through reviewed Raydium CLMM pools.'} {review.version>=9?'Curve sales return native SOL; pool sales return WSOL, in the same wallet.':'Sell proceeds remain wrapped SOL.'} Pause this plan to revoke its limits. {(review.version===2||review.version===4||review.version===6||review.version===8||review.version===10)?"Buys and sells are restricted to the token shown above.":"This permission is not restricted to one token."}</p>
    <details><summary>Exact approval message</summary><pre className="direct-exit-message">{token22PermissionMessage(review)}</pre></details>
    {!blocked&&<button className="button primary compact" disabled={busy} onClick={()=>void run(approve)}>{busy?'Checking…':retry?'Retry same approval':'Sign SOL copy limits'}</button>}
    {blocked&&<button className="button secondary compact" disabled={busy} onClick={()=>{signed.current=null;setReview(null);setBlocked(false);setError('');onChange();}}>Back to limits</button>}
    {!retry&&!blocked&&<button className="word-link" disabled={busy} onClick={()=>setReview(null)}>Edit limits</button>}
   </div>}
   {error&&<p role="alert" className="error-message">{error}</p>}{notice&&<p role="status" className="wallet-notice">{notice}</p>}
  </section>}
 </div>;
}
