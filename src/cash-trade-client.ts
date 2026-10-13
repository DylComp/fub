import type {CashNetwork} from './cash-route';
import {walletSessionRequest} from './wallet-session-client';
export type CashPilot={publicAccess?:boolean;network:CashNetwork;gasTopupUsdcRaw?:string;maxGasRaw?:string;executionEnabled:boolean;pilotWallet:boolean;automaticCopyingEnabled:false;purchaseId?:string;saleId?:string;token?:string;buyCapRaw?:string};
export async function cashTradeRequest<T>(body:object,wallet:string):Promise<T>{
 const session=await walletSessionRequest<{address:string|null;csrf?:string}>('status');
 if(session.address!==wallet||!session.csrf)throw Error('Verify your connected Solana wallet first.');
 const response=await fetch('/api/wallet-session?action=cash-trade',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-Fomo-Request':'1','X-Fub-Csrf':session.csrf},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
 const result=await response.json();if(!response.ok)throw Error(result.message||'Check the existing trade before retrying.');return result;
}
