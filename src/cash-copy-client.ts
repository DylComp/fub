import {fomoHandle} from './fomo-identity.js';
import {isMint} from './assets';
import {isEvmAddress} from './networks';
import {isCashNetwork,type CashNetwork} from './cash-route';
import {cashCopyRaw,validateCashCopyScope,type CashCopyScope} from './cash-copy-model';
export type CashCopyReviewLimits={recipient:string;buyUsdcRaw:string;dailyUsdcRaw:string;gasTopupUsdcRaw:string;maxDurationMs:number};
export function cashCopySlippageBps(percent:string):number{
 if(!/^(?:0|1)(?:\.\d{1,2})?$/.test(percent))throw Error('Enter a slippage limit from 0.01% to 1%.');
 const [whole,fraction='']=percent.split('.'),bps=Number(whole)*100+Number(fraction.padEnd(2,'0'));
 if(bps<1||bps>100)throw Error('Enter a slippage limit from 0.01% to 1%.');return bps;
}
export type CashCopyConfiguration={enabled:boolean;reviewLimits?:CashCopyReviewLimits;leader:{sourceWallet:string;wallet:string;handle?:string;selectedSource?:string};solana:{signerId:string;policyId:string};evm:{signerId:string;policyId:string};networks:CashNetwork[]};
export type CashCopyBudget={day:string;usedUsdcRaw:string;limitUsdcRaw:string;remainingUsdcRaw:string};
export type CashCopyStatus={planId:string;state:'active'|'paused'|'expired'|'missing';permissionId?:string;permissionVersion?:number;expiresAt?:number;pending?:number;monitorReady?:boolean;executionEnabled?:boolean;permissionState?:'active'|'paused'|'expired'|'missing';budget?:CashCopyBudget};
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
// A prior interrupted setup may already have attached this signer. A duplicate
// response is not proof of its policy: activation still reads BOTH wallets,
// exact policy IDs/digests and owner quorums from Privy before granting access.
export async function requestCashCopySigner(add:()=>Promise<unknown>):Promise<void>{
 try{await add();}catch(error){
  const message=error instanceof Error?error.message:typeof error==='object'&&error!==null&&'message' in error?error.message:null;
  if(message!=='Duplicate signer(s) provided when updating wallet. To address, ensure each additional signer has not already been added.')throw error;
 }
}
export function readCashCopyConfiguration(v:unknown,leaderSource:string,leaderHandle?:string):CashCopyConfiguration{
 const c=v as CashCopyConfiguration,id=(s:unknown)=>typeof s==='string'&&/^[a-z0-9]{20,40}$/.test(s);
 const linked=!!leaderHandle&&fomoHandle(leaderHandle)===leaderHandle&&c?.leader?.handle===leaderHandle&&c.leader.selectedSource===leaderSource;
 if(!c||typeof c.enabled!=='boolean'||!c.leader||!isMint(leaderSource)||!isMint(c.leader.sourceWallet)||c.leader.sourceWallet!==leaderSource&&!linked||!isEvmAddress(c.leader.wallet)||c.leader.wallet!==c.leader.wallet.toLowerCase()||!c.solana||!c.evm||![c.solana.signerId,c.solana.policyId,c.evm.signerId,c.evm.policyId].every(id)||c.solana.signerId===c.evm.signerId||!Array.isArray(c.networks)||c.networks.length<1||c.networks.length>6||c.networks.some(n=>!isCashNetwork(n))||new Set(c.networks).size!==c.networks.length)throw Error('Cross-chain copy settings could not be verified.');
 if(c.reviewLimits){const r=c.reviewLimits;if(!isEvmAddress(r.recipient)||r.recipient!==r.recipient.toLowerCase()||!Number.isSafeInteger(r.maxDurationMs)||r.maxDurationMs<600000||r.maxDurationMs>14400000||cashCopyRaw(r.buyUsdcRaw)<=cashCopyRaw(r.gasTopupUsdcRaw)||cashCopyRaw(r.dailyUsdcRaw)<cashCopyRaw(r.buyUsdcRaw))throw Error('Copy review limits could not be verified.');}
 return c;
}
export function readCashCopyStatus(v:unknown,planId:string):CashCopyStatus{
 const s=v as CashCopyStatus;
 if(!s||s.planId!==planId||!uuid(planId)||!['active','paused','expired','missing'].includes(s.state)||['active','expired'].includes(s.state)&&(!uuid(s.permissionId)||!Number.isSafeInteger(s.expiresAt)||s.expiresAt!<=0)||s.pending!==undefined&&(!Number.isSafeInteger(s.pending)||s.pending<0))throw Error('Copy status could not be verified.');
 if(s.permissionVersion!==undefined&&(!uuid(s.permissionId)||!Number.isSafeInteger(s.permissionVersion)||s.permissionVersion<1))throw Error('Copy permission version could not be verified.');
 if(s.monitorReady!==undefined&&typeof s.monitorReady!=='boolean')throw Error('Copy monitor status could not be verified.');
 if(s.executionEnabled!==undefined&&typeof s.executionEnabled!=='boolean'||s.permissionState!==undefined&&!['active','paused','expired','missing'].includes(s.permissionState)||s.permissionState==='active'&&(!uuid(s.permissionId)||!Number.isSafeInteger(s.expiresAt)||s.expiresAt!<=0))throw Error('Copy status could not be verified.');
 if(s.budget!==undefined){
  const b=s.budget;
  if(!b||typeof b.day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(b.day)||!Number.isFinite(Date.parse(b.day))||new Date(b.day).toISOString().slice(0,10)!==b.day)throw Error('Copy budget could not be verified.');
  const used=cashCopyRaw(b.usedUsdcRaw),limit=cashCopyRaw(b.limitUsdcRaw),remaining=cashCopyRaw(b.remainingUsdcRaw);
  if(remaining!==(limit>used?limit-used:0n))throw Error('Copy budget could not be verified.');
 }
 return s;
}
const displayUsdc=(raw:bigint)=>`${raw/1000000n}${raw%1000000n?'.'+String(raw%1000000n).padStart(6,'0').replace(/0+$/,''):''}`;
export function cashCopyBudgetLabel(b:CashCopyBudget,proposedLimitRaw=b.limitUsdcRaw):string{
 const used=cashCopyRaw(b.usedUsdcRaw),limit=cashCopyRaw(proposedLimitRaw),remaining=limit>used?limit-used:0n;
 return `${displayUsdc(used)} USDC used or reserved on ${b.day} (UTC). ${displayUsdc(remaining)} USDC remaining under the ${displayUsdc(limit)} USDC daily cap. Renewing does not reset today's usage.`;
}
export function cashCopyStatusLabel(s:CashCopyStatus):string{
 const label=s.permissionState==='active'&&s.monitorReady===false?'Connecting the trader’s live feed. Your permission is saved.':s.permissionState==='active'&&s.executionEnabled===false?'Copying is paused by the service. Your wallet permission is still saved.':`Copy plan: ${s.state}.`;
 return label+(s.pending?` ${s.pending} transaction${s.pending===1?'':'s'} awaiting confirmation.`:'');
}
export function cashCopyClient(origin:string,getToken:()=>Promise<string|null>,current:()=>boolean,fetcher=fetch){
 const url=new URL(origin);if(url.protocol!=='https:'||url.origin!==origin)throw Error('Private copy service is unavailable.');
 return async(action:'config'|'activate'|'status'|'stop'|'list'|'readiness'|'history'|'owner-sale-review'|'owner-sale-submit',body:object,signal:AbortSignal):Promise<unknown>=>{
  if(!current())throw Error('Connected wallet changed.');
  const token=await getToken();if(!current())throw Error('Connected wallet changed.');if(signal.aborted||!token||!/^[A-Za-z0-9_.-]{1,8192}$/.test(token))throw Error('Verify your connected wallet again.');
  const active=AbortSignal.any([signal,AbortSignal.timeout(action.startsWith('owner-sale-')?35000:15000)]);
  const response=await fetcher(origin+'/v1/cash-enrollment/'+action,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),credentials:'omit',redirect:'error',cache:'no-store',signal:active});
  if(!response.ok||!response.body||Number(response.headers.get('content-length'))>(action.startsWith('owner-sale-')?300000:32768)){void response.body?.cancel();throw Error(action==='config'?'Automatic copying is not available for this trader yet.':action==='readiness'?'Could not check wallet funding. No permission was requested.':action==='activate'?'Activation was not confirmed. Check this saved plan before retrying.':action==='owner-sale-review'?'Could not prepare this saved sale. Your position remains in trade history; refresh its status before trying again.':action==='owner-sale-submit'?'Could not confirm whether the signed sale was saved. Check this existing sale’s status before retrying.':'Could not confirm this plan’s status. Try again.');}
  const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;const cancel=()=>{void reader.cancel().catch(()=>{});};active.addEventListener('abort',cancel,{once:true});
  try{active.throwIfAborted();for(;;){const p=await reader.read();active.throwIfAborted();if(p.done)break;size+=p.value.length;if(size>(action.startsWith('owner-sale-')?300000:32768))throw Error('Copy response is too large.');parts.push(p.value);}}finally{active.removeEventListener('abort',cancel);cancel();reader.releaseLock();}
  if(!current())throw Error('Connected wallet changed.');const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}return JSON.parse(new TextDecoder().decode(bytes));
 };
}
// Retain the exact signed permission across an uncertain HTTP reply. Never
// create a replacement plan automatically or store access tokens/private keys.
export type PendingCashCopy={scope:CashCopyScope;proof:{solana:string;evm:string};walletIds:{solana:string;evm:string}};
export function readPendingCashCopy(value:string|null,wallet:string,recipient:string):PendingCashCopy|null{
 if(!value)return null;if(value.length>12000)throw Error('Saved copy permission is invalid.');const p=JSON.parse(value) as PendingCashCopy;validateCashCopyScope(p.scope);
 if(p.scope.sourceWallet!==wallet||p.scope.recipient!==recipient||!p.proof||!/^0x[0-9a-f]{130}$/i.test(p.proof.evm)||! /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(p.proof.solana)||!p.walletIds||![p.walletIds.solana,p.walletIds.evm].every(v=>/^[a-z0-9]{20,40}$/.test(v)))throw Error('Saved permission belongs to another wallet.');return p;
}

