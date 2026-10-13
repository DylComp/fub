import {isLimitBuy,type DirectExitTerms} from '../src/direct-exits.js';
import type {DirectExitPilot} from './direct-exit-pilot.js';
import {assertDirectExitPilot} from './direct-exit-pilot.js';
import {directExitScheduler} from './direct-exit-scheduler.js';
import {directExitStore} from './direct-exit-store.js';
import {directExitEngine} from './direct-exit-engine.js';
import {directExitSwap} from './direct-exit-swap.js';
import {directExitOrders} from './direct-exit-orders.js';
import {directExitDelivery} from './direct-exit-delivery.js';
import {directExitRecovery} from './direct-exit-recovery.js';
import type {signerEnrollment} from './signer-enrollment.js';
import type {OwnerBinding} from './privy-owner.js';
import type {Rpc} from './funding.js';
import type {PrivySignRequest} from './privy-sign-only.js';
export function directExitService(config:{
 pilot?:DirectExitPilot;
 origin:string;databaseUrl:string;apiKey:string;rpc:Rpc;blockRpc?:(signal:AbortSignal)=>Rpc;
 enabled:()=>boolean;buyEnabled?:(wallet:string)=>boolean;allows:(wallet:string)=>boolean;owner:ReturnType<typeof signerEnrollment>;
 authenticate:(token:string)=>Promise<string>;
 ownership:(binding:Omit<OwnerBinding,'ownerId'>,delegated:boolean,signal:AbortSignal)=>Promise<OwnerBinding>;
 provider:(request:PrivySignRequest,signal:AbortSignal)=>Promise<string>;
}){
 const store=directExitStore(config.databaseUrl),resolveWallet=config.owner.resolve;
 const options={...config,store,resolveWallet,assertTerms:(t:DirectExitTerms)=>{if(isLimitBuy(t)&&!config.buyEnabled?.(t.wallet))throw Error('Limit buys are not enabled.');if(config.pilot)assertDirectExitPilot(config.pilot,t);}},swap=directExitSwap(config.rpc,config.apiKey);
 const engine=directExitEngine({...options,...swap});
 return {
  orders:directExitOrders(options),delivery:directExitDelivery(options),
  observe:directExitScheduler({store,enabled:config.enabled,allows:config.allows,tick:engine.tick}),
  observationQueue:()=>store.observationQueue(),
  recover:(signal:AbortSignal)=>directExitRecovery({...options,blockRpc:config.blockRpc?.(signal)})(signal),
 };
}
