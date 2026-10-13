import {PublicKey,Connection} from '@solana/web3.js';
import {inspectPairTable} from '../src/pump-pair-table.js';
import {feeCronSigner} from './fee-signer.js';
import {launchTableStore,type LaunchTableAttempt} from './pump-pair-table-journal.js';
import {launchTableService} from './pump-pair-table-recovery.js';
export type PairSponsorPolicy={payer:string;maxSetupLamports:number;dailyCapLamports:number;perOwnerLimit:number};
export function pairSponsorPolicy(env:NodeJS.ProcessEnv):PairSponsorPolicy|null{
 if(env.LAUNCH_PAIR_SPONSOR_ENABLED!=='true')return null;
 const payer=new PublicKey(env.LAUNCH_PAIR_SPONSOR_PAYER||'');
 if(!PublicKey.isOnCurve(payer.toBytes())||payer.toBase58()!==env.LAUNCH_PAIR_SPONSOR_PAYER||[env.LAUNCH_BURN_WALLET,env.FUB_DEVELOPMENT_WALLET,env.LAUNCH_PAYOUT_PAYER].includes(payer.toBase58()))throw Error('Separate pair-setup sponsor required.');
 const number=(key:string)=>{const raw=env[key];if(!raw||! /^[1-9][0-9]*$/.test(raw))throw Error('Explicit pair-setup spending limits required.');const n=Number(raw);if(!Number.isSafeInteger(n))throw Error('Invalid pair-setup limit.');return n;};
 const maxSetupLamports=number('LAUNCH_PAIR_SPONSOR_MAX_LAMPORTS'),dailyCapLamports=number('LAUNCH_PAIR_SPONSOR_DAILY_CAP_LAMPORTS'),perOwnerLimit=number('LAUNCH_PAIR_SPONSOR_PER_OWNER_LIMIT');
 if(maxSetupLamports<5000||maxSetupLamports>5005000||dailyCapLamports<maxSetupLamports||dailyCapLamports>1000000000||perOwnerLimit<1||perOwnerLimit>100)throw Error('Pair-setup limits exceed permitted bounds.');
 return{payer:payer.toBase58(),maxSetupLamports,dailyCapLamports,perOwnerLimit};
}
// This signer is reachable only after wallet-session authentication and exact
// publication/recipient validation. It pays frozen address-table rent only.
// It cannot sign a launch, buy, fee payout, token approval or user transaction.
export function pairSponsor(input:{policy:PairSponsorPolicy;connection:Connection;store:ReturnType<typeof launchTableStore>;service:ReturnType<typeof launchTableService>;sign:(unsigned:string,signal:AbortSignal)=>Promise<string>;signal:AbortSignal}){
 return{payer:input.policy.payer,async submit(a:LaunchTableAttempt){
  const {policy,connection,store,service,signal}=input;signal.throwIfAborted();
  if(a.plan.owner!==policy.payer||[a.intent.owner,a.intent.mint,a.intent.quoteMint].includes(policy.payer)||a.plan.rentLamports+a.plan.feeLamports>policy.maxSetupLamports)throw Error('Automatic setup does not match its funding policy.');
  if(a.state==='prepared'){
   const rent=await connection.getMinimumBalanceForRentExemption(56+32*a.plan.addresses.length);
   const packet=inspectPairTable(a.plan,policy.payer,a.intent.quoteMint,rent);
   if(packet.signatures.some(s=>s.some(Boolean)))throw Error('Expected unsigned infrastructure only.');
   signal.throwIfAborted();
   const signed=await input.sign(a.plan.unsigned,signal);signal.throwIfAborted();
   // Persist the exact signed packet and reserve its full rent+fee before send.
   a=await store.bindSponsored(a.id,a.intent.owner,signed,policy);
  }
  return service.recover(a.id,a.intent.owner,true);
 }};
}
export function configuredPairSponsor(env:NodeJS.ProcessEnv,connection:Connection,store:ReturnType<typeof launchTableStore>,service:ReturnType<typeof launchTableService>,signal:AbortSignal){
 const policy=pairSponsorPolicy(env);if(!policy)return undefined;
 const sign=feeCronSigner(env.LAUNCH_PAIR_SPONSOR_KEY_JSON,policy.payer);
 return pairSponsor({policy,connection,store,service,sign,signal});
}
