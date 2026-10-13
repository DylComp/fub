import {createHash} from 'node:crypto';
import bs58 from 'bs58';
import {PublicKey} from '@solana/web3.js';
import {getAssociatedTokenAddressSync,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {CASH_MINT} from '../src/cash-route.js';
import {isMint} from '../src/assets.js';
import {MAINNET_GENESIS} from './solana-network.js';
import type {Rpc} from './funding.js';
import {leaderFormatEvidence} from './copy-format.js';
export const LEADER_DEPOSITORY='99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2';
const CONFIG='Dodg2HifwU8rmaVVyMyUZDGTRbqAJTyVYxXPwcbNpBKc';
const VAULT='7uTT8Xi5RWXzy7h9XL244GRgEycDYDhLjr3ZyNdXi8pZ';
const discriminator=createHash('sha256').update('global:deposit_token').digest().subarray(0,8);
// Read finalized source evidence independently of Relay's index. Only direct
// leader-signed USDC deposits are supported; CPI/multi-deposit routes wait for
// an explicit adapter rather than treating an arbitrary debit as a purchase.
type DepositInput={wallet:string;signature:string;orderId:string;amountRaw:string};
export function readCashLeaderDeposit(input:DepositInput,rpc:Rpc){return readDeposit(input,rpc,'finalized');}
export async function readCashLeaderProvisionalDeposit(input:DepositInput,rpc:Rpc,now=Date.now){
 const value=await readDeposit(input,rpc,'confirmed');if(!value)return null;
 const response=await rpc('getSignatureStatuses',[[input.signature],{searchTransactionHistory:false}]) as any;
 const status=response?.value?.[0];
 if(!Array.isArray(response?.value)||response.value.length!==1||!status||status.err!==null||status.slot!==value.slot||!['confirmed','finalized'].includes(status.confirmationStatus)||!Number.isSafeInteger(response.context?.slot)||response.context.slot<value.slot||now()-value.blockTime>10000||now()<value.blockTime)return null;
 return {...value,confirmation:'provisional' as const};
}
// A source notification supplies a signature only. Derive its commitment from
// the signed instruction and independently verify accounts and USDC balances.
export async function readCashSourceDeposit(input:{wallet:string;signature:string},rpc:Rpc,now=Date.now){
 if(!isMint(input.wallet)||!/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(input.signature))throw Error('Invalid source hint.');
 const receipt=await rpc('getTransaction',[input.signature,{encoding:'jsonParsed',commitment:'confirmed',maxSupportedTransactionVersion:1}]) as any;
 if(!receipt||receipt.meta?.err!==null)return null;
 const instructions=receipt.transaction?.message?.instructions;
 if(!Array.isArray(instructions))throw Error('Missing source instructions.');
 const deposits=instructions.filter((i:any)=>i.programId===LEADER_DEPOSITORY);if(!deposits.length)return null;if(deposits.length!==1||typeof deposits[0].data!=='string'||deposits[0].data.length>100)throw Error('Ambiguous source deposit.');
 const bytes=Buffer.from(bs58.decode(deposits[0].data));if(bytes.length!==48||!bytes.subarray(0,8).equals(discriminator))throw Error('Unknown source deposit.');
 const details={...input,amountRaw:bytes.readBigUInt64LE(8).toString(),orderId:'0x'+bytes.subarray(16).toString('hex')};
 const checked=await readCashLeaderProvisionalDeposit(details,(method,params)=>method==='getTransaction'&&params[0]===input.signature?Promise.resolve(receipt):rpc(method,params),now);
 return checked?{...checked,wallet:input.wallet}:null;
}
async function readDeposit(input:DepositInput,rpc:Rpc,commitment:'confirmed'|'finalized'){
 if(!isMint(input.wallet)||!/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(input.signature)||!/^0x[0-9a-f]{64}$/.test(input.orderId)||! /^(0|[1-9]\d{0,19})$/.test(input.amountRaw)||BigInt(input.amountRaw)<=0n||BigInt(input.amountRaw)>=2n**64n)throw Error('Invalid leader payment.');
 if(await rpc('getGenesisHash',[])!==MAINNET_GENESIS)throw Error('Wrong leader funding network.');
 const r=await rpc('getTransaction',[input.signature,{encoding:'jsonParsed',commitment,maxSupportedTransactionVersion:1}]) as any;
 if(!r)return null;
 if(r.meta?.err!==null)return null;
 const message=r.transaction?.message,keys=message?.accountKeys;
 leaderFormatEvidence(r);
 // A sponsor may pay the network fee, but the actual USDC owner must still
 // sign and occupy the exact depositor/authority slots checked below.
 if(r.transaction?.signatures?.[0]!==input.signature||!Number.isSafeInteger(r.slot)||r.slot<=0||!Number.isSafeInteger(r.blockTime)||r.blockTime<=0||!Array.isArray(keys)||keys.length>256||new Set(keys.map((k:any)=>k.pubkey)).size!==keys.length||!keys.some((k:any)=>k.pubkey===input.wallet&&k.signer===true)||!Array.isArray(message.instructions)||message.instructions.length>64)throw Error('Invalid leader funding receipt.');
 const deposits=message.instructions.filter((i:any)=>i.programId===LEADER_DEPOSITORY);
 if(deposits.length!==1)throw Error('Ambiguous leader deposit.');
 const i=deposits[0],mint=new PublicKey(CASH_MINT),source=getAssociatedTokenAddressSync(mint,new PublicKey(input.wallet)).toBase58(),vault=getAssociatedTokenAddressSync(mint,new PublicKey(VAULT),true).toBase58();
 const accounts=[CONFIG,input.wallet,input.wallet,VAULT,CASH_MINT,source,vault,TOKEN_PROGRAM_ID.toBase58(),ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),'11111111111111111111111111111111'];
 if(JSON.stringify(i.accounts)!==JSON.stringify(accounts)||typeof i.data!=='string'||i.data.length>100)throw Error('Leader deposit accounts changed.');
 const data=Buffer.from(bs58.decode(i.data));
 if(data.length!==48||!data.subarray(0,8).equals(discriminator)||data.readBigUInt64LE(8)!==BigInt(input.amountRaw)||'0x'+data.subarray(16).toString('hex')!==input.orderId)throw Error('Leader deposit commitment changed.');
 function amount(rows:any,account:string,owner:string){
  const indices=keys.flatMap((k:any,n:number)=>k.pubkey===account?[n]:[]);
  if(indices.length!==1||!Array.isArray(rows))throw Error('Leader USDC balance missing.');
  const found=rows.filter((v:any)=>v.accountIndex===indices[0]);
  if(found.length!==1||found[0].owner!==owner||found[0].mint!==CASH_MINT||found[0].programId!==TOKEN_PROGRAM_ID.toBase58()||found[0].uiTokenAmount?.decimals!==6||! /^(0|[1-9]\d{0,19})$/.test(found[0].uiTokenAmount?.amount))throw Error('Invalid leader USDC balance.');
  return BigInt(found[0].uiTokenAmount.amount);
 }
 const paid=amount(r.meta.preTokenBalances,source,input.wallet)-amount(r.meta.postTokenBalances,source,input.wallet),received=amount(r.meta.postTokenBalances,vault,VAULT)-amount(r.meta.preTokenBalances,vault,VAULT);
 if(paid!==BigInt(input.amountRaw)||received!==paid)throw Error('Leader deposit balance mismatch.');
 return{slot:r.slot as number,blockTime:r.blockTime*1000,amountRaw:input.amountRaw,orderId:input.orderId,signature:input.signature};
}
