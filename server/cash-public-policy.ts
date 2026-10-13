import {isMint} from '../src/assets.js';
import {isCashNetwork,type CashNetwork} from '../src/cash-route.js';
import {validateCashCopyScope,type CashCopyScope} from '../src/cash-copy-model.js';
/** Public admission removes engineering wallet/token lists, never signed limits
 * or transaction verification. Networks require an explicit release decision. */
export function cashPublicPolicy(env:Record<string,string|undefined>){
 const mode=env.CASH_COPY_MODE||'pilot';if(!['pilot','public'].includes(mode))throw Error('Invalid cash copy mode.');
 if(mode==='pilot')return null;
 const networks=(env.CASH_COPY_PUBLIC_NETWORKS||'').split(',') as CashNetwork[];
 if(!networks.length||networks.some(n=>!isCashNetwork(n))||new Set(networks).size!==networks.length)throw Error('Public copy networks are missing.');
 for(const n of networks)for(const suffix of ['WS_URL','STREAM_RPC_URL']){
  const u=new URL(env[`CASH_${n.toUpperCase()}_${suffix}`]||'');if(u.protocol!==(suffix==='WS_URL'?'wss:':'https:')||u.username||u.password||u.hash)throw Error('Public copy requires private live RPC configuration.');
 }
 if((!env.FOMO_LOOKUP_API_KEY&&!(env.FOMO_LEADER_LOOKUP_ORIGIN&&env.FOMO_LEADER_LOOKUP_SECRET))||!env.RELAY_API_KEY)throw Error('Public copy provider configuration is missing.');
 const capacity=Number(env.CASH_COPY_PUBLIC_CAPACITY);
 if(!Number.isSafeInteger(capacity)||capacity<1||capacity>100)throw Error('Public copy capacity must be between 1 and 100.');
 return {mode:'public' as const,networks,capacity,allows:(wallet:string)=>isMint(wallet),
  allowsAsset:(network:string,token:string)=>networks.includes(network as CashNetwork)&&/^0x[0-9a-f]{40}$/.test(token)&&!/^0x0{40}$/.test(token),
  allowsScope:(scope:CashCopyScope)=>{try{validateCashCopyScope(scope);return scope.networks.every(n=>networks.includes(n));}catch{return false;}},
 };
}
