import {quoteCashRoute} from './cash-route.js';
import {cashRelay} from './cash-relay.js';
import {prepareCashReturnQuote} from './cash-return-quote.js';
import {cashLimitExecutionPrice,validateCashLimitTerms,type CashLimitTerms,type CashLimitObservation} from '../src/cash-limit-model.js';
import type {CashNetwork} from '../src/cash-route.js';
import type {Rpc} from './funding.js';

// No chart subscription or extra paid market-data plan. These are fresh,
// independently inspected executable quote economics, not ticker prices.
export function cashLimitPrice(c:{evm:(network:CashNetwork)=>Rpc;fetcher?:typeof fetch;now?:()=>number}){
 const fetcher=c.fetcher||fetch,now=c.now||Date.now;
 return async(t:CashLimitTerms):Promise<CashLimitObservation>=>{
  validateCashLimitTerms(t);
  if(t.side==='buy'){
   const q=await quoteCashRoute({sourceWallet:t.sourceWallet,recipient:t.recipient,network:t.network,token:t.token,amountRaw:t.amountRaw,slippageBps:t.slippageBps,gasTopupUsdcRaw:t.gasTopupUsdcRaw},fetcher);
   if(q.outputDecimals!==t.tokenDecimals||q.expiresAt<=now())throw Error('Limit quote token units changed.');
   return {network:t.network,token:t.token,priceUsdc18:cashLimitExecutionPrice('buy',q.amountRaw,q.minimumRaw,t.tokenDecimals),observedAt:q.checkedAt};
  }
  const {simulation}=await prepareCashReturnQuote({network:t.network,wallet:t.recipient,cashWallet:t.sourceWallet,token:t.token,amountRaw:t.amountRaw,slippageBps:t.slippageBps},cashRelay(fetcher).quote,c.evm(t.network),now());
  if(simulation.expiresAt<=now())throw Error('Limit sale quote expired.');
  return{network:t.network,token:t.token,priceUsdc18:cashLimitExecutionPrice('sell',t.amountRaw,simulation.route.minimumRaw,t.tokenDecimals),observedAt:simulation.checkedAt};
 };
}
