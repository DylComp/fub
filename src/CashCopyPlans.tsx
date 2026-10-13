import {CashCopyHistory} from './CashCopyHistory';
import {useVisibleRefresh} from './useVisibleRefresh';
import {useEffect,useRef,useState} from 'react';
import {Modal} from './ui';
import {CASH_NETWORKS} from './cash-route';
import {cashCopyClient,cashCopyBudgetLabel,cashCopyStatusLabel,readCashCopyPlans,readCashCopyStatus,type CashCopyPlan} from './cash-copy-client';
type Props={serviceOrigin:string;wallet:string;getToken:()=>Promise<string|null>;current:()=>boolean;close:()=>void;open:(plan:CashCopyPlan)=>void};
export function CashCopyPlans(p:Props){
 const [history,setHistory]=useState<string|null>(null);
 const [refreshError,setRefreshError]=useState('');const refreshOffset=useRef(0);
 const [plans,setPlans]=useState<CashCopyPlan[]>([]),[cursor,setCursor]=useState<string|null>(null),[busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false),[error,setError]=useState('');
 const alive=useRef(true),lock=useRef(false),latest=useRef(p),controller=useRef<AbortController|null>(null),generation=useRef(0);latest.current=p;
 const current=()=>alive.current&&latest.current.wallet===p.wallet&&latest.current.serviceOrigin===p.serviceOrigin&&latest.current.current();
 async function load(after:string|null=null){
  if(lock.current||!current())return;lock.current=true;setBusy(true);setError('');const c=new AbortController();controller.current=c;const gen=++generation.current,valid=()=>gen===generation.current&&current();
  try{const client=cashCopyClient(p.serviceOrigin,p.getToken,valid),page=readCashCopyPlans(await client('list',{wallet:p.wallet,after},c.signal),p.wallet);if(!valid())return;
   setPlans(old=>after?[...old.filter(o=>!page.plans.some(n=>n.scope.planId===o.scope.planId)),...page.plans]:page.plans);setCursor(page.nextCursor);setLoaded(true);
  }catch{if(valid()&&!c.signal.aborted)setError('Could not load your copy plans. Your saved permissions have not changed.');}
  finally{if(gen===generation.current){lock.current=false;if(valid())setBusy(false);}}
 }
 async function pause(plan:CashCopyPlan){
  if(lock.current||!current())return;lock.current=true;setBusy(true);setError('');const c=new AbortController();controller.current=c;const gen=++generation.current,valid=()=>gen===generation.current&&current();
  try{const client=cashCopyClient(p.serviceOrigin,p.getToken,valid);await client('stop',{wallet:p.wallet,planId:plan.scope.planId},c.signal);
   const status=readCashCopyStatus(await client('status',{wallet:p.wallet,planId:plan.scope.planId},c.signal),plan.scope.planId);if(!valid())return;
   setPlans(old=>old.map(row=>row.scope.planId===plan.scope.planId?{...row,status}:row));
  }catch{if(valid()&&!c.signal.aborted)setError('Pause could not be confirmed. Refresh this plan before continuing.');}
  finally{if(gen===generation.current){lock.current=false;if(valid())setBusy(false);}}
 }
 useEffect(()=>{alive.current=true;lock.current=false;setPlans([]);setHistory(null);setCursor(null);setLoaded(false);setRefreshError('');refreshOffset.current=0;void load();return()=>{alive.current=false;generation.current++;controller.current?.abort();};},[p.wallet,p.serviceOrigin]);
 useVisibleRefresh(loaded&&plans.length>0,p.wallet+':'+p.serviceOrigin,5000,async signal=>{
  if(lock.current||!current())return;
  const gen=generation.current,valid=()=>!signal.aborted&&gen===generation.current&&current();
  const start=refreshOffset.current%plans.length,rows=Array.from({length:Math.min(4,plans.length)},(_,i)=>plans[(start+i)%plans.length]);
  const client=cashCopyClient(p.serviceOrigin,p.getToken,valid);
  const results=await Promise.allSettled(rows.map(async row=>({id:row.scope.planId,status:readCashCopyStatus(await client('status',{wallet:p.wallet,planId:row.scope.planId},signal),row.scope.planId)})));
  if(!valid())return;
  refreshOffset.current=(start+rows.length)%plans.length;
  const updated=results.flatMap(r=>r.status==='fulfilled'?[r.value]:[]);
  setPlans(old=>old.map(row=>{const next=updated.find(r=>r.id===row.scope.planId);return next?{...row,status:next.status}:row;}));
  const failed=results.some(r=>r.status==='rejected');
  setRefreshError(failed?'Live status could not refresh. Saved plans remain below.':updated.some(r=>r.status.permissionId!==plans.find(p=>p.scope.planId===r.id)?.scope.id)?'A plan’s limits changed. Refresh plans to load the current permission.':'');
  if(failed)throw Error('Status refresh unavailable');
 });
 return <Modal title="Your USDC copy plans." close={p.close}>
  <p className="copy-help">Plans saved to your wallet account, including paused and expired permissions. Pausing prevents new trades; submitted transactions continue to be checked.</p>
  <button className="word-link" disabled={busy} onClick={()=>void load()}>Refresh plans</button>
  {busy&&<p role="status">Loading plan status…</p>}
  {loaded&&!plans.length&&<p className="copy-help">No USDC copy plans for this wallet yet.</p>}
  {plans.map(plan=><section key={plan.scope.planId} className="copy-boundary" aria-label={'Copy plan '+plan.scope.planId}>
   <strong>{plan.scope.leader.slice(0,6)}…{plan.scope.leader.slice(-4)}</strong>
   <p className="copy-help">{plan.scope.networks.map(n=>CASH_NETWORKS[n].name).join(' · ')} · {Number(plan.scope.buyUsdcRaw)/1e6} USDC per buy</p>
   <p className="copy-help">{cashCopyStatusLabel(plan.status)}</p>
   {plan.status.budget&&<p className="copy-help">{cashCopyBudgetLabel(plan.status.budget)}</p>}
   <p className="copy-help">Permission ends {new Date(plan.scope.expiresAt).toLocaleString()}.</p>
   <button className="word-link" disabled={busy||plan.status.permissionId!==plan.scope.id} onClick={()=>p.open(plan)}>View limits</button>
   {(plan.status.permissionState||plan.status.state)==='active'&&<button className="word-link" disabled={busy} onClick={()=>void pause(plan)}>Pause copying</button>}
   <button className="word-link" aria-expanded={history===plan.scope.planId} onClick={()=>setHistory(old=>old===plan.scope.planId?null:plan.scope.planId)}>{history===plan.scope.planId?'Hide trades':'View trades'}</button>
   {history===plan.scope.planId&&<CashCopyHistory key={plan.scope.planId} serviceOrigin={p.serviceOrigin} wallet={p.wallet} planId={plan.scope.planId} getToken={p.getToken} current={current}/>}
  </section>)}
  {cursor&&<button className="word-link" disabled={busy} onClick={()=>void load(cursor)}>Load more plans</button>}
  {error&&<p className="error-message" role="alert">{error}</p>}
  {refreshError&&<p className="copy-help" role="status">{refreshError}</p>}
 </Modal>;
}
