import {useEffect,useRef,useState} from 'react';
import {useWallets} from '@privy-io/react-auth';
import {stringToHex} from 'viem';
import {CASH_NETWORKS,cashAmountRaw,type CashNetwork} from './cash-route';
import {cashCopyPermissionMessage,validateCashCopyScope,type CashCopyScope} from './cash-copy-model';
import {cashCopyClient,checkCashCopyReview,cashCopyRenewal,type CashCopyRenewal,cashCopyStatusLabel,cashCopyBudgetLabel,requestCashCopySigner,readCashCopyConfiguration,readCashCopyStatus,readPendingCashCopy,type CashCopyConfiguration,type CashCopyStatus,type PendingCashCopy} from './cash-copy-client';
import {readCashCopyReadiness,cashCopyFundingIssue} from './cash-copy-readiness';
import {cashCopyDurationHours,cashCopySlippageBps} from './cash-copy-client';
import {Modal} from './ui';
type Props={existingScope?:CashCopyScope;serviceOrigin:string;wallet:string;walletId:string;recipient:string;evmWalletId:string;leaderSource:string;leaderHandle?:string;getToken:()=>Promise<string|null>;current:()=>boolean;close:()=>void;hidden:boolean;onSigningChange:(active:boolean)=>void;signSolana:(scope:CashCopyScope)=>Promise<string>;addSigner:(address:string,signerId:string,policyId:string)=>Promise<void>};
const GAS:Record<CashNetwork,string>={base:'100000000000000',bnb:'100000000000000',monad:'350000000000000000',robinhood:'30000000000000',arc:'50000000000000000',ethereum:'100000000000000'};
const GAS_LABEL:Record<CashNetwork,string>={base:'0.0001 ETH',bnb:'0.0001 BNB',monad:'0.35 MON',robinhood:'0.00003 ETH',arc:'0.05 USDC',ethereum:'0.0001 ETH'};
export function CashCopyActivation(p:Props){
 const {wallets}=useWallets(),[config,setConfig]=useState<CashCopyConfiguration>(),[buy,setBuy]=useState('3'),[cap,setCap]=useState('10'),[networks,setNetworks]=useState<CashNetwork[]>(['base']),[sells,setSells]=useState(true),[hours,setHours]=useState('1');
 const durations = cashCopyDurationHours(config);
 useEffect(()=>{const allowed=cashCopyDurationHours(config);setHours(old=>allowed.includes(Number(old))?old:String(allowed[0]));},[config?.reviewLimits?.maxDurationMs]);
 const [waiting,setWaiting]=useState(false);
 const [slippage,setSlippage]=useState('1');
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[progress,setProgress]=useState(''),[pending,setPending]=useState<PendingCashCopy|{scope:CashCopyScope}|null>(null),[status,setStatus]=useState<CashCopyStatus>();
 const renewal=useRef<CashCopyRenewal|null>(null);
 const alive=useRef(true),lock=useRef(false),latest=useRef(p);latest.current=p;
 const current=()=>alive.current&&latest.current.current();
 const key=`fub.cash-copy.permission.v1:${p.wallet}:${p.recipient}:${p.leaderSource}`;
 useEffect(()=>{alive.current=true;const c=new AbortController();
  const client=cashCopyClient(p.serviceOrigin,p.getToken,current);
  try{
   const legacy=readPendingCashCopy(localStorage.getItem(key),p.wallet,p.recipient);
   if(legacy&&!localStorage.getItem(key+':'+legacy.scope.planId))localStorage.setItem(key+':'+legacy.scope.planId,JSON.stringify(legacy));
   if(p.existingScope){
    validateCashCopyScope(p.existingScope);if(p.existingScope.sourceWallet!==p.wallet||p.existingScope.recipient!==p.recipient)throw Error('Plan owner changed.');
    const saved=readPendingCashCopy(localStorage.getItem(key+':'+p.existingScope.planId),p.wallet,p.recipient);
    setPending(saved&&saved.scope.planVersion>=p.existingScope.planVersion?saved:{scope:p.existingScope});
   }else setPending(legacy);
  }catch{setError('Saved copy permission could not be read. Resolve it before creating another.');lock.current=true;}
  void client('config',{wallet:p.wallet,walletId:p.walletId,leaderSource:p.leaderSource,...(p.leaderHandle?{leaderHandle:p.leaderHandle}:{})},c.signal).then(v=>{if(current()){const c=readCashCopyConfiguration(v,p.leaderSource,p.leaderHandle);setConfig(c);setNetworks(old=>{const available=old.filter(n=>c.networks.includes(n));return available.length?available:[c.networks[0]];});}}).catch(e=>{if(current()&&!c.signal.aborted)setError(e.message);});
  return()=>{alive.current=false;c.abort();};
 },[p.serviceOrigin,p.wallet,p.walletId,p.recipient,p.leaderSource,p.leaderHandle]);
 useEffect(()=>{
  if(!pending||busy)return;const c=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const until=Date.now()+60000;
  const refresh=async()=>{try{const client=cashCopyClient(p.serviceOrigin,p.getToken,current);const s=readCashCopyStatus(await client('status',{planId:pending.scope.planId,wallet:p.wallet},c.signal),pending.scope.planId);if(!current()||c.signal.aborted)return;setStatus(s);setError('');const matching=s.permissionId===pending.scope.id;
   if(s.permissionId&&!matching){setWaiting(false);setError(cashCopyRenewal(pending.scope,s)?'This renewal was not activated. The previous permission is paused or expired. Review fresh limits to continue.':'A different permission is saved for this plan. Review its status before continuing.');setProgress('');return;}
   if(waiting&&matching&&s.state==='active'&&s.monitorReady!==false&&s.executionEnabled!==false){setWaiting(false);p.close();return;}
   if(waiting&&((s.permissionState||s.state)!=='active'||!matching)){setWaiting(false);setProgress('');return;}
  }catch{if(!c.signal.aborted&&current())setError('Status could not be checked. Your saved permission has not been replaced.');}
   if(waiting&&!c.signal.aborted&&current()){if(Date.now()>=until){setWaiting(false);setProgress('Your permission is saved. Check its status to confirm that copying is ready.');}else timer=setTimeout(()=>void refresh(),2000);}
  };
  void refresh();return()=>{c.abort();if(timer)clearTimeout(timer);};
 },[pending?.scope.id,busy,waiting]);
 async function run(action:'activate'|'status'|'stop'){
  if(lock.current||!current())return;lock.current=true;setBusy(true);setError('');
  const controller=new AbortController(),client=cashCopyClient(p.serviceOrigin,p.getToken,current);
  const guard=()=>{if(!current())throw Error('Your connected wallet changed.');};
  try{
   if(action!=='activate'){
    if(!pending)throw Error('No saved copy permission.');
    const result=await client(action,{planId:pending.scope.planId,wallet:p.wallet},controller.signal);guard();
    setStatus(readCashCopyStatus(result,pending.scope.planId));setProgress(action==='stop'?'Copying paused. Pending transactions will still be checked.':'Status updated.');return;
   }
   if(!config?.enabled)throw Error('Cross-chain copying is not activated for this trader.');
   let permission=pending;
   if(!permission){
    const buyRaw=cashAmountRaw(buy),dailyRaw=cashAmountRaw(cap),slippageBps=cashCopySlippageBps(slippage);
    if(BigInt(dailyRaw)<BigInt(buyRaw)||networks.length===0||networks.some(n=>!config.networks.includes(n)))throw Error('Check the buy size, daily cap and selected chains.');
    if(renewal.current){
     const fresh=readCashCopyStatus(await client('status',{planId:renewal.current.planId,wallet:p.wallet},controller.signal),renewal.current.planId);guard();setStatus(fresh);
     if(fresh.permissionId!==renewal.current.id||!['paused','expired'].includes(fresh.permissionState||fresh.state)||fresh.pending!==0||!fresh.budget)throw Error('Check this plan’s saved status before renewing its limits.');
     if(fresh.budget.day!==status?.budget?.day||fresh.budget.usedUsdcRaw!==status?.budget?.usedUsdcRaw)throw Error('Daily usage changed. Review the remaining budget before approving.');
    }
    const evm=wallets.find(w=>['privy','privy-v2'].includes(w.walletClientType)&&!w.imported&&w.address.toLowerCase()===p.recipient);
    if(!evm)throw Error('Your cross-chain wallet is still loading.');
    const now=Date.now(),scope:CashCopyScope={version:1,id:crypto.randomUUID(),planId:renewal.current?.planId||crypto.randomUUID(),planVersion:(renewal.current?.planVersion||0)+1,origin:location.origin,sourceWallet:p.wallet,recipient:p.recipient,leader:config.leader.wallet,networks:[...networks],buyUsdcRaw:buyRaw,dailyUsdcRaw:dailyRaw,slippageBps,copySells:sells,gasTopupUsdcRaw:networks.includes('ethereum')?'300000':'100000',maxSourceFeeLamports:'2510000',maxSaleGas:Object.fromEntries(networks.map(n=>[n,GAS[n]])),issuedAt:now,acceptBy:now+300000,expiresAt:now+Number(hours)*3600000};
    checkCashCopyReview(scope,config);
    setProgress('Checking USDC and SOL in your funding wallet…');
    const funding=readCashCopyReadiness(await client('readiness',{scope,walletIds:{solana:p.walletId,evm:p.evmWalletId}},controller.signal),scope);guard();
    const fundingIssue=cashCopyFundingIssue(funding);if(fundingIssue)throw Error(fundingIssue);
    setProgress('Confirm access for your funding and cross-chain wallets.');
    p.onSigningChange(true);
    try{await requestCashCopySigner(()=>p.addSigner(p.wallet,config.solana!.signerId,config.solana!.policyId));guard();await requestCashCopySigner(()=>p.addSigner(p.recipient,config.evm!.signerId,config.evm!.policyId));guard();}finally{p.onSigningChange(false);}
    // Provider prompts cannot consume the signed review's acceptance window.
    scope.issuedAt=Date.now();scope.acceptBy=scope.issuedAt+300000;scope.expiresAt=scope.issuedAt+Number(hours)*3600000;
    validateCashCopyScope(scope);const message=cashCopyPermissionMessage(scope);
    setProgress('Confirm the same copy limits in both wallets.');p.onSigningChange(true);
    let solana:string,evmSignature:unknown;
    try{solana=await p.signSolana(scope);guard();const provider=await evm.getEthereumProvider();guard();evmSignature=await provider.request({method:'personal_sign',params:[stringToHex(message),p.recipient]});guard();}finally{p.onSigningChange(false);}
    if(typeof evmSignature!=='string'||!/^0x[0-9a-f]{130}$/i.test(evmSignature))throw Error('Copy limits were not confirmed.');
    permission={scope,proof:{solana,evm:evmSignature},walletIds:{solana:p.walletId,evm:p.evmWalletId}};
    // If storage fails, nothing is sent to the service.
    localStorage.setItem(key+':attempt:'+scope.id,JSON.stringify(permission));localStorage.setItem(key+':'+scope.planId,JSON.stringify(permission));localStorage.setItem(key,JSON.stringify(permission));setPending(permission);
   }
   if(!('proof' in permission))throw Error('Review fresh limits before renewing this permission.');
   setProgress('Activating your saved copy plan…');setWaiting(true);
   const result=readCashCopyStatus(await client('activate',permission,controller.signal),permission.scope.planId);guard();
   if(result.permissionId===permission.scope.id&&result.permissionState==='active'&&result.monitorReady===false){setStatus(result);setWaiting(true);setProgress('Connecting the trader’s live feed…');return;}
   if(result.state!=='active'||result.monitorReady===false||result.executionEnabled===false||result.permissionId!==permission.scope.id)throw Error('This permission was not activated. Check its saved status.');
   setStatus(result);p.close();
  }catch(e){if(current()){setError(e instanceof Error?e.message:'Copy request was not confirmed.');setProgress('');}}
  finally{lock.current=false;if(current())setBusy(false);}
 }
 let budgetLabel='';
 if(status?.budget){try{budgetLabel=cashCopyBudgetLabel(status.budget,!pending&&renewal.current?cashAmountRaw(cap):undefined);}catch{budgetLabel='Enter a valid daily cap to see the remaining budget.';}}
 const renewable=pending&&status?cashCopyRenewal(pending.scope,status):null;
 if(p.hidden)return null;
 return <Modal title="Copy with USDC." close={()=>{if(!busy)p.close();}}>
  <p className="copy-help">Buy from your Fomo Solana USDC balance. Hold cross-chain tokens in your Fub wallet and return sale proceeds to the original wallet.</p>
  {config&&<p className="copy-help">{config.leader.handle?'@'+config.leader.handle+' · ':''}Fomo trading wallet: {config.leader.sourceWallet.slice(0,5)}…{config.leader.sourceWallet.slice(-5)} → {config.leader.wallet.slice(0,6)}…{config.leader.wallet.slice(-4)}</p>}
  {config&&!config.enabled&&<p className="copy-help" role="status">New cross-chain copy permissions are currently unavailable. You can still check existing plans, view receipts and pause copying.</p>}
  {!pending?<fieldset disabled={busy||!config?.enabled} style={{border:0,padding:0,margin:0}}>
   <label className="field"><span>USDC per buy</span><input inputMode="decimal" value={buy} onChange={e=>setBuy(e.target.value)}/></label>
   <label className="field"><span>Daily USDC cap across chains</span><input inputMode="decimal" value={cap} onChange={e=>setCap(e.target.value)}/></label>
   {renewal.current&&<p className="copy-help">{budgetLabel||"Check the saved plan’s daily usage before renewing."}</p>}
   <div className="copy-help">{(config?.networks||[]).map(n=><label key={n} style={{display:'block'}}><input type="checkbox" checked={networks.includes(n)} onChange={e=>setNetworks(old=>e.target.checked?[...old,n]:old.filter(x=>x!==n))}/> {CASH_NETWORKS[n].name}</label>)}</div>
   <label className="field"><span>Maximum slippage (%)</span><input inputMode="decimal" value={slippage} onChange={e=>setSlippage(e.target.value)}/></label>
   <label className="copy-help"><input type="checkbox" checked={sells} onChange={e=>setSells(e.target.checked)}/> Copy proportional sells from this plan’s holdings</label>
   <label className="field"><span>Permission duration</span><select value={hours} onChange={e=>setHours(e.target.value)}>{durations.map(h=><option key={h} value={String(h)}>{h<1?`${Math.round(h*60)} minutes`:h===1?"1 hour":`${h} hours`}</option>)}</select></label>
   <p className="copy-help">Each buy includes {networks.includes('ethereum')?'0.30':'0.10'} USDC for destination gas. Solana fees and rent are capped at 0.00251 SOL per buy.</p>
   <details className="copy-help"><summary>Sale gas limits</summary>{networks.map(n=><p key={n}>{CASH_NETWORKS[n].name}: {GAS_LABEL[n]}</p>)}</details>
   <button className="button primary full" onClick={()=>void run('activate')}>{busy?'Confirming…':'Approve copy limits'}</button>
  </fieldset>:<>
   <p className="copy-help">{pending.scope.networks.map(n=>CASH_NETWORKS[n].name).join(' · ')} · {Number(pending.scope.buyUsdcRaw)/1e6} USDC per buy · {pending.scope.slippageBps/100}% maximum slippage. {pending.scope.copySells?'Proportional sells enabled.':'Buys only.'}</p>
   <p role="status" className="copy-help">{status?cashCopyStatusLabel(status):'Saved permission. Check its status before retrying.'}</p>
   {budgetLabel&&<p className="copy-help">{budgetLabel}</p>}
   <button className="button primary full" disabled={busy} onClick={()=>void run('status')}>Check copy status</button>
   {(status?.permissionState||status?.state)!=='paused'&&(status?.permissionState||status?.state)!=='missing'&&<button className="word-link" disabled={busy} onClick={()=>void run('stop')}>Pause copying</button>}
   {status&&(renewable||(status.permissionState||status.state)==='missing'&&Date.now()>pending.scope.acceptBy)&&status.pending===0&&<button className="word-link" disabled={busy||!config?.enabled} onClick={()=>{renewal.current=renewable;setNetworks(pending.scope.networks.filter(n=>config?.networks.includes(n)));setBuy(String(Number(pending.scope.buyUsdcRaw)/1e6));setCap(String(Number(pending.scope.dailyUsdcRaw)/1e6));setSells(pending.scope.copySells);setSlippage(String(pending.scope.slippageBps/100));setPending(null);if(!renewal.current)setStatus(undefined);setError('');}}>Review fresh limits</button>}
   {('proof' in pending)&&(!status||(status.permissionState||status.state)==='missing')&&<button className="word-link" disabled={busy||!config?.enabled||Date.now()>=pending.scope.acceptBy} onClick={()=>void run('activate')}>Resume saved activation</button>}
  </>}
  {progress&&<p role="status" className="copy-help">{progress}</p>}{error&&<p role="alert" className="error-message">{error}</p>}
 </Modal>;
}
