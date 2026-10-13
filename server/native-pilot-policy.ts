import {verifyCurveReview} from './pump-curve-execution.js';
import {address,isAddress,isOffCurveAddress,getTransactionDecoder,getCompiledTransactionMessageDecoder} from '@solana/kit';
import {operationId,WSOL} from '../src/funding-model.js';
import {nativePriorityPrice} from './native-priority.js';
import {COMPUTE_PROGRAM,COPY_SWAP_PROGRAM} from '../src/copy-swap.js';
import type {Token22SigningRequest} from './token2022-signing.js';
import type {Raydium22ExecutionReview} from './token2022-recovery.js';
export type NativePilotPolicy=Readonly<{wallet:string;mint:string;planId:string;permissionHash:string;buyLamports:string;totalDebitLamports:string;slippageBps:number;expiresAt:number;priorUnsignedExecutions?:readonly string[]}>;
export function validatePriorUnsignedExecutions(value:unknown):readonly string[]{
 if(!Array.isArray(value)||value.length<1||value.length>4||value.some(id=>!operationId(id))||new Set(value).size!==value.length)throw Error('Invalid closed pilot attempts.');
 return Object.freeze([...value]);
}
export function parseNativePilotPolicy(value:unknown):NativePilotPolicy{
 const p=value as NativePilotPolicy;
 if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).filter(k=>k!=='priorUnsignedExecutions').sort().join(',')!=='buyLamports,expiresAt,mint,permissionHash,planId,slippageBps,totalDebitLamports,wallet'||
  ![p.wallet,p.mint].every(a=>typeof a==='string'&&isAddress(a))||isOffCurveAddress(address(p.wallet))||p.mint===WSOL||p.mint===p.wallet||!operationId(p.planId)||!/^[a-f0-9]{64}$/.test(p.permissionHash)||
  typeof p.buyLamports!=='string'||!/^[1-9][0-9]{0,7}$/.test(p.buyLamports)||BigInt(p.buyLamports)>100000n||typeof p.totalDebitLamports!=='string'||!/^[1-9][0-9]{0,7}$/.test(p.totalDebitLamports)||BigInt(p.totalDebitLamports)>4000000n||BigInt(p.totalDebitLamports)<=BigInt(p.buyLamports)||
  !Number.isInteger(p.slippageBps)||p.slippageBps<10||p.slippageBps>100||!Number.isSafeInteger(p.expiresAt)||p.expiresAt<=0)throw Error('Invalid bounded native pilot policy.');
 return Object.freeze({...p,...('priorUnsignedExecutions' in p?{priorUnsignedExecutions:validatePriorUnsignedExecutions(p.priorUnsignedExecutions)}:{})});
}
// This variant contains only the fixed compute limit and swap. No instruction
// can recreate the owner's WSOL account. Independent route rebuilding still runs.
export function nativeSellWithoutSetup(r:Raydium22ExecutionReview){
 if(r.accounts.direction!=='sell'||r.wrappedCreated||r.tokenCreated||r.tokenRent!==0||(r.pumpTracker?.rent??0)!==0)return false;
 if(r.version===4){try{if(!r.curve||r.curve.trackerRent!==0||(r.curve.curveRent??0)!==0||r.curve.request.direction!=='sell'||r.curve.unsigned!==r.unsigned)return false;verifyCurveReview(r.curve);return true;}catch{return false;}}
 const tx=getTransactionDecoder().decode(Buffer.from(r.unsigned,'base64')),m=getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
 if(m.version!==0||![2,3].includes(m.instructions.length))return false;
 let priority:number;try{priority=nativePriorityPrice(r.unsigned);}catch{return false;}
 if((priority>0)!==(m.instructions.length===3))return false;
 const compute=m.instructions[0],swap=m.instructions.at(-1)!;
 return m.staticAccounts[compute.programAddressIndex]===COMPUTE_PROGRAM&&
  (compute.accountIndices?.length??0)===0&&!!compute.data&&Buffer.from(compute.data).equals(Buffer.from([2,128,26,6,0]))&&m.staticAccounts[swap.programAddressIndex]===COPY_SWAP_PROGRAM;
}
export function assertNativePilotRequest(p:NativePilotPolicy,r:Token22SigningRequest,now=Date.now()){
 if(p.priorUnsignedExecutions?.includes(r.executionId)||(r.permission.scope.version!==2&&r.permission.scope.version!==4&&r.permission.scope.version!==6&&r.permission.scope.version!==8&&r.permission.scope.version!==10)||r.permission.scope.mint!==p.mint||p.expiresAt<=now||r.expiresAt>p.expiresAt||r.wallet!==p.wallet||r.review.accounts.mint!==p.mint||r.permission.scope.planId!==p.planId||r.permission.scopeHash!==p.permissionHash||
  r.permission.scope.buyLamports!==p.buyLamports||r.permission.scope.slippageBps>p.slippageBps||BigInt(r.permission.scope.dailySpendLamports)>BigInt(p.totalDebitLamports)||
  (r.review.accounts.direction==='buy'?r.review.accounts.inputRaw!==p.buyLamports:(r.permission.scope.version===10&&r.review.version===4?BigInt(r.review.accounts.inputRaw)>18446744073709551615n:BigInt(r.review.accounts.inputRaw)>1000000n)||!nativeSellWithoutSetup(r.review)))throw Error('Trade is outside the bounded native pilot.');
}
export function configuredNativePilot(env:Record<string,string|undefined>,mode:string):NativePilotPolicy|undefined{
 const raw=env.SIGNER_NATIVE_PILOT_POLICY;
 if(mode!=='pilot'){if(raw)throw Error('A bounded pilot policy requires pilot scope.');return;}
 if(!raw)throw Error('Pilot scope requires an exact native test policy.');
 let value:unknown;try{value=JSON.parse(raw);}catch{throw Error('Invalid bounded native pilot policy.');}
 const policy=parseNativePilotPolicy(value);
 if(env.SIGNER_PILOT_WALLETS!==policy.wallet||policy.expiresAt>Date.now()+86400000||env.DIRECT_EXIT_EXECUTION_ENABLED==='true')throw Error('Pilot scope requires one matching wallet, a bounded expiry and disabled direct exits.');
 return policy;
}
