import {isMint} from './assets.js';
import {isEvmAddress} from './networks.js';
import {isFubProductionOrigin} from './fub-origin.js';
import {isCashNetwork,type CashNetwork} from './cash-route.js';
import {cashGasBudget} from './cash-network-policy.js';

// Independent permission: copy-trading consent never authorizes a limit order.
// All amounts are integer base units. Price is USDC scaled by 10^18, preserving
// sub-cent tokens without floating-point comparisons.
export type CashLimitTerms = {
 version:1;id:string;origin:string;sourceWallet:string;recipient:string;
 network:CashNetwork;token:string;side:'buy'|'sell';direction:'at-or-below'|'at-or-above';
 triggerPriceUsdc18:string;amountRaw:string;minimumOutputRaw:string;tokenDecimals:number;
 slippageBps:number;gasTopupUsdcRaw:string;maxSourceFeeLamports:string;maxSaleGasRaw:string;
 issuedAt:number;acceptBy:number;expiresAt:number;
};
const keys='acceptBy,amountRaw,direction,expiresAt,gasTopupUsdcRaw,id,issuedAt,maxSaleGasRaw,maxSourceFeeLamports,minimumOutputRaw,network,origin,recipient,side,slippageBps,sourceWallet,token,tokenDecimals,triggerPriceUsdc18,version';
const address=(v:unknown)=>typeof v==='string'&&isEvmAddress(v)&&v===v.toLowerCase()&&!/^0x0{40}$/.test(v);
export function limitRaw(value:unknown):bigint {
 if(typeof value!=='string'||!/^(0|[1-9]\d{0,77})$/.test(value)||BigInt(value)>=2n**256n)throw Error('Invalid limit amount.');
 return BigInt(value);
}
export function validateCashLimitTerms(t:CashLimitTerms):CashLimitTerms {
 if(!t||Object.keys(t).sort().join(',')!==keys||t.version!==1||!/^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.test(t.id)||!isFubProductionOrigin(t.origin)||!isMint(t.sourceWallet)||!address(t.recipient)||!address(t.token)||!isCashNetwork(t.network)||!['buy','sell'].includes(t.side)||!['at-or-below','at-or-above'].includes(t.direction))throw Error('Invalid cross-chain limit terms.');
 if(!Number.isInteger(t.tokenDecimals)||t.tokenDecimals<0||t.tokenDecimals>36||!Number.isInteger(t.slippageBps)||t.slippageBps<1||t.slippageBps>100||limitRaw(t.triggerPriceUsdc18)<=0n||limitRaw(t.amountRaw)<=0n||limitRaw(t.minimumOutputRaw)<=0n)throw Error('Invalid cross-chain limit size or price.');
 const topup=limitRaw(t.gasTopupUsdcRaw),sourceFee=limitRaw(t.maxSourceFeeLamports);
 if(t.side==='buy'){
  if(limitRaw(t.amountRaw)<1000000n||limitRaw(t.amountRaw)>10000000000n||topup<=0n||topup>500000n||topup>=limitRaw(t.amountRaw)||sourceFee<=0n||sourceFee>2510000n||t.maxSaleGasRaw!=='0')throw Error('Invalid limit buy budgets.');
 }else{
  if(topup!==0n||sourceFee!==0n)throw Error('A limit sell cannot authorize a USDC purchase.');
  cashGasBudget(t.network,t.maxSaleGasRaw);
 }
 if(![t.issuedAt,t.acceptBy,t.expiresAt].every(Number.isSafeInteger)||t.issuedAt<=0||t.acceptBy!==t.issuedAt+300000||t.expiresAt<t.issuedAt+600000||t.expiresAt>t.issuedAt+86400000)throw Error('Invalid limit permission duration.');
 return t;
}
export function cashLimitPermissionMessage(t:CashLimitTerms):string {
 validateCashLimitTerms(t);
 return ['Fub cross-chain limit order permission',`Origin: ${t.origin}`,`Order: ${t.id}`,`Funding and return wallet: ${t.sourceWallet}`,`Trading wallet: ${t.recipient}`,`Network: ${t.network}`,`Token: ${t.token}`,`Token decimals: ${t.tokenDecimals}`,`Side: ${t.side}`,`Trigger: ${t.direction} ${t.triggerPriceUsdc18} USDC scaled by 10^18`,
 `Exact input: ${t.amountRaw} raw ${t.side==='buy'?'Solana USDC':'token units'}`,`Minimum output: ${t.minimumOutputRaw} raw ${t.side==='buy'?'token units':'Solana USDC'}`,`Slippage ceiling: ${t.slippageBps} basis points`,`Destination gas allocation included in buy: ${t.gasTopupUsdcRaw} raw USDC`,`Maximum source fee and rent: ${t.maxSourceFeeLamports} lamports`,`Maximum sale gas: ${t.maxSaleGasRaw} native base units`,`Issued: ${t.issuedAt}`,`Accept before: ${t.acceptBy}`,`Expires: ${t.expiresAt}`,
 'One execution only. No copy trades. No unrelated transfers. A price observation does not authorize a worse minimum output. Return sale proceeds only to the funding wallet.'].join('\n');
}
export type CashLimitObservation={network:CashNetwork;token:string;priceUsdc18:string;observedAt:number};
export function cashLimitReached(t:CashLimitTerms,p:CashLimitObservation,now:number):boolean {
 validateCashLimitTerms(t);
 if(!Number.isSafeInteger(now)||now<t.issuedAt||now>=t.expiresAt||p.network!==t.network||p.token!==t.token||!Number.isSafeInteger(p.observedAt)||p.observedAt>now||now-p.observedAt>5000||limitRaw(p.priceUsdc18)<=0n)throw Error('Limit price is unavailable or stale.');
 return t.direction==='at-or-below'?limitRaw(p.priceUsdc18)<=limitRaw(t.triggerPriceUsdc18):limitRaw(p.priceUsdc18)>=limitRaw(t.triggerPriceUsdc18);
}

// Buy: total USDC debited / guaranteed tokens. Sell: guaranteed USDC returned /
// exact tokens sold. Native network fees are separately capped in permission.
// Round buys upward and sells downward so rounding never creates a trigger.
export function cashLimitExecutionPrice(side:'buy'|'sell',inputRaw:string,minimumOutputRaw:string,tokenDecimals:number):string {
 if(!['buy','sell'].includes(side)||!Number.isInteger(tokenDecimals)||tokenDecimals<0||tokenDecimals>36)throw Error('Invalid execution price units.');
 const input=limitRaw(inputRaw),output=limitRaw(minimumOutputRaw);
 if(input<=0n||output<=0n)throw Error('Invalid execution price amount.');
 const scale=10n**BigInt(tokenDecimals)*10n**12n;
 const n=side==='buy'?input*scale:output*scale,d=side==='buy'?output:input;
 const value=side==='buy'?(n+d-1n)/d:n/d;
 if(value<=0n||value>=2n**256n)throw Error('Execution price is outside supported precision.');
 return String(value);
}
