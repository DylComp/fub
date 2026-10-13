import {quoteConversionChain,validateConversionPolicy,type ConversionPolicy} from './quote-conversion-chain.js';
import {quoteConversionStore} from './quote-conversion-store.js';
import {runQuoteConversion} from './quote-conversion-worker.js';
import {payoutConnection} from './launch-payout-host.js';
import {feeCronSigner} from './fee-signer.js';
import {blockRecoveryRpc} from './copy-block-recovery.js';
import {quoteAcceptance,quoteAcceptanceAllows} from './quote-acceptance.js';
export function quoteConversionConfig(env:NodeJS.ProcessEnv){
 if(env.VERCEL_ENV!=='production')throw Error('Production conversion runtime required.');
 if(env.QUOTE_CONVERSION_ENABLED!=='true')return null;
 if(!env.DATABASE_URL||!env.LAUNCH_BURN_WALLET)throw Error('Conversion configuration required.');
 const policy:ConversionPolicy={treasury:env.LAUNCH_BURN_WALLET,maxOverheadLamports:env.QUOTE_CONVERSION_MAX_OVERHEAD_LAMPORTS||'',dailyFeeCapLamports:env.QUOTE_CONVERSION_DAILY_FEE_CAP_LAMPORTS||'',minimumOutputLamports:env.QUOTE_CONVERSION_MIN_OUTPUT_LAMPORTS||'',slippageBps:100};
 validateConversionPolicy(policy);
 const mode=env.QUOTE_CONVERSION_MODE||'recover',acceptance=quoteAcceptance(env.QUOTE_ACCEPTANCE_POLICY,policy.treasury);
 if(!['recover','execute','acceptance'].includes(mode)||mode==='execute'&&env.QUOTE_CONVERSION_VERIFIED!=='true'||mode==='acceptance'&&!acceptance)throw Error('Verified conversion or explicit acceptance policy required.');
 const endpoint=new URL(env.SOLANA_RPC_URL||''),fallback=env.SOLANA_FALLBACK_RPC_URL?new URL(env.SOLANA_FALLBACK_RPC_URL):undefined;
 for(const u of [endpoint,...(fallback?[fallback]:[])])if(u.protocol!=='https:'||u.username||u.password||u.hash||u.hostname==='api.mainnet-beta.solana.com')throw Error('Dedicated HTTPS conversion RPC required.');
 if(fallback?.toString()===endpoint.toString())throw Error('Independent fallback required.');
 return{policy,mode,acceptance:mode==='acceptance'?acceptance:null,databaseUrl:env.DATABASE_URL,endpoint:endpoint.toString(),fallback:fallback?.toString()};
}
// Runs on the existing minute buyback schedule; no extra always-on server.
// It can collect SOL before the official mint is configured. Both spending
// workers share the same treasury reservation lock.
export async function runQuoteConversionCron(env:NodeJS.ProcessEnv){
 const c=quoteConversionConfig(env);if(!c)return null;
 const signal=AbortSignal.timeout(40000),store=quoteConversionStore(c.databaseUrl,c.policy,c.acceptance?.quoteMint);
 await store.register();
 const execute=c.mode==='execute'||c.mode==='acceptance'&&!!c.acceptance&&quoteAcceptanceAllows(c.acceptance,c.acceptance.quoteMint,c.policy.treasury),sign=execute?feeCronSigner(env.BUYBACK_CRON_KEY_JSON,c.policy.treasury):async()=>{throw Error('Recovery cannot sign.');};
 const authorize=c.acceptance?(mint:string,treasury:string)=>quoteAcceptanceAllows(c.acceptance!,mint,treasury):undefined;
 const result=await runQuoteConversion({store,chain:quoteConversionChain(payoutConnection(c.endpoint,signal,c.fallback),()=>blockRecoveryRpc(c.fallback||c.endpoint,signal)),execute,sign,signal,authorize});
 const health=await store.health();
 return{status:'completed',mode:c.mode,outcomes:[result.outcome],healthy:!signal.aborted&&health.unresolved===0&&!['retry','failed','budget_exhausted','expired_unresolved'].includes(result.outcome)&&(!execute||health.enabled===true)};
}
