import {directExitMessage,validateExitTerms,type DirectExitTerms} from '../src/direct-exits.js';
import {address,isOffCurveAddress} from '@solana/kit';
export type DirectExitPilot={orders:DirectExitTerms[]};
// Fixed IDs share the ordinary durable order ledger. A consumed or cancelled ID
// cannot create another sale. Only the owner's issuance timestamp can change.
export function parseDirectExitPilot(value:unknown):DirectExitPilot{
 const p=value as DirectExitPilot;
 if(!p||Object.keys(p).join()!=='orders'||!Array.isArray(p.orders)||p.orders.length<1||p.orders.length>2)throw Error('Invalid direct exit pilot.');
 const orders=p.orders.map(t=>{validateExitTerms(t);return structuredClone(t);}),first=orders[0];
 if(new Set(orders.map(t=>t.id)).size!==orders.length||orders.some(t=>![2,3].includes(t.version)||t.version!==first.version||isOffCurveAddress(address(t.wallet))||t.wallet!==first.wallet||t.mint!==first.mint||t.origin!==first.origin||t.issuedAt!==first.issuedAt||t.expiresAt!==first.expiresAt||t.expiresAt>t.issuedAt+86400000||t.slippageBps>100||BigInt(t.maxFeeLamports)>10000n||t.maxRentLamports!=='0')||orders.reduce((n,t)=>n+BigInt(t.amountRaw),0n)>1000000n)throw Error('Direct exit pilot exceeds its bounded scope.');
 return {orders};
}
export function assertDirectExitPilot(p:DirectExitPilot,t:DirectExitTerms,now=Date.now()){
 validateExitTerms(t);const approved=p.orders.find(o=>o.id===t.id);
 if(!approved||t.issuedAt<approved.issuedAt||t.issuedAt>now||t.expiresAt<=now||directExitMessage({...t,issuedAt:approved.issuedAt})!==directExitMessage(approved))throw Error('Order is outside the bounded direct exit pilot.');
}
export function configuredDirectExitPilot(env:Record<string,string|undefined>,mode:string):DirectExitPilot|undefined{
 const raw=env.SIGNER_DIRECT_EXIT_PILOT_POLICY;if(!raw)return;
 if(mode!=='pilot'||env.SIGNER_NATIVE_PILOT_POLICY||env.SIGNER_NATIVE_EXECUTION_ENABLED==='true'||env.DIRECT_EXIT_SERVICE_ENABLED!=='true')throw Error('Exit pilot requires exclusive direct-exit scope.');
 let p:DirectExitPilot;try{p=parseDirectExitPilot(JSON.parse(raw));}catch{throw Error('Invalid direct exit pilot policy.');}
 if(env.SIGNER_PILOT_WALLETS!==p.orders[0].wallet||p.orders[0].origin!==env.SIGNER_WEB_ORIGIN||p.orders[0].expiresAt>Date.now()+86400000)throw Error('Exit pilot wallet, origin or expiry does not match.');
 // Expired configuration may boot for recovery, but assertions forbid new sales.
 return p;
}
