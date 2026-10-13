import {customPairExecutionEnabled} from './launch-pair-config.js';
import {PublicKey} from '@solana/web3.js';
type LaunchContext={wallet:string;publicationId:string;quoteMint?:string};
type LaunchConfig={customPairsEnabled?:boolean;enabled:boolean;reasons:string[];buybackWallet:string;lookupTables:string[];pilotMaxDebitLamports?:string};
export function launchExecutionConfig(env:NodeJS.ProcessEnv=process.env,context?:LaunchContext,now=Date.now()):LaunchConfig{
 const reasons:string[]=[];const valid=(s?:string)=>{try{return !!s&&new PublicKey(s).toBase58()===s&&PublicKey.isOnCurve(new PublicKey(s).toBytes());}catch{return false;}};
 let pilotMaxDebitLamports:string|undefined;
 // The first supervised launch must not require a token that does not exist
 // yet, or falsely set public operations to verified. Bind admission to one
 // immutable published draft and its owner; the store permits one signed
 // attempt for that publication. Uncertain attempts remain recoverable.
 if(env.LAUNCH_PILOT_ENABLED==='true'){
  try{
   const p=JSON.parse(env.LAUNCH_PILOT_POLICY||'');
   if(!p||Array.isArray(p)||Object.keys(p).sort().join()!=='expiresAt,maxDebitLamports,publicationId,wallet'||!valid(p.wallet)||!/^[a-f0-9]{64}$/.test(p.publicationId)||!Number.isSafeInteger(p.expiresAt)||p.expiresAt<=now||p.expiresAt>now+86400000||typeof p.maxDebitLamports!=='string'||!/^[1-9][0-9]{3,9}$/.test(p.maxDebitLamports)||BigInt(p.maxDebitLamports)<5000n||BigInt(p.maxDebitLamports)>1000000000n||p.wallet!==context?.wallet||p.publicationId!==context?.publicationId)throw Error();
   pilotMaxDebitLamports=p.maxDebitLamports;
  }catch{reasons.push('Supervised launching is restricted to the approved owner and published draft, within its expiry.');}
 }
 // Fee recipients are wallets. The official mint is only needed by the buyback worker.
 if(!valid(env.LAUNCH_BURN_WALLET))reasons.push('Configure the dedicated Fub treasury wallet.');
 const lookupTables=(env.LAUNCH_LOOKUP_TABLES||'').split(',').map(s=>s.trim()).filter(Boolean);
 if(!lookupTables.length||lookupTables.length>3||new Set(lookupTables).size!==lookupTables.length||lookupTables.some(s=>{try{return new PublicKey(s).toBase58()!==s;}catch{return true;}}))reasons.push('Configure the verified launch address lookup tables.');
 if(!env.DATABASE_URL||!env.SOLANA_RPC_URL)reasons.push('Connect launch storage and the dedicated Solana RPC.');
 if(!pilotMaxDebitLamports){
  if(env.LAUNCH_OPERATIONS_VERIFIED!=='true')reasons.push('Verify funded launching, fee distribution and treasury recovery before opening launches.');
  if(env.LAUNCH_EXECUTION_ENABLED!=='true')reasons.push('Public launching is not activated.');
 }
 return {customPairsEnabled:customPairExecutionEnabled(env,context,now),enabled:reasons.length===0,reasons,buybackWallet:env.LAUNCH_BURN_WALLET||'',lookupTables,...(pilotMaxDebitLamports?{pilotMaxDebitLamports}:{})};
}
export function launchWithinBudget(config:LaunchConfig,plan:{quoteSpend?:unknown;maxWalletDebitLamports:string;buybackWallet:string}){
 if(!config.enabled||plan.quoteSpend&&!config.customPairsEnabled)return false;
 if(!config.pilotMaxDebitLamports)return true;
 return plan.buybackWallet===config.buybackWallet&&/^[0-9]+$/.test(plan.maxWalletDebitLamports)&&BigInt(plan.maxWalletDebitLamports)<=BigInt(config.pilotMaxDebitLamports);
}
