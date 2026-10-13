import {readCopyInventory,UnsupportedCopyToken} from './copy-inventory.js';
import {readToken22Inventory} from './token2022-inventory.js';
import {readNativeInventory} from './native-inventory.js';
import {TOKEN_2022} from './jupiter-routes.js';
import {USDC,WSOL,TOKEN_PROGRAM} from '../src/funding-model.js';
import type {Rpc} from './funding.js';
export async function readDirectExitInventory(wallet:string,mint:string,rpc:Rpc,standardNative=false){
  try{const balance=await readCopyInventory(wallet,mint,rpc,0);return standardNative?{...await readNativeInventory(wallet,mint,rpc,balance.slot,TOKEN_PROGRAM),outputMint:WSOL,tokenProgram:TOKEN_PROGRAM}:{...balance,outputMint:USDC,tokenProgram:TOKEN_PROGRAM};}
  catch(error){
    // Network failures never trigger a fallback. The Token-2022 reader verifies
    // mint ownership, extensions and the exact associated account independently.
    if(!(error instanceof UnsupportedCopyToken))throw error;
    return {...await readToken22Inventory(wallet,mint,rpc,0),outputMint:WSOL,tokenProgram:TOKEN_2022};
  }
}
