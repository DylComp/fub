import {isMint} from '../src/assets.js';
import {isCashNetwork,type CashNetwork} from '../src/cash-route.js';
import {hostedCashLimits} from './cash-limit-hosted.js';
import {cashLimitPrice} from './cash-limit-price.js';
import {cashEvmRpc} from './cash-evm-rpc.js';
import type {Rpc} from './funding.js';
export function cashLimitPilotWallets(value:string|undefined){
 if(value===undefined||value==='')return [];
 const wallets=value.split(',');if(wallets.length>20||wallets.some(w=>!isMint(w))||new Set(wallets).size!==wallets.length)throw Error('Invalid limit pilot wallets.');return wallets;
}
export function configuredCashLimits(env:Record<string,string|undefined>,ready:()=>boolean,solana:Rpc,shutdown:AbortSignal){
 const pilotWallets=cashLimitPilotWallets(env.CASH_LIMIT_PILOT_WALLETS);
 for(const k of['CASH_LIMIT_SERVICE_ENABLED','CASH_LIMIT_EXECUTION_ENABLED'])if(env[k]!==undefined&&!['true','false'].includes(env[k]!))throw Error('Invalid limit flag.');
 if(env.CASH_LIMIT_EXECUTION_ENABLED==='true'&&env.CASH_LIMIT_SERVICE_ENABLED!=='true')throw Error('Limit service is missing.');
 if(env.CASH_LIMIT_SERVICE_ENABLED!=='true')return null;
 if(env.VERCEL||env.VERCEL_ENV)throw Error('Limit signing requires an isolated host.');
 const need=(k:string)=>{if(!env[k])throw Error('Missing limit configuration: '+k);return env[k]!;};
 const networks=(env.CASH_LIMIT_NETWORKS||'').split(',');if(!networks.length||networks.some(n=>!isCashNetwork(n))||new Set(networks).size!==networks.length)throw Error('Invalid limit network scope.');
 const policy=(chain:string)=>({signerId:need(`CASH_${chain}_SIGNER_ID`),policyId:need(`CASH_${chain}_POLICY_ID`),policyDigest:need(`CASH_${chain}_POLICY_DIGEST`),publicKey:need(`CASH_${chain}_PUBLIC_KEY`),privateKey:need(`CASH_${chain}_AUTHORIZATION_PRIVATE_KEY`)});
 need('RELAY_API_KEY');
 return hostedCashLimits({origin:need('SIGNER_WEB_ORIGIN'),databaseUrl:need('SIGNER_DATABASE_URL'),appId:need('PRIVY_APP_ID'),appSecret:need('PRIVY_APP_SECRET'),solanaPolicy:policy('SOLANA'),evmPolicy:policy('EVM'),solana,evm:cashEvmRpc,ready,enabled:()=>env.CASH_LIMIT_EXECUTION_ENABLED==='true',price:cashLimitPrice({evm:cashEvmRpc}),shutdown,pilotWallets,networks:networks as CashNetwork[]});
}
