import {ownedCashLeaderLookup} from './cash-owned-leader.js';
import {cashPublicPolicy} from './cash-public-policy.js';
import {cashLeaderRegistry,cashLeaderProfileLookup} from './cash-leader-registry.js';
import {cashLiveVerifier} from './cash-live-verifier.js';
import {neon} from '@neondatabase/serverless';
import {isMint} from '../src/assets.js';
import {isCashNetwork,type CashNetwork} from '../src/cash-route.js';
import {hostedCashCopy,type CashLeaderBinding} from './cash-copy-hosted.js';
import {privateCashCopyCas} from './cash-copy-journal.js';
import {cashSigningParts} from './cash-copy-signing-parts.js';
import {cashEvmRpc} from './cash-evm-rpc.js';
import type {Rpc} from './funding.js';
import type {CashCopyScope} from '../src/cash-copy-model.js';
export function cashCopyHostConfig(env:Record<string,string|undefined>){
 for(const key of ['CASH_COPY_SERVICE_ENABLED','CASH_COPY_EXECUTION_ENABLED','CASH_COPY_LIVE_ENABLED'])if(env[key]!==undefined&&!['true','false'].includes(env[key]!))throw Error('Invalid cash copy flag.');
 if(env.CASH_COPY_EXECUTION_ENABLED==='true'&&env.CASH_COPY_SERVICE_ENABLED!=='true')throw Error('Cash copy service is missing.');
 if(env.CASH_COPY_SERVICE_ENABLED!=='true')return null;
 if(env.VERCEL||env.VERCEL_ENV)throw Error('Cash copy keys require an isolated host.');
 const need=(k:string)=>{if(!env[k])throw Error('Missing private cash copy configuration: '+k);return env[k]!;};
 const policy=(chain:string)=>({signerId:need(`CASH_${chain}_SIGNER_ID`),policyId:need(`CASH_${chain}_POLICY_ID`),policyDigest:need(`CASH_${chain}_POLICY_DIGEST`),publicKey:need(`CASH_${chain}_PUBLIC_KEY`),privateKey:need(`CASH_${chain}_AUTHORIZATION_PRIVATE_KEY`)});
 // Begin with an explicit engineering allowlist. General Fomo identity and
 // route coverage must be verified before a public-mode implementation exists.
 const publicPolicy=cashPublicPolicy(env);
 const wallets=(env.CASH_COPY_PILOT_WALLETS||'').split(',').filter(Boolean);
 if(wallets.some(w=>!isMint(w))||new Set(wallets).size!==wallets.length||wallets.length>5)throw Error('Invalid cash pilot wallets.');
 const leaders=JSON.parse(env.CASH_COPY_VERIFIED_LEADERS||'[]') as CashLeaderBinding[];
 if(!Array.isArray(leaders)||leaders.length>100||leaders.some(l=>!l||Object.keys(l).sort().join(',')!=='networks,sourceWallet,wallet'||!isMint(l.sourceWallet)||!/^0x[0-9a-f]{40}$/.test(l.wallet)||/^0x0{40}$/.test(l.wallet)||!Array.isArray(l.networks)||!l.networks.length||l.networks.some(n=>!isCashNetwork(n))||new Set(l.networks).size!==l.networks.length))throw Error('Invalid verified leader mapping.');
 const assets=JSON.parse(env.CASH_COPY_PILOT_ASSETS||'[]') as {network:string;token:string}[];
 if(!Array.isArray(assets)||assets.length>20||assets.some(a=>!a||Object.keys(a).sort().join(',')!=='network,token'||!isCashNetwork(a.network)||!/^0x[0-9a-f]{40}$/.test(a.token)||/^0x0{40}$/.test(a.token))||new Set(assets.map(a=>a.network+':'+a.token)).size!==assets.length)throw Error('Invalid cash pilot assets.');
 const limit=env.CASH_COPY_PILOT_LIMITS?JSON.parse(env.CASH_COPY_PILOT_LIMITS):null;
 if(limit&&(Object.keys(limit).sort().join(',')!=='buyUsdcRaw,dailyUsdcRaw,gasTopupUsdcRaw,maxDurationMs,recipient'||!/^0x[0-9a-f]{40}$/.test(limit.recipient)||/^0x0{40}$/.test(limit.recipient)||![limit.buyUsdcRaw,limit.dailyUsdcRaw,limit.gasTopupUsdcRaw].every(v=>typeof v==='string'&&/^[1-9]\d{0,9}$/.test(v))||BigInt(limit.buyUsdcRaw)>BigInt(limit.dailyUsdcRaw)||BigInt(limit.gasTopupUsdcRaw)>=BigInt(limit.buyUsdcRaw)||!Number.isSafeInteger(limit.maxDurationMs)||limit.maxDurationMs<600000||limit.maxDurationMs>3600000))throw Error('Invalid cash pilot limits.');
 if(!publicPolicy&&env.CASH_COPY_EXECUTION_ENABLED==='true'&&(!wallets.length||!leaders.length||!assets.length||!limit||!env.RELAY_API_KEY))throw Error('Copy execution needs an explicit test scope.');
 const saleGasCeilingWei=env.CASH_COPY_PILOT_SALE_GAS_CEILING_WEI;
 if(saleGasCeilingWei!==undefined&&!/^[1-9]\d{0,29}$/.test(saleGasCeilingWei))throw Error('Invalid additional sale gas ceiling.');
 if(publicPolicy&&[env.CASH_COPY_PILOT_WALLETS,env.CASH_COPY_PILOT_ASSETS,env.CASH_COPY_PILOT_LIMITS,saleGasCeilingWei].some(Boolean))throw Error('Remove engineering limits before public copy configuration.');
 if(publicPolicy&&env.CASH_COPY_EXECUTION_ENABLED==='true'&&(env.CASH_COPY_LIVE_ENABLED!=='true'||!env.CASH_SOLANA_STREAM_RPC_URL))throw Error('Public copying requires live verification.');
 const lookup=publicPolicy?cashLeaderProfileLookup(env.FOMO_LOOKUP_API_KEY||'',publicPolicy.networks):undefined;
 const direct=publicPolicy&&env.FOMO_LEADER_LOOKUP_ORIGIN?ownedCashLeaderLookup(env.FOMO_LEADER_LOOKUP_ORIGIN,need('FOMO_LEADER_LOOKUP_SECRET'),publicPolicy.networks):undefined;
 const registry=cashLeaderRegistry(publicPolicy?[]:leaders,publicPolicy?((source,signal,handle)=>direct&&handle?direct(source,signal,handle):env.FOMO_LOOKUP_API_KEY?lookup!(source,signal):Promise.reject(Error('Select a Fomo username.'))):undefined);
 return{publicPolicy,registry,reviewLimits:publicPolicy?undefined:limit||undefined,saleGasCeilingWei,solanaPolicy:policy('SOLANA'),evmPolicy:policy('EVM'),leaders,allows:publicPolicy?.allows||((wallet:string)=>wallets.includes(wallet)),allowsAsset:publicPolicy?.allowsAsset||((network:string,token:string)=>assets.some(a=>a.network===network&&a.token===token)),allowsScope:publicPolicy?.allowsScope||((scope:CashCopyScope)=>!!limit&&scope.recipient===limit.recipient&&scope.buyUsdcRaw===limit.buyUsdcRaw&&scope.dailyUsdcRaw===limit.dailyUsdcRaw&&scope.gasTopupUsdcRaw===limit.gasTopupUsdcRaw&&scope.expiresAt-scope.issuedAt<=limit.maxDurationMs)};
}
export function configuredHostedCashCopy(env:Record<string,string|undefined>,ready:()=>boolean,solana:Rpc,shutdown?:AbortSignal,monitorReady?:(leader:string,networks:CashNetwork[])=>boolean){
 const c=cashCopyHostConfig(env);if(!c)return null;const url=env.SIGNER_DATABASE_URL!;
 if(!url)throw Error('Private cash journal is not configured.');
 const liveVerify=env.CASH_COPY_LIVE_ENABLED==='true'?cashLiveVerifier({rpc:(network,signal)=>cashEvmRpc(network,fetch,{endpoint:env[`CASH_${network.toUpperCase()}_STREAM_RPC_URL`],signal,archive:false,timeoutMs:2500}),solana:signal=>async(m,p)=>{signal.throwIfAborted();const value=await solana(m,p);signal.throwIfAborted();return value;},sourceWallet:(leader,network)=>c.registry.source(leader,network)}):undefined;
 return hostedCashCopy({...c,liveVerify,shutdown,monitorReady,origin:env.SIGNER_WEB_ORIGIN!,appId:env.PRIVY_APP_ID!,appSecret:env.PRIVY_APP_SECRET!,cas:privateCashCopyCas(url,c.publicPolicy?.capacity),parts:cashSigningParts(url),solana,evm:cashEvmRpc,ready,enabled:()=>env.CASH_COPY_EXECUTION_ENABLED==='true',restoreLeaders:async()=>{
  const version=c.registry.version();
  const sql=neon(url,{fetchOptions:{signal:AbortSignal.timeout(5000)}});
  const rows=await sql`SELECT journal FROM signer_cash_journals WHERE journal->>'revoked'='false' AND (journal->'grant'->'scope'->>'expiresAt')::bigint>${Date.now()} ORDER BY plan_id LIMIT 101`;
  if(rows.length>100)throw Error('Copy monitor capacity exceeded.');
  const bindings=rows.flatMap(r=>{const d=r.journal as any;return !d.enrollment||!c.allowsScope(d.grant.scope)?[]:[{binding:{sourceWallet:d.enrollment.leaderSource,wallet:d.grant.scope.leader,networks:d.grant.scope.networks},expiresAt:d.grant.scope.expiresAt}];});
  if(c.publicPolicy)c.registry.replace(version,bindings);else for(const row of bindings)c.registry.restore(row.binding,row.expiresAt);
 },ownerPlans:async(wallet,userId,after)=>{
  const sql=neon(url,{fetchOptions:{signal:AbortSignal.timeout(5000)}});
  const rows=await sql`SELECT journal FROM signer_cash_journals WHERE wallet=${wallet} AND journal->'enrollment'->'solana'->>'userId'=${userId} AND journal->'enrollment'->'evm'->>'userId'=${userId} AND (${after}::uuid IS NULL OR plan_id>${after}::uuid) ORDER BY plan_id LIMIT 11`;
  return rows.map(r=>r.journal as import('./cash-copy-journal.js').CashCopyDocument);
 },plans:async after=>{
  // Stable keyset rotation visits every active or recovering plan without
  // starvation from a busy journal updating its own timestamp.
  const sql=neon(url,{fetchOptions:{signal:AbortSignal.timeout(5000)}});
  const rows=await sql`SELECT plan_id,wallet FROM signer_cash_journals WHERE (${after}::uuid IS NULL OR plan_id>${after}::uuid) AND ((journal->>'revoked'='false' AND (journal->'grant'->'scope'->>'expiresAt')::bigint>${Date.now()}) OR jsonb_path_exists(journal,'$.jobs.* ? (@.state != "complete" && @.state != "stopped")')) ORDER BY plan_id LIMIT 4`;
  return rows.map(r=>({planId:String(r.plan_id),wallet:String(r.wallet)}));
 }});
}
