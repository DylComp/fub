import {getCompiledTransactionMessageDecoder,getTransactionDecoder} from '@solana/kit';
import {COMPUTE_PROGRAM} from '../src/copy-swap.js';
export const NATIVE_PRIORITY_MICROLAMPORTS=5000;
export function nativePriorityPrice(unsigned:string){
 const m=getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(unsigned,'base64')).messageBytes);
 if(m.version!==0)throw Error('Unsupported native message.');
 const prices=m.instructions.filter(i=>m.staticAccounts[i.programAddressIndex]===COMPUTE_PROGRAM&&i.data?.[0]===3);
 if(!prices.length)return 0;
 if(prices.length!==1||prices[0].accountIndices?.length||prices[0].data?.length!==9||Buffer.from(prices[0].data).readBigUInt64LE(1)!==BigInt(NATIVE_PRIORITY_MICROLAMPORTS))throw Error('Unsupported native priority fee.');
 return NATIVE_PRIORITY_MICROLAMPORTS;
}
