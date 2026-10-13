import {token22PermissionMessage,parseToken22Permission,type Token22Permission} from './native-copy-permission';
import {isMint} from './assets';
import {WSOL} from './funding-model';
import type {AccountCopyPlan} from './copy-account';
export type NativeLimitDraft={buy:string;daily:string;fee:string;rent:string;duration:number;mint?:string};
export function solLamports(value:string){
 if(!/^(0|[1-9]\d{0,3})(\.\d{1,9})?$/.test(value))throw Error('Enter SOL with at most nine decimal places.');
 const [whole,fraction='']=value.split('.');return (BigInt(whole)*1000000000n+BigInt(fraction.padEnd(9,'0'))).toString();
}
export function nativeLimits(d:NativeLimitDraft){const mint=d.mint?.trim();if(mint&&(!isMint(mint)||mint===WSOL))throw Error('Enter the token’s Solana mint address.');return {...(mint?{mint}:{}),buyLamports:solLamports(d.buy),dailySpendLamports:solLamports(d.daily),maxFeeLamports:solLamports(d.fee),maxRentLamports:solLamports(d.rent),durationMs:d.duration};}
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