export type CashCopyRenewal=Pick<CashCopyScope,'planId'|'id'|'planVersion'>;
// A timed-out activation can still arrive until its signed acceptance deadline.
// Only reconcile a different, inactive server grant after that deadline, with
// no unsettled work and an authenticated version to fence concurrent changes.
export function cashCopyRenewal(scope:CashCopyScope,status:CashCopyStatus,now=Date.now()):CashCopyRenewal|null{
 if(status.planId!==scope.planId||!['paused','expired'].includes(status.permissionState||status.state)||status.pending!==0||!status.budget)return null;
 if(status.permissionId===scope.id)return {planId:scope.planId,id:scope.id,planVersion:scope.planVersion};
 if(now<=scope.acceptBy||!uuid(status.permissionId)||!Number.isSafeInteger(status.permissionVersion)||status.permissionVersion!<1)return null;
 return {planId:scope.planId,id:status.permissionId!,planVersion:Math.max(scope.planVersion,status.permissionVersion!)};
}

export type CashCopyPlan={scope:CashCopyScope;leaderSource:string;status:CashCopyStatus};
export function readCashCopyPlans(value:unknown,wallet:string):{plans:CashCopyPlan[];nextCursor:string|null}{
 const v=value as {plans:CashCopyPlan[];nextCursor:string|null};
 if(!v||!Array.isArray(v.plans)||v.plans.length>10||v.nextCursor!==null&&!uuid(v.nextCursor))throw Error('Copy plans could not be verified.');
 const seen=new Set<string>();
 for(const p of v.plans){validateCashCopyScope(p.scope);if(p.scope.sourceWallet!==wallet||!isMint(p.leaderSource)||seen.has(p.scope.planId))throw Error('Copy plan owner changed.');seen.add(p.scope.planId);const s=readCashCopyStatus(p.status,p.scope.planId);if(s.permissionId!==p.scope.id||s.permissionVersion!==p.scope.planVersion)throw Error('Copy plan permission changed.');}
 if(v.nextCursor!==null&&(v.plans.length!==10||v.nextCursor!==v.plans.at(-1)?.scope.planId))throw Error('Copy plan cursor changed.');
 return v;
}

export function cashCopyDurationHours(config?: CashCopyConfiguration): number[] {
 const max = config?.reviewLimits?.maxDurationMs ?? 86400000;
 const choices = [1, 6, 24].filter(hours => hours * 3600000 <= max);
 if(config?.reviewLimits&&!choices.includes(max/3600000))choices.push(max/3600000);
 return choices.length ? choices : [max / 3600000];
}

export function checkCashCopyReview(scope:CashCopyScope,config:CashCopyConfiguration){
 validateCashCopyScope(scope);
 if(!config.enabled||scope.leader!==config.leader.wallet||scope.networks.some(n=>!config.networks.includes(n)))throw Error('These copy settings are not available. Refresh the plan before signing.');
 const r=config.reviewLimits;if(r&&(scope.recipient!==r.recipient||scope.buyUsdcRaw!==r.buyUsdcRaw||scope.dailyUsdcRaw!==r.dailyUsdcRaw||scope.gasTopupUsdcRaw!==r.gasTopupUsdcRaw||scope.expiresAt-scope.issuedAt>r.maxDurationMs))throw Error('These limits differ from the configured test. Review the buy size, total daily cap and duration before signing.');
}
