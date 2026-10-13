import {parseTransaction,recoverTransactionAddress,toHex,type TransactionSerialized} from 'viem';
import type {UnsignedTransactionRequest} from '@privy-io/react-auth';
import type {CashEvmTransaction} from '../server/cash-return-transaction';

// Privy's Unified signing path passes non-hex quantities to viem.toHex.
// A decimal string there is encoded as UTF-8, not an integer. Its UI's
// normalization also retains gasLimit while adding a bigint gas field; the
// signer prefers gasLimit. Hex quantities work through both paths and keep
// nonce zero explicit instead of triggering automatic nonce selection.
export function cashSaleWalletRequest(tx:CashEvmTransaction):UnsignedTransactionRequest {
 return {type:2,chainId:tx.chainId,from:tx.from,to:tx.to,data:tx.data,
  value:toHex(BigInt(tx.value)),nonce:toHex(tx.nonce),gasLimit:toHex(BigInt(tx.gas)),
  maxFeePerGas:toHex(BigInt(tx.maxFeePerGas)),maxPriorityFeePerGas:toHex(BigInt(tx.maxPriorityFeePerGas))};
}

export async function inspectCashWalletSale(tx:CashEvmTransaction,raw:`0x${string}`){
 const parsed=parseTransaction(raw),changed:string[]=[];
 if(parsed.type!=='eip1559')changed.push('transaction type');
 if(parsed.chainId!==tx.chainId)changed.push('network');
 if(parsed.to?.toLowerCase()!==tx.to.toLowerCase())changed.push('recipient');
 if(parsed.data?.toLowerCase()!==tx.data.toLowerCase())changed.push('instruction');
 if(parsed.nonce!==tx.nonce)changed.push('nonce');
 if((parsed.value||0n)!==BigInt(tx.value))changed.push('native amount');
 if(parsed.gas!==BigInt(tx.gas))changed.push('gas limit');
 if(parsed.maxFeePerGas!==BigInt(tx.maxFeePerGas))changed.push('fee cap');
 if(parsed.maxPriorityFeePerGas!==BigInt(tx.maxPriorityFeePerGas))changed.push('priority fee');
 if(parsed.accessList?.length)changed.push('access list');
 if((await recoverTransactionAddress({serializedTransaction:raw as TransactionSerialized})).toLowerCase()!==tx.from.toLowerCase())changed.push('signer');
 if(changed.length){
  // Only field names and public numeric limits, never signatures, serialized
  // transactions, calldata, keys or authentication state.
  const diagnostic={changed,expected:{nonce:tx.nonce,gas:tx.gas,maxFeePerGas:tx.maxFeePerGas,maxPriorityFeePerGas:tx.maxPriorityFeePerGas},
   actual:{nonce:parsed.nonce,gas:parsed.gas?.toString(),maxFeePerGas:parsed.maxFeePerGas?.toString(),maxPriorityFeePerGas:parsed.maxPriorityFeePerGas?.toString()}};
  try{if(typeof sessionStorage!=='undefined')sessionStorage.setItem('fub.cash-sale-layout.v1',JSON.stringify(diagnostic));}catch{/* Storage is optional. */}
  throw Error(`The wallet changed the sale: ${changed.join(', ')}. Nothing was submitted.`);
 }
}
