import {encodeFunctionData,parseAbi} from 'viem';
import {CASH_NETWORKS,isCashNetwork,type CashNetwork} from '../src/cash-route.js';
import {isEvmAddress} from '../src/networks.js';
import {validateCashLimitTerms,type CashLimitTerms} from '../src/cash-limit-model.js';
import type {Rpc} from './funding.js';
const abi=parseAbi(['function balanceOf(address owner) view returns (uint256)','function decimals() view returns (uint8)']);
function hex(v:unknown){if(typeof v!=='string'||!/^0x[0-9a-f]{1,64}$/i.test(v))throw Error('Token balances unavailable.');return BigInt(v);}
export async function cashLimitAssetBalances(network:CashNetwork,token:string,recipient:string,rpc:Rpc):Promise<{tokenDecimals:number;tokenRaw:string;gasRaw:string}>{
 if(!isCashNetwork(network)||!isEvmAddress(token)||!isEvmAddress(recipient)||/^0x0{40}$/i.test(token)||/^0x0{40}$/i.test(recipient))throw Error('Invalid limit asset.');
 const t={network,token,recipient};
 if(hex(await rpc('eth_chainId',[]))!==BigInt(CASH_NETWORKS[t.network].chainId))throw Error('Wrong limit balance network.');
 const block=await rpc('eth_getBlockByNumber',['latest',false]) as {number?:string;hash?:string};
 if(!block||!/^0x[0-9a-f]+$/i.test(block.number||'')||!/^0x[0-9a-f]{64}$/i.test(block.hash||''))throw Error('Limit balance block unavailable.');
 const [raw,gas,decimals]=await Promise.all([
  rpc('eth_call',[{to:t.token,data:encodeFunctionData({abi,functionName:'balanceOf',args:[t.recipient as `0x${string}`]})},block.number]),
  rpc('eth_getBalance',[t.recipient,block.number]),
  rpc('eth_call',[{to:t.token,data:encodeFunctionData({abi,functionName:'decimals'})},block.number]),
 ]);
 if(typeof raw!=='string'||!/^0x[0-9a-f]{64}$/i.test(raw)||typeof decimals!=='string'||!/^0x[0-9a-f]{64}$/i.test(decimals))throw Error('Invalid token balance encoding.');
 const again=await rpc('eth_getBlockByNumber',[block.number,false]) as {hash?:string};
 if(again?.hash?.toLowerCase()!==block.hash!.toLowerCase()||hex(decimals)>36n)throw Error('Limit token identity or balance block changed.');
 return{tokenDecimals:Number(hex(decimals)),tokenRaw:String(hex(raw)),gasRaw:String(hex(gas))};
}

export async function cashLimitBalances(t:CashLimitTerms,rpc:Rpc):Promise<{tokenRaw:string;gasRaw:string}>{
 validateCashLimitTerms(t);const b=await cashLimitAssetBalances(t.network,t.token,t.recipient,rpc);
 if(b.tokenDecimals!==t.tokenDecimals)throw Error('Limit token decimals changed.');return b;
}
