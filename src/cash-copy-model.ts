import {CASH_NETWORKS,isCashNetwork,type CashNetwork} from './cash-route.js';
import {isEvmAddress} from './networks.js';
import {isMint} from './assets.js';
import {cashGasBudget} from './cash-network-policy.js';
import {isFubProductionOrigin} from './fub-origin.js';
export type CashCopyScope={version:1;id:string;planId:string;planVersion:number;origin:string;sourceWallet:string;recipient:string;leader:string;networks:CashNetwork[];buyUsdcRaw:string;dailyUsdcRaw:string;slippageBps:number;copySells:boolean;gasTopupUsdcRaw:string;maxSourceFeeLamports:string;maxSaleGas:Partial<Record<CashNetwork,string>>;issuedAt:number;acceptBy:number;expiresAt:number};
const uuid=(s:unknown)=>typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
export const cashCopyRaw=(s:unknown):bigint=>{if(typeof s!=='string'||!/^(0|[1-9]\d{0,77})$/.test(s)||BigInt(s)>=2n**256n)throw Error('Invalid copy amount.');return BigInt(s);};
export function validateCashCopyScope(s:CashCopyScope){
 if(!s||Object.keys(s).sort().join(',')!=='acceptBy,buyUsdcRaw,copySells,dailyUsdcRaw,expiresAt,gasTopupUsdcRaw,id,issuedAt,leader,maxSaleGas,maxSourceFeeLamports,networks,origin,planId,planVersion,recipient,slippageBps,sourceWallet,version'||s.version!==1||!uuid(s.id)||!uuid(s.planId)||!isFubProductionOrigin(s.origin)||!isMint(s.sourceWallet)||!isEvmAddress(s.recipient)||!isEvmAddress(s.leader)||s.recipient!==s.recipient.toLowerCase()||s.leader!==s.leader.toLowerCase()||s.leader===s.recipient||/^0x0{40}$/.test(s.recipient)||/^0x0{40}$/.test(s.leader)||!Number.isSafeInteger(s.planVersion)||s.planVersion<1||!Array.isArray(s.networks)||s.networks.length<1||s.networks.length>6||s.networks.some(n=>!isCashNetwork(n))||new Set(s.networks).size!==s.networks.length)throw Error('Invalid cross-chain copy scope.');
 const buy=cashCopyRaw(s.buyUsdcRaw),daily=cashCopyRaw(s.dailyUsdcRaw),topup=cashCopyRaw(s.gasTopupUsdcRaw);
 if(cashCopyRaw(s.maxSourceFeeLamports)<=0n||cashCopyRaw(s.maxSourceFeeLamports)>2510000n||buy<1000000n||buy>10000000000n||daily<buy||daily>10000000000n||topup<=0n||topup>500000n||topup>=buy||!Number.isInteger(s.slippageBps)||s.slippageBps<1||s.slippageBps>100||typeof s.copySells!=='boolean'||!s.maxSaleGas||Object.keys(s.maxSaleGas).sort().join(',')!==[...s.networks].sort().join(','))throw Error('Invalid cross-chain copy limits.');
 for(const network of s.networks)cashGasBudget(network,s.maxSaleGas[network]!);
 if(![s.issuedAt,s.acceptBy,s.expiresAt].every(Number.isSafeInteger)||s.issuedAt<1||s.acceptBy!==s.issuedAt+300000||s.expiresAt<s.issuedAt+600000||s.expiresAt>s.issuedAt+86400000)throw Error('Invalid cross-chain copy duration.');
 return s;
}
export function cashCopyPermissionMessage(s:CashCopyScope){
 validateCashCopyScope(s);
 return ['Fub cross-chain copy permission',`Origin: ${s.origin}`,`Permission: ${s.id}`,`Plan: ${s.planId} version ${s.planVersion}`,`Funding wallet: ${s.sourceWallet}`,`Trading wallet: ${s.recipient}`,`Leader: ${s.leader}`,
 ...s.networks.slice().sort().map(n=>`Network: ${n} (${CASH_NETWORKS[n].chainId}); maximum sale gas: ${s.maxSaleGas[n]} native units`),`Buy: ${s.buyUsdcRaw} raw Solana USDC`,`Daily cap: ${s.dailyUsdcRaw} raw Solana USDC across these networks`,`Gas allocation: ${s.gasTopupUsdcRaw} raw USDC included in each buy`,`Maximum Solana fee and rent per buy: ${s.maxSourceFeeLamports} lamports`,`Slippage: ${s.slippageBps} basis points`,`Proportional sells: ${s.copySells}`,`Issued: ${s.issuedAt}`,`Accept before: ${s.acceptBy}`,`Expires: ${s.expiresAt}`,'Only copy verified leader swaps. Sell only this plan’s acquired positions. Return sale proceeds to the funding wallet. No unrelated transfers.'].join('\n');
}
export type CashCopyEvent={network:CashNetwork;leader:string;transaction:string;blockHash:string;blockNumber:string;blockTime:number;observedAt:number;token:string;side:'buy'|'sell';leaderTokenBeforeRaw:string;leaderTokenDeltaRaw:string;confirmation?:'finalized'|'provisional'|'captured';transactionIndex?:string;sourceOrder?:{wallet:string;signature:string;orderId:string}};
export function validateCashCopyEvent(e:CashCopyEvent,s:CashCopyScope,now:number){
 validateCashCopyScope(s);
 if(!e||!s.networks.includes(e.network)||e.leader!==s.leader||!isEvmAddress(e.token)||e.token!==e.token.toLowerCase()||/^0x0{40}$/.test(e.token)||!/^0x[0-9a-f]{64}$/.test(e.transaction)||!/^0x[0-9a-f]{64}$/.test(e.blockHash)||!/^0x(0|[1-9a-f][0-9a-f]*)$/.test(e.blockNumber)||!Number.isSafeInteger(e.blockTime)||e.blockTime>now+5000||e.blockTime<s.issuedAt||!Number.isSafeInteger(e.observedAt)||e.observedAt<e.blockTime||e.observedAt>now+5000||now-e.observedAt>(e.confirmation==='captured'?120000:60000)||now-e.blockTime>1800000||now>=s.expiresAt||!['buy','sell'].includes(e.side)||cashCopyRaw(e.leaderTokenDeltaRaw)<=0n)throw Error('Invalid or stale cross-chain leader event.');
 if(e.confirmation!==undefined&&!['finalized','provisional','captured'].includes(e.confirmation))throw Error('Invalid leader confirmation.');
 if(e.confirmation==='provisional'&&(now-e.blockTime>10000||now-e.observedAt>10000||e.blockTime>now||e.observedAt>now))throw Error('Provisional leader event expired.');
 if(e.confirmation==='captured'&&(e.side!=='sell'||now-e.blockTime>120000||e.observedAt-e.blockTime>10000||e.blockTime>now||e.observedAt>now))throw Error('Captured leader sale expired.');
 if(e.transactionIndex!==undefined&&!/^0x(0|[1-9a-f][0-9a-f]*)$/.test(e.transactionIndex))throw Error('Invalid leader transaction index.');
 if(e.sourceOrder){const o=e.sourceOrder;if(e.side!=='buy'||Object.keys(o).sort().join(',')!=='orderId,signature,wallet'||!isMint(o.wallet)||! /^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(o.signature)||!/^0x[0-9a-f]{64}$/.test(o.orderId)||/^0x0{64}$/.test(o.orderId))throw Error('Invalid leader source order.');}
 const before=cashCopyRaw(e.leaderTokenBeforeRaw),delta=cashCopyRaw(e.leaderTokenDeltaRaw);
 if(e.side==='sell'&&(!s.copySells||delta>before))throw Error('Unsupported copied sale.');
 return e;
}
export function proportionalCashSale(position:string,event:CashCopyEvent):string {
 const p=cashCopyRaw(position),before=cashCopyRaw(event.leaderTokenBeforeRaw),sold=cashCopyRaw(event.leaderTokenDeltaRaw);
 if(event.side!=='sell'||before===0n||sold===0n||sold>before||p===0n)throw Error('Invalid proportional sale.');
 const amount=p*sold/before;if(amount===0n)throw Error('Copied sale is below one token unit.');return String(amount);
}

// Included transaction order, rather than notification arrival order.
export function compareCashCopyEvents(a:CashCopyEvent,b:CashCopyEvent){
 if(a.network!==b.network)return a.blockTime-b.blockTime;
 for(const [x,y] of [[a.blockNumber,b.blockNumber],[a.transactionIndex||'0x0',b.transactionIndex||'0x0']]){const left=BigInt(x),right=BigInt(y);if(left!==right)return left<right?-1:1;}
 return a.blockTime-b.blockTime;
}
