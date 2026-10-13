import {readToken22Inventory} from './token2022-inventory.js';
import {inspectStandardNativeMint,standardNativeBytes,verifyStandardNativeAccount} from './standard-native-accounts.js';
import {associated} from '../src/transaction-review.js';
import {TOKEN_PROGRAM} from '../src/funding-model.js';
import {TOKEN_2022} from './jupiter-routes.js';
import {record} from '../src/live-orders.js';
import {isMint} from '../src/assets.js';
import type {Rpc} from './funding.js';
// Callers with an execution review must pass its exact program. Corrections can
// discover the immutable mint owner, then reverify it at a fresh finalized slot.
export async function readNativeInventory(wallet:string,mint:string,rpc:Rpc,minContextSlot:number,program?:string){
 if(!isMint(wallet)||!isMint(mint)||!Number.isSafeInteger(minContextSlot)||minContextSlot<0)throw Error('Invalid native inventory request.');
 if(program===undefined){
  const reply=record(await rpc('getMultipleAccounts',[[mint],{encoding:'base64',commitment:'finalized',minContextSlot}])),slot=record(reply.context).slot;
  if(!Number.isSafeInteger(slot)||(slot as number)<Math.max(1,minContextSlot)||!Array.isArray(reply.value)||reply.value.length!==1)throw Error('Mint owner unavailable.');
  program=String(record(reply.value[0]).owner);minContextSlot=slot as number;
 }
 if(program===TOKEN_2022)return readToken22Inventory(wallet,mint,rpc,minContextSlot);
 if(program!==TOKEN_PROGRAM)throw Error('Unsupported native token program.');
 const source=await associated(wallet,mint,TOKEN_PROGRAM);
 const reply=record(await rpc('getMultipleAccounts',[[mint,source],{encoding:'base64',commitment:'finalized',minContextSlot}])),slot=record(reply.context).slot;
 if(!Number.isSafeInteger(slot)||(slot as number)<Math.max(1,minContextSlot)||!Array.isArray(reply.value)||reply.value.length!==2)throw Error('Current native inventory unavailable.');
 inspectStandardNativeMint(reply.value[0],mint);const decimals=standardNativeBytes(reply.value[0])[44];
 const base={wallet,mint,source,decimals,slot:slot as number,fetchedAt:Date.now()};
 if(reply.value[1]===null)return {...base,rawAmount:'0',exists:false};
 verifyStandardNativeAccount(reply.value[1],wallet,mint);
 return {...base,rawAmount:standardNativeBytes(reply.value[1]).readBigUInt64LE(64).toString(),exists:true};
}
