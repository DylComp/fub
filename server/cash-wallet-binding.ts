import { createPublicKey, verify } from 'node:crypto';
import bs58 from 'bs58';
import { hashMessage, recoverMessageAddress, encodeFunctionData, parseAbi } from 'viem';
import { CASH_NETWORKS, type CashNetwork } from '../src/cash-route.js';
import { cashWalletMessage, type CashWalletChallenge } from '../src/cash-wallet-model.js';
export { cashWalletMessage, type CashWalletChallenge } from '../src/cash-wallet-model.js';
import type { Rpc } from './funding.js';
export type CashWalletBinding = {sourceWallet:string;recipient:string;network:CashNetwork;verifiedAt:number;expiresAt:number;accountType:'eoa'|'contract';tradingAuthorized:false};
// Both accounts sign the same scoped challenge. A username lookup, Solana
// signature, provider profile association or returned public address is not
// sufficient EVM ownership evidence. The caller consumes the nonce atomically.
export async function verifyCashWalletBinding(c:CashWalletChallenge, proof:{solana:string;evm:string}, rpc:Rpc, now=Date.now()):Promise<CashWalletBinding> {
  const message=cashWalletMessage(c);
  if (now<c.issuedAt || now>=c.expiresAt || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(proof.solana) || !/^0x[0-9a-f]{2,16384}$/i.test(proof.evm) || proof.evm.length%2!==0)
    throw Error('Wallet ownership challenge expired or is invalid.');
  const solana=bs58.decode(proof.solana), key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),bs58.decode(c.sourceWallet)]),format:'der',type:'spki'});
  if (solana.length!==64 || !verify(null,Buffer.from(message),key,solana)) throw Error('Solana wallet ownership was not verified.');
  const chain=await rpc('eth_chainId',[]);
  if (typeof chain!=='string' || !/^0x[0-9a-f]+$/i.test(chain) || BigInt(chain)!==BigInt(CASH_NETWORKS[c.network].chainId)) throw Error('Wallet verification is on the wrong chain.');
  const code=await rpc('eth_getCode',[c.recipient,'finalized']);
  if(typeof code!=='string'||!/^0x(?:[0-9a-f]{2})*$/i.test(code))throw Error('Wallet code unavailable.');
  let accountType:CashWalletBinding['accountType']='eoa';
  if(code==='0x'){
    // This only accepts the displayed address's own signature. An undeployed
    // smart account whose owner has a different address remains unsupported.
    const address=await recoverMessageAddress({message,signature:proof.evm as `0x${string}`});
    if(address.toLowerCase()!==c.recipient.toLowerCase())throw Error('EVM wallet ownership was not verified.');
  }else{
    accountType='contract';
    const data=encodeFunctionData({abi:parseAbi(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']),functionName:'isValidSignature',args:[hashMessage(message),proof.evm as `0x${string}`]});
    const result=await rpc('eth_call',[{to:c.recipient,data},'finalized']);
    if(typeof result!=='string'||!/^0x1626ba7e0{56}$/i.test(result))throw Error('Smart-wallet ownership was not verified.');
  }
  return {sourceWallet:c.sourceWallet,recipient:c.recipient.toLowerCase(),network:c.network,verifiedAt:now,expiresAt:now+3600000,accountType,tradingAuthorized:false};
}
