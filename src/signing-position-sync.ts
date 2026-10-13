import { triggerRequest } from './trigger-api';
import { walletSessionRequest } from './wallet-session-client';
import { parseAllocations, validateAllocation, type InventoryReview, type CopyAllocation } from './copy-inventory';
import type { TriggerSession } from './live-orders';
export function matchingPositions(a:InventoryReview,b:InventoryReview){
 if(a.wallet!==b.wallet||a.mint!==b.mint||a.decimals!==b.decimals||a.balanceRaw!==b.balanceRaw||
  a.positions.some(p=>p.raw!=='0'&&!b.positions.some(q=>q.id===p.id))||
  b.positions.some(p=>p.raw!=='0'&&!a.positions.some(q=>q.id===p.id)))throw Error('Copy records or wallet balances differ. Resolve pending trades and check both positions again.');
 // A failed or fully corrected historical plan can exist in only one ledger.
 // It carries no sellable tokens. Positive unmatched positions still block.
 return a.positions.map(p=>{const other=b.positions.find(q=>q.id===p.id);return {...p,raw:other?(BigInt(p.raw)<BigInt(other.raw)?p.raw:other.raw):'0'};});
}
export function ledgerPositionAllocations(review:InventoryReview,allocations:CopyAllocation[]){
 const parsed=parseAllocations(allocations);
 if(parsed.some(a=>a.raw!=='0'&&!review.positions.some(p=>p.id===a.id)))throw Error('A nonzero position is missing from this ledger.');
 return parseAllocations(review.positions.map(p=>{
  const a=parsed.find(a=>a.id===p.id);
  if(!a&&p.raw!=='0')throw Error('Include every nonzero position in this correction.');
  return {id:p.id,raw:a?.raw??'0'};
 }));
}
export function needsPositionReduction(review:InventoryReview,allocations:CopyAllocation[]){
 const unchanged=review.positions.length===allocations.length&&review.positions.every(p=>allocations.some(a=>a.id===p.id&&a.raw===p.raw));
 if(!unchanged)validateAllocation(review.positions,allocations,review.balanceRaw);
 return !unchanged;
}
export async function positionAppSession(wallet:string,signal:AbortSignal){
 const s=await walletSessionRequest<TriggerSession>('status',undefined,signal);
 if(s.address!==wallet||!s.csrf||(s.expiresAt||0)<=Date.now())throw Error('Sign in to your copy plans with this wallet, then return to correct the position.');
 return s.csrf;
}
export async function applyAppPosition(review:InventoryReview,allocations:CopyAllocation[],csrf:string,signal:AbortSignal,native=false){
 const r=await triggerRequest<{id:string;wallet:string;mint:string;allocations:unknown}>(native?'copy-native-inventory-apply':'copy-inventory-apply',{wallet:review.wallet,id:review.id,allocations},csrf,signal);
 if(r.id!==review.id||r.wallet!==review.wallet||r.mint!==review.mint||JSON.stringify(parseAllocations(r.allocations))!==JSON.stringify(allocations))throw Error('The copy-plan correction was not confirmed. Retry the same correction.');
}
