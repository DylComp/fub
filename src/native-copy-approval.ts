import {NATIVE_COPY_MAX_BUY_LAMPORTS,token22PermissionMessage,parseToken22Permission,type Token22Permission} from './native-copy-permission.js';
import {isMint} from './assets.js';
import {WSOL} from './funding-model.js';
import type {AccountCopyPlan} from './copy-account.js';
export type NativeLimitDraft={buy:string;daily:string;fee:string;rent:string;duration:number;mint?:string};
export function solLamports(value:string){
 if(!/^(0|[1-9]\d{0,3})(\.\d{1,9})?$/.test(value))throw Error('Enter SOL with at most nine decimal places.');
 const [whole,fraction='']=value.split('.');return (BigInt(whole)*1000000000n+BigInt(fraction.padEnd(9,'0'))).toString();
}
export function nativeLimits(d:NativeLimitDraft){const mint=d.mint?.trim();if(mint&&(!isMint(mint)||mint===WSOL))throw Error('Enter the token’s Solana mint address.');const limits={...(mint?{mint}:{}),buyLamports:solLamports(d.buy.trim()),dailySpendLamports:solLamports(d.daily.trim()),maxFeeLamports:solLamports(d.fee.trim()),maxRentLamports:solLamports(d.rent.trim()),durationMs:d.duration};
 validateNativeCopyLimits(limits);return limits;}
export function verifyNativeApproval(reply:{scope:Token22Permission;message:string},wallet:string,plan:AccountCopyPlan,draft:NativeLimitDraft){
 const s=parseToken22Permission(reply.scope),l=nativeLimits(draft),now=Date.now();
 if(((s.version===2||s.version===4||s.version===6||s.version===8||s.version===10)?s.mint:undefined)!==(draft.mint?.trim()||undefined)||s.wallet!==wallet||s.planId!==plan.id||s.planVersion!==plan.version||s.leader!==plan.address||s.copySells!==plan.copySells||s.slippageBps!==plan.slippageBps||s.buyLamports!==l.buyLamports||s.dailySpendLamports!==l.dailySpendLamports||s.maxFeeLamports!==l.maxFeeLamports||s.maxRentLamports!==l.maxRentLamports||s.expiresAt-s.issuedAt!==draft.duration||s.issuedAt>now||s.acceptBy<=now||reply.message!==token22PermissionMessage(s))throw Error('Approval changed. Refresh the plan and review again.');
 return structuredClone(s);
}

// Refresh unsigned timestamps only. A changed wallet, token, plan version or
// financial limit must return to review instead of reaching a wallet prompt.
export async function freshNativeApproval(review:Token22Permission,refresh:()=>Promise<Token22Permission>,now=()=>Date.now()){
 parseToken22Permission(review);
 if(review.acceptBy>now()+15000)return review;
 const next=parseToken22Permission(await refresh());
 const terms=(s:Token22Permission)=>Object.entries(s).filter(([key])=>!['id','issuedAt','acceptBy','expiresAt'].includes(key)).sort(([a],[b])=>a.localeCompare(b));
 if(JSON.stringify(terms(next))!==JSON.stringify(terms(review))||next.expiresAt-next.issuedAt!==review.expiresAt-review.issuedAt||
   next.issuedAt>now()||next.acceptBy<=now()+15000)throw Error('Limits changed. Review them again before signing.');
 return structuredClone(next);
}

export function validateNativeCopyLimits(limits:{buyLamports:string;dailySpendLamports:string;maxFeeLamports:string;maxRentLamports:string;durationMs:number}){
 const raw=(value:string)=>{if(typeof value!=='string'||!/^(0|[1-9]\d{0,18})$/.test(value))throw Error('Enter valid SOL amounts with at most nine decimal places.');return BigInt(value);};
 const buy=raw(limits.buyLamports),daily=raw(limits.dailySpendLamports),fee=raw(limits.maxFeeLamports),rent=raw(limits.maxRentLamports);
 if(buy<1n||buy>BigInt(NATIVE_COPY_MAX_BUY_LAMPORTS))throw Error('SOL per buy must be between 0.000000001 and 100 SOL.');
 if(fee<1n||fee>50000n)throw Error('Network fee cap must be between 0.000000001 and 0.00005 SOL.');
 if(rent>5000000n)throw Error('Account rent cap cannot exceed 0.005 SOL.');
 if(daily>1000000000000n)throw Error('Daily SOL cap cannot exceed 1,000 SOL.');
 const minimum=buy+fee+rent;
 if(daily<minimum){const value=`${minimum/1000000000n}.${(minimum%1000000000n).toString().padStart(9,'0')}`.replace(/0+$/,'').replace(/\.$/,'');throw Error(`Daily SOL cap must be at least ${value} SOL to cover one buy, its network fee and account rent.`);}
 if(![3600000,86400000].includes(limits.durationMs))throw Error('Choose a one-hour or one-day permission.');
}
