import { AccountLayout, MintLayout } from '@solana/spl-token';
import { getTransactionDecoder } from '@solana/kit';
import { associated, fromBase64, toBase64 } from '../src/transaction-review.js';
import { USDC, TOKEN_PROGRAM } from '../src/funding-model.js';
import { paymentRawAmount, paymentReference, type TransferTerms } from '../src/pay-verification.js';
import { payTransferTransaction, inspectPayTransfer, PAY_TRANSFER_FEE, type PayTransferReview } from '../src/pay-transfer-model.js';
import { MAINNET_GENESIS } from './solana-network.js';
import type {Rpc} from './funding.js';
const SYSTEM='11111111111111111111111111111111';
function integer(v:unknown){if(!Number.isSafeInteger(v)||Number(v)<0)throw Error('Invalid payment chain context.');return Number(v);}
function binary(a:any,owner:string,size:number){if(!a||a.owner!==owner||a.executable!==false||!Array.isArray(a.data)||a.data[1]!=='base64'||typeof a.data[0]!=='string'||a.data[0].length>2048)throw Error('Unsupported payment account.');const b=Buffer.from(a.data[0],'base64');if(b.length!==size||b.toString('base64')!==a.data[0])throw Error('Invalid payment account.');return b;}
function account(a:any,owner:string){const t=AccountLayout.decode(binary(a,TOKEN_PROGRAM,165));if(t.mint.toBase58()!==USDC||t.owner.toBase58()!==owner||t.state!==1||t.isNativeOption!==0)throw Error('An active USDC account is required.');return t;}
async function balances(sender:string,terms:TransferTerms,rpc:Rpc,minContextSlot=0){
 const source=await associated(sender,USDC),destination=await associated(terms.recipient,USDC);
 const r=await rpc('getMultipleAccounts',[[sender,USDC,source,destination],{encoding:'base64',commitment:'finalized',minContextSlot}]) as any;
 const slot=integer(r?.context?.slot),rows=r?.value;if(slot<minContextSlot||!Array.isArray(rows)||rows.length!==4)throw Error('Payment accounts unavailable.');
 binary(rows[0],SYSTEM,0);const mint=MintLayout.decode(binary(rows[1],TOKEN_PROGRAM,82));if(!mint.isInitialized||mint.decimals!==6)throw Error('USDC mint verification failed.');
 if(!rows[2])throw Error('This wallet does not have enough USDC for this share.');
 const from=account(rows[2],sender),to=rows[3]?account(rows[3],terms.recipient):null;
 return {source,destination,slot,sol:integer(rows[0].lamports),from,to};
}
export async function simulatePayTransfer(review:PayTransferReview,rpc:Rpc,signed?:string){
 await inspectPayTransfer(review,review.sender,review.terms,signed,false);
 if(await rpc('getGenesisHash',[])!==MAINNET_GENESIS)throw Error('Solana mainnet is required.');
 const before=await balances(review.sender,review.terms,rpc,review.slot),raw=BigInt(paymentRawAmount(review.terms));
 if(before.from.amount<raw)throw Error('This wallet does not have enough USDC for this share.');
 const rent=before.to?0:integer(await rpc('getMinimumBalanceForRentExemption',[165,{commitment:'finalized'}]));
 if(rent>Number(review.rentLamports)||before.sol<Number(review.feeLamports)+rent)throw Error('This wallet needs more SOL for the network fee and receiving account.');
 const encoded=signed||review.unsigned,tx=getTransactionDecoder().decode(fromBase64(encoded));
 const fee=await rpc('getFeeForMessage',[toBase64(new Uint8Array(tx.messageBytes)),{commitment:'finalized',minContextSlot:before.slot}]) as any;
 if(integer(fee?.context?.slot)<before.slot||String(fee?.value)!==PAY_TRANSFER_FEE)throw Error('The payment network fee changed.');
 const result=await rpc('simulateTransaction',[encoded,{encoding:'base64',sigVerify:!!signed,replaceRecentBlockhash:false,commitment:'finalized',minContextSlot:before.slot,accounts:{encoding:'base64',addresses:[review.sender,before.source,before.destination]}}]) as any;
 if(integer(result?.context?.slot)<before.slot||result?.value?.err!==null||result.value.accounts?.length!==3)throw Error('Payment simulation failed. Refresh balances before trying again.');
 const [payer,source,destination]=result.value.accounts;binary(payer,SYSTEM,0);
 const afterFrom=account(source,review.sender),afterTo=account(destination,review.terms.recipient);
 if(before.from.amount-afterFrom.amount!==raw||afterTo.amount-(before.to?.amount||0n)!==raw||before.sol-integer(payer.lamports)!==Number(review.feeLamports)+rent||afterFrom.delegateOption!==before.from.delegateOption||afterFrom.delegate.toBase58()!==before.from.delegate.toBase58()||afterFrom.delegatedAmount!==before.from.delegatedAmount||afterFrom.closeAuthorityOption!==before.from.closeAuthorityOption||afterFrom.closeAuthority.toBase58()!==before.from.closeAuthority.toBase58())throw Error('Simulation differs from the exact payment.');
}
export async function preparePayTransfer(sender:string,terms:TransferTerms,rpc:Rpc):Promise<PayTransferReview>{
 // Validate wallet/terms before any network work.
 await payTransferTransaction(sender,terms,sender);
 if(await rpc('getGenesisHash',[])!==MAINNET_GENESIS)throw Error('Solana mainnet is required.');
 const before=await balances(sender,terms,rpc),latest=await rpc('getLatestBlockhash',[{commitment:'finalized',minContextSlot:before.slot}]) as any;
 const slot=integer(latest?.context?.slot),height=integer(latest?.value?.lastValidBlockHeight);if(slot<before.slot)throw Error('Payment blockhash is stale.');
 const review:PayTransferReview={version:1,sender,terms,reference:await paymentReference(terms),unsigned:await payTransferTransaction(sender,terms,latest.value.blockhash),blockhash:latest.value.blockhash,lastValidBlockHeight:height,slot,preparedAt:Date.now(),feeLamports:PAY_TRANSFER_FEE,rentLamports:String(before.to?0:integer(await rpc('getMinimumBalanceForRentExemption',[165,{commitment:'finalized'}])))};
 await simulatePayTransfer(review,rpc);return review;
}
