import {CASH_MINT} from '../src/cash-route.js';
import {validateCashCopyScope,type CashCopyScope} from '../src/cash-copy-model.js';
import {readFundingBalance} from './funding-balance.js';
import type {Rpc} from './funding.js';
// No reservations, quotes, signatures or provider mutations. This is a
// conservative first-buy balance check, not a promise about a future fill.
export async function cashCopyReadiness(scope:CashCopyScope,rpc:Rpc,enabled:boolean,signal:AbortSignal,now=Date.now){
 validateCashCopyScope(scope);signal.throwIfAborted();
 const [cash,native]=await Promise.all([readFundingBalance(scope.sourceWallet,CASH_MINT,rpc),rpc('getBalance',[scope.sourceWallet,{commitment:'confirmed'}])]);
 signal.throwIfAborted();const value=(native as {value?:unknown})?.value;
 if(cash.decimals!==6||typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw Error('Funding balance unavailable.');
 return {wallet:scope.sourceWallet,buyUsdcRaw:scope.buyUsdcRaw,maxSourceFeeLamports:scope.maxSourceFeeLamports,availableUsdcRaw:cash.rawAmount,nativeLamports:String(value),frozen:cash.frozen,enabled,checkedAt:now()};
}
