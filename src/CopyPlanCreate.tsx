import {useEffect,useRef,useState} from 'react';
import {CopyNativeApproval} from './CopyNativeApproval';
import {walletSessionRequest} from './wallet-session-client';
import {verifyWalletLogin,type WalletLogin} from './wallet-session-model';
import {triggerRequest} from './trigger-api';
import type {TriggerSession} from './live-orders';
import type {CopyDraft} from './copy-model';
import type {AccountCopyPlan} from './copy-account';
import type {Token22Permission} from './native-copy-permission';
import {Modal} from './ui';
export function CopyPlanCreate(p:{wallet:string;draft:CopyDraft;signSession:(challenge:WalletLogin)=>Promise<string>;signNativeCopy:(scope:Token22Permission)=>Promise<string>;close:()=>void;onChange:()=>void}){
 const [session,setSession]=useState<TriggerSession>(),[plan,setPlan]=useState<AccountCopyPlan>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const lock=useRef(false),id=useRef(crypto.randomUUID()),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const guard=()=>{if(!alive.current)throw Error('The connected wallet changed.');};
 async function prepare(){if(lock.current)return;lock.current=true;setBusy(true);setError('');try{
  let auth=await walletSessionRequest<TriggerSession>('status');guard();
  if(auth.address!==p.wallet||!auth.csrf||(auth.expiresAt||0)<=Date.now()){
   const review=await walletSessionRequest<{challenge:WalletLogin;message:string}>('challenge',{wallet:p.wallet});
   guard();const challenge=verifyWalletLogin(review,p.wallet,location.origin),signature=await p.signSession(challenge);
   guard();auth=await walletSessionRequest<TriggerSession>('verify',{wallet:p.wallet,signature});
  }
  guard();if(auth.address!==p.wallet||!auth.csrf||(auth.expiresAt||0)<=Date.now())throw Error('Verify the connected wallet before continuing.');
  setSession(auth);
  const list=await triggerRequest<{wallet:string;plans:AccountCopyPlan[]}>('copy-list',{wallet:p.wallet},auth.csrf);
  guard();if(list.wallet!==p.wallet||!Array.isArray(list.plans)||list.plans.some(v=>v.wallet!==p.wallet))throw Error('Plan owner mismatch.');
  const existing=list.plans.find(v=>!v.archived&&v.address===p.draft.address.trim());
  // A retry reopens the durable record; it never replaces an active plan.
  if(existing){setPlan(existing);p.onChange();return;}
  const saved=await triggerRequest<AccountCopyPlan>('copy-save',{wallet:p.wallet,id:id.current,version:0,draft:p.draft},auth.csrf);
  guard();if(saved.wallet!==p.wallet||saved.id!==id.current||saved.address!==p.draft.address.trim()||saved.enabled||saved.archived)throw Error('Plan creation could not be verified. Check your wallet plans before retrying.');
  setPlan(saved);p.onChange();
 }catch(e){if(alive.current)setError(e instanceof Error?e.message:'Plan setup could not complete.');}finally{lock.current=false;if(alive.current)setBusy(false);}}
 return <Modal title="Set up Solana copying." close={()=>{if(!busy)p.close();}}>
  <p className="copy-help">Follow {p.draft.name||p.draft.address}. Confirm wallet ownership, then approve the SOL spending limits that authorize automatic trades.</p>
  {!plan?<button className="button primary full" disabled={busy} onClick={()=>void prepare()}>{busy?'Verifying wallet and plan…':'Continue to SOL limits'}</button>:<>
   <p className="copy-help">Your wallet’s plan is saved. Complete its approval below to enable copying. Existing plans retain their saved slippage and sell settings.</p>
   <CopyNativeApproval defaultOpen wallet={p.wallet} csrf={session!.csrf!} plan={plan} sign={p.signNativeCopy} onChange={p.onChange} onBusyChange={setBusy}/>
  </>}
  {error&&<p className="error-message" role="alert">{error}</p>}
 </Modal>;
}
