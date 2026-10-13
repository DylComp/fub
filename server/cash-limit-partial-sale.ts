import type {CashSale} from './cash-return-store.js';
import {encodeFunctionData,parseAbi} from 'viem';
import {CASH_GAS_POLICY} from '../src/cash-network-policy.js';
import {confirmedCashEvm,serializeCashEvm} from './cash-return-transaction.js';
import type {Rpc} from './funding.js';
const quantity=(v:unknown)=>{if(typeof v!=='string'||!/^0x(0|[1-9a-f][0-9a-f]*)$/i.test(v))throw Error('Invalid partial sale chain response.');return BigInt(v);};
// Resume only the already-signed sale after its exact approval is canonically included. Never
// construct a quote or signature, and never treat an unrelated nonce as ours.
export async function inspectCashLimitPartialSale(p:CashSale,rpc:Rpc,now=Date.now(),checked=confirmedCashEvm):Promise<boolean>{
 if(!p.signed||p.signed.length!==2||p.gas.transactions.length!==2||!p.simulation.route.approval)return false;
 const approval=await checked(p.gas.transactions[0],p.signed[0],rpc);
 if(approval.state==='pending')return false;if(approval.state!=='confirmed'||!approval.feeWei)throw Error('Limit approval reverted.');
 const tx=p.gas.transactions[1],sale=await checked(tx,p.signed[1],rpc);
 if(sale.state!=='pending')throw Error('Limit sale already settled.');
 if(now>=Math.min(p.gas.expiresAt,p.simulation.expiresAt)||p.gas.checkedAt>now||p.simulation.checkedAt>now)throw Error('Signed limit sale expired.');
 const[latest,pending,balance,block]=await Promise.all([rpc('eth_getTransactionCount',[tx.from,'latest']),rpc('eth_getTransactionCount',[tx.from,'pending']),rpc('eth_getBalance',[tx.from,'latest']),rpc('eth_getBlockByNumber',['latest',false])]);
 if(quantity(latest)!==BigInt(tx.nonce)||quantity(pending)!==BigInt(tx.nonce))throw Error('Another wallet transaction owns the sale nonce.');
 const base=quantity((block as any)?.baseFeePerGas);
 if(base+BigInt(tx.maxPriorityFeePerGas)>BigInt(tx.maxFeePerGas))throw Error('Saved sale fee bid is stale.');
 let l1=BigInt(p.gas.maxL1FeeWei);
 if(CASH_GAS_POLICY[p.simulation.route.intent.network].l1==='op'){const value=await rpc('eth_call',[{to:'0x420000000000000000000000000000000000000F',data:encodeFunctionData({abi:parseAbi(['function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)']),functionName:'getL1FeeUpperBound',args:[BigInt((serializeCashEvm(tx).length-2)/2+256)]})},'latest']);if(typeof value!=='string'||!/^0x[0-9a-f]{64}$/i.test(value))throw Error('Sale data fee unavailable.');const fresh=BigInt(value)*2n;if(fresh>l1)l1=fresh;}
 const remaining=BigInt(tx.gas)*BigInt(tx.maxFeePerGas)+l1;
 if(remaining>quantity(balance)||remaining+BigInt(approval.feeWei)>BigInt(p.gas.maxCostWei))throw Error('Partial sale exceeds its gas budget.');
 const hex=(n:string)=>'0x'+BigInt(n).toString(16);
 const result=await rpc('eth_call',[{from:tx.from,to:tx.to,data:tx.data,value:'0x0',gas:hex(tx.gas),maxFeePerGas:hex(tx.maxFeePerGas),maxPriorityFeePerGas:hex(tx.maxPriorityFeePerGas)},'latest']);
 if(typeof result!=='string'||!/^0x(?:[0-9a-f]{2})*$/i.test(result))throw Error('Partial sale simulation failed.');
 return true;
}
