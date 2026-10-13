import {validateCashLimitTerms,limitRaw,cashLimitExecutionPrice,cashLimitReached,type CashLimitTerms} from '../src/cash-limit-model.js';
import type {CashRouteQuote} from '../src/cash-route.js';

// This is an additional order-consent check, not a replacement for the Relay
// deposit/return transaction verifier or fresh simulation.
export function inspectCashLimitPurchase(t:CashLimitTerms,q:CashRouteQuote,now:number):void {
 validateCashLimitTerms(t);
 if(t.side!=='buy'||now>=t.expiresAt||now<t.issuedAt||q.provider!=='relay'||q.source!=='solana-usdc'||!q.depositVerified||q.network!==t.network||q.token.toLowerCase()!==t.token||q.sourceWallet!==t.sourceWallet||q.refundWallet!==t.sourceWallet||q.recipient.toLowerCase()!==t.recipient||q.amountRaw!==t.amountRaw||q.outputDecimals!==t.tokenDecimals||q.gasTopup?.budgetUsdcRaw!==t.gasTopupUsdcRaw||!Number.isSafeInteger(q.checkedAt)||q.checkedAt>now||now-q.checkedAt>15000||!Number.isSafeInteger(q.expiresAt)||q.expiresAt<=now||limitRaw(q.minimumRaw)<limitRaw(t.minimumOutputRaw)||limitRaw(q.outputRaw)<limitRaw(q.minimumRaw))throw Error('Purchase quote exceeds the signed limit order.');
 if(!cashLimitReached(t,{network:t.network,token:t.token,priceUsdc18:cashLimitExecutionPrice('buy',q.amountRaw,q.minimumRaw,t.tokenDecimals),observedAt:now},now))throw Error('Purchase execution price exceeds the limit.');
}
export type CashLimitSaleReview={network:CashLimitTerms['network'];wallet:string;cashWallet:string;token:string;amountRaw:string;minimumUsdcRaw:string;maximumGasRaw:string;checkedAt:number;expiresAt:number};
export function inspectCashLimitSale(t:CashLimitTerms,q:CashLimitSaleReview,availableTokenRaw:string,availableGasRaw:string,now:number):void {
 validateCashLimitTerms(t);
 if(t.side!=='sell'||now>=t.expiresAt||now<t.issuedAt||q.network!==t.network||q.wallet.toLowerCase()!==t.recipient||q.cashWallet!==t.sourceWallet||q.token.toLowerCase()!==t.token||q.amountRaw!==t.amountRaw||limitRaw(q.minimumUsdcRaw)<limitRaw(t.minimumOutputRaw)||limitRaw(q.maximumGasRaw)>limitRaw(t.maxSaleGasRaw)||limitRaw(q.maximumGasRaw)>limitRaw(availableGasRaw)||limitRaw(availableTokenRaw)<limitRaw(t.amountRaw)||!Number.isSafeInteger(q.checkedAt)||q.checkedAt>now||now-q.checkedAt>15000||!Number.isSafeInteger(q.expiresAt)||q.expiresAt<=now)throw Error('Sale quote or balance exceeds the signed limit order.');
 if(!cashLimitReached(t,{network:t.network,token:t.token,priceUsdc18:cashLimitExecutionPrice('sell',q.amountRaw,q.minimumUsdcRaw,t.tokenDecimals),observedAt:now},now))throw Error('Sale execution price exceeds the limit.');
}

export function cashLimitSaleGas(gas:{maxL1FeeWei:string;transactions:{gas:string;maxFeePerGas:string}[]}):string {
 if(!Array.isArray(gas.transactions)||gas.transactions.length<1||gas.transactions.length>2)throw Error('Invalid limit sale gas transactions.');
 const total=gas.transactions.reduce((n,t)=>n+limitRaw(t.gas)*limitRaw(t.maxFeePerGas),limitRaw(gas.maxL1FeeWei));
 if(total<=0n||total>=2n**256n)throw Error('Invalid limit sale gas amount.');
 return String(total);
}
