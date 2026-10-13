import {cashCopyRaw,type CashCopyScope} from './cash-copy-model';
export type CashCopyReadiness={wallet:string;buyUsdcRaw:string;maxSourceFeeLamports:string;availableUsdcRaw:string;nativeLamports:string;frozen:boolean;enabled:boolean;checkedAt:number};
export function readCashCopyReadiness(value:unknown,scope:CashCopyScope,now=Date.now()):CashCopyReadiness{
 const r=value as CashCopyReadiness;
 if(!r||r.wallet!==scope.sourceWallet||r.buyUsdcRaw!==scope.buyUsdcRaw||r.maxSourceFeeLamports!==scope.maxSourceFeeLamports||typeof r.enabled!=='boolean'||typeof r.frozen!=='boolean'||!Number.isSafeInteger(r.checkedAt)||r.checkedAt>now+1000||now-r.checkedAt>30000)throw Error('Refresh the wallet funding check.');
 cashCopyRaw(r.availableUsdcRaw);cashCopyRaw(r.nativeLamports);return r;
}
const units=(raw:bigint,decimals:number)=>{const scale=10n**BigInt(decimals),fraction=String(raw%scale).padStart(decimals,'0').replace(/0+$/,'');return String(raw/scale)+(fraction?'.'+fraction:'');};
export function cashCopyFundingIssue(r:CashCopyReadiness):string|null{
 if(!r.enabled)return 'Automatic cross-chain copying is paused by the service. No new wallet permission is needed while it is paused.';
 if(r.frozen)return 'This wallet’s USDC account is frozen. It cannot fund copied buys.';
 const cash=cashCopyRaw(r.buyUsdcRaw)-cashCopyRaw(r.availableUsdcRaw),gas=cashCopyRaw(r.maxSourceFeeLamports)-cashCopyRaw(r.nativeLamports),needs=[];
 if(cash>0n)needs.push(units(cash,6)+' USDC for the first copied buy');
 if(gas>0n)needs.push(units(gas,9)+' SOL to cover the maximum source fee and account rent');
 return needs.length?'Your funding wallet needs '+needs.join(' and ')+'. Add it, then retry. No copy permission was requested.':null;
}
