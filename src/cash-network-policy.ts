import {CASH_NETWORKS, type CashNetwork} from './cash-route.js';

// Engineering ceilings, not user approvals. Every execution also requires an
// explicit smaller-or-equal user budget and a fresh native-balance check.
export const CASH_GAS_POLICY = {
  base: {native:'ETH', maxNativeRaw:'1000000000000000', maxFeePerGas:'10000000000', minTip:'1000000', l1:'op'},
  bnb: {native:'BNB', maxNativeRaw:'10000000000000000', maxFeePerGas:'10000000000', minTip:'1000000', l1:'none'},
  monad: {native:'MON', maxNativeRaw:'100000000000000000000', maxFeePerGas:'1000000000000', minTip:'1000000000', l1:'none'},
  robinhood: {native:'ETH', maxNativeRaw:'1000000000000000', maxFeePerGas:'10000000000', minTip:'1000000', l1:'nitro'},
  arc: {native:'USDC', maxNativeRaw:'500000000000000000', maxFeePerGas:'1000000000000', minTip:'1000', l1:'none'},
  ethereum: {native:'ETH', maxNativeRaw:'5000000000000000', maxFeePerGas:'100000000000', minTip:'1000000', l1:'none'},
} as const satisfies Record<CashNetwork, {native:string;maxNativeRaw:string;maxFeePerGas:string;minTip:string;l1:string}>;
export function cashNetworkByChainId(chainId:number):CashNetwork {
  const match=(Object.keys(CASH_NETWORKS) as CashNetwork[]).find(n=>CASH_NETWORKS[n].chainId===chainId);
  if(!match)throw Error('Unsupported cash execution network.');
  return match;
}
export function cashGasBudget(network:CashNetwork, amount:string):bigint {
  if(!/^[1-9]\d{0,23}$/.test(amount)||BigInt(amount)>BigInt(CASH_GAS_POLICY[network].maxNativeRaw))throw Error('Invalid destination gas budget.');
  return BigInt(amount);
}
