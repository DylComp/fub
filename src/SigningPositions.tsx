import { useRef, useState } from 'react';
import { isMint } from './assets';
import { operationId } from './funding-model';
import { parseAllocations, tokenRaw, tokenUnits, type InventoryReview } from './copy-inventory';
import { triggerRequest } from './trigger-api';
import { matchingPositions, ledgerPositionAllocations, needsPositionReduction, positionAppSession, applyAppPosition } from './signing-position-sync';
import type { EnrollmentIdentity } from './enrollment-client';
export function signingPositionReview(value:unknown,wallet:string,mint:string):InventoryReview & {lane:'standard'|'native'} {
 const r=value as InventoryReview & {lane?:'standard'|'native'};
 if(!r||(r.lane!==undefined&&r.lane!=='standard'&&r.lane!=='native')||!operationId(r.id)||r.wallet!==wallet||r.mint!==mint||!isMint(mint)||!Number.isInteger(r.decimals)||r.decimals<0||r.decimals>18||
  !Number.isSafeInteger(r.slot)||r.slot<1||!Number.isFinite(Date.parse(r.expiresAt))||Date.parse(r.expiresAt)<=Date.now()||Date.parse(r.expiresAt)>Date.now()+125000||
  !Array.isArray(r.positions)||!r.positions.length||r.positions.length>25)throw Error('The position review does not match this wallet.');
 if(typeof r.balanceRaw!=='string'||!/^(0|[1-9]\d{0,19})$/.test(r.balanceRaw)||BigInt(r.balanceRaw)>18446744073709551615n)throw Error('Invalid position balance.');
 const allocations=parseAllocations(r.positions.map(p=>({id:p.id,raw:p.raw})));
 return {...r,lane:r.lane??'standard',positions:allocations.map(a=>({id:a.id,raw:a.raw,name:`Plan ${a.id.slice(0,8)}`,version:0,revision:'0',archived:false,enabled:false}))};
}
export function SigningPositions({identity,busy,execute,send}:{identity:EnrollmentIdentity;busy:boolean;
 execute:(work:(signal:AbortSignal)=>Promise<void>)=>Promise<void>;
 send:(action:'position-review'|'position-apply',body:object,signal:AbortSignal)=>Promise<unknown>}){
 const [mint,setMint]=useState(''),[review,setReview]=useState<InventoryReview|null>(null),[values,setValues]=useState<Record<string,string>>({}),[notice,setNotice]=useState('');
 const appReview=useRef<{review:InventoryReview;csrf:string;native:boolean}|null>(null);
 const retry=useRef<ReturnType<typeof parseAllocations>|null>(null),[uncertain,setUncertain]=useState(false);
 async function check(signal:AbortSignal){
  setNotice('');setReview(null);appReview.current=null;retry.current=null;setUncertain(false);
  if(!isMint(mint.trim()))throw Error('Enter the token contract address.');
  const csrf=await positionAppSession(identity.wallet,signal);
  const result=signingPositionReview(await send('position-review',{wallet:identity.wallet,walletId:identity.walletId,mint:mint.trim()},signal),identity.wallet,mint.trim());
  const publicReview=signingPositionReview(await triggerRequest(result.lane==='native'?'copy-native-inventory-review':'copy-inventory-review',{wallet:identity.wallet,mint:mint.trim()},csrf,signal),identity.wallet,mint.trim());
  const positions=matchingPositions(result,publicReview);
  signal.throwIfAborted();appReview.current={review:publicReview,csrf,native:result.lane==='native'};setReview(result);setValues(Object.fromEntries(positions.map(p=>[p.id,tokenUnits(p.raw,result.decimals)])));
 }
 async function apply(signal:AbortSignal){
  if(!review||!appReview.current)throw Error('Check the position again.');
  const app=appReview.current;
  if(!retry.current&&(Date.parse(review.expiresAt)<=Date.now()||Date.parse(app.review.expiresAt)<=Date.now()))throw Error('Check the position again. This review expired.');
  const allocations=retry.current||parseAllocations(review.positions.map(p=>({id:p.id,raw:tokenRaw(values[p.id],review.decimals)})));
  const privateAllocations=ledgerPositionAllocations(review,allocations),appAllocations=ledgerPositionAllocations(app.review,allocations);
  const changePrivate=needsPositionReduction(review,privateAllocations),changeApp=needsPositionReduction(app.review,appAllocations);
  if(!changePrivate&&!changeApp)throw Error('Reduce at least one position to save a correction.');
  retry.current=allocations;setUncertain(true);
  try {
   if(changeApp)await applyAppPosition(app.review,appAllocations,app.csrf,signal,app.native);
   if(changePrivate){
    const r=await send('position-apply',{wallet:identity.wallet,walletId:identity.walletId,id:review.id,allocations:privateAllocations},signal) as {id:string;wallet:string;mint:string;state:string;allocations:unknown;slot:number};
    if(!r||r.id!==review.id||r.wallet!==identity.wallet||r.mint!==review.mint||r.state!=='applied'||!Number.isSafeInteger(r.slot)||r.slot<review.slot||JSON.stringify(parseAllocations(r.allocations))!==JSON.stringify(privateAllocations))throw Error('The signing correction was not confirmed.');
   }
   signal.throwIfAborted();retry.current=null;setUncertain(false);setReview(null);appReview.current=null;
   setNotice('Copy plans and signing positions updated. Original trade receipts and spending totals are unchanged.');
  } catch(error) {
   signal.throwIfAborted();
   throw Error(`Correction needs confirmation. Keep background access stopped and retry, or check both positions again. ${error instanceof Error?error.message:''}`);
  }
 }
 return <details className="permission-removal"><summary>Correct copied positions</summary>
  <p className="copy-help">Sold or transferred tokens in Fomo? Stop background access above, pause the token’s copy plans and resolve pending trades first. Check the balance, then reduce what each copy plan can sell. This does not move tokens.</p>
  <label className="field"><span>Token contract</span><input value={mint} disabled={busy} spellCheck={false} autoComplete="off" onChange={e=>{setMint(e.target.value);setReview(null);setNotice('');}} /></label>
  <button className="word-link" disabled={busy} onClick={()=>void execute(check)}>Check signing position</button>
  {review&&<div className="permission-review"><p className="copy-help">Finalized wallet balance: {tokenUnits(review.balanceRaw,review.decimals)} tokens. Keep the combined amount at or below this balance.</p>
   {review.positions.map(p=><label className="field" key={p.id}><span>{p.name} · tracked {tokenUnits(p.raw,review.decimals)}</span><input aria-label={`Remaining tokens for ${p.name}`} inputMode="decimal" disabled={busy||uncertain} value={values[p.id]??''} onChange={e=>setValues(previous=>({...previous,[p.id]:e.target.value}))} /></label>)}
   <p className="copy-help">Corrections only reduce tracked amounts. Deposits cannot increase a copied position. Background access stays stopped.</p>
   <button className="button secondary full" disabled={busy} onClick={()=>void execute(apply)}>{uncertain?'Retry position correction':'Save position correction'}</button>
  </div>}
  {notice&&<p className="wallet-notice" role="status">{notice}</p>}
 </details>;
}
