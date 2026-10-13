import {compilePumpLaunch} from './pump-launch.js';
import {MAINNET_GENESIS} from './solana-network.js';
import {Connection,PublicKey,AddressLookupTableAccount,AddressLookupTableProgram} from '@solana/web3.js';
import {createRequire} from 'node:module';
import {resolvePumpQuote} from './pump-pair-resolver.js';
import {pairTableTransaction,inspectPairTable,type PumpPairTablePlan} from '../src/pump-pair-table.js';
const require=createRequire(import.meta.url),sdk=require('@pump-fun/pump-sdk-next') as typeof import('@pump-fun/pump-sdk-next');
export async function preparePumpPairTable(connection:Connection,owner:string,quoteMint:string):Promise<PumpPairTablePlan>{
 const q=await resolvePumpQuote(connection,quoteMint);
 const addresses=[q.mint,sdk.QUOTE_CONTROL_PDA,...(q.source==='pumpCoin'?[sdk.bondingCurvePda(q.mint),...Object.values(q.pumpQuote!.accounts.pool||{})]:[])].map(k=>k.toBase58());
 const [slot,block,rentLamports]=await Promise.all([connection.getSlot('finalized'),connection.getLatestBlockhash('confirmed'),connection.getMinimumBalanceForRentExemption(56+32*addresses.length)]);
 const {transaction,table}=pairTableTransaction({owner,addresses,slot,blockhash:block.blockhash});
 const fee=(await connection.getFeeForMessage(transaction.message,'confirmed')).value;
 if(fee!==5000)throw Error('Pair setup network fee differs from the review.');
 const result=await connection.simulateTransaction(transaction,{sigVerify:false,commitment:'confirmed',accounts:{encoding:'base64',addresses:[owner,table]}});
 if(result.value.err)throw Error('Pair address setup simulation failed.');
 const accounts=result.value.accounts;
 if(!accounts?.[1]||accounts[1].owner!==AddressLookupTableProgram.programId.toBase58()||accounts[1].lamports!==rentLamports)throw Error('Pair address rent did not match the simulation.');
 const state=AddressLookupTableAccount.deserialize(Buffer.from(accounts[1].data[0],'base64'));
 if(state.authority||state.addresses.map(k=>k.toBase58()).join()!==addresses.join())throw Error('Pair table did not freeze the exact reviewed addresses.');
 const plan:PumpPairTablePlan={version:1,owner,quoteMint,addresses,table,slot,blockhash:block.blockhash,lastValidBlockHeight:block.lastValidBlockHeight,rentLamports,feeLamports:fee,unsigned:Buffer.from(transaction.serialize()).toString('base64')};
 inspectPairTable(plan,owner,quoteMint,rentLamports);return plan;
}

// Some create + buy packets need mint-specific addresses as well as quote
// addresses. Choose the smallest additional prefix that fits; never split the
// atomic creation and purchase into separate transactions.
export function pumpLaunchTableAddresses(built:Awaited<ReturnType<typeof import('./pump-launch.js').pumpLaunchInstructions>>,existing:AddressLookupTableAccount[],blockhash:string){
 if(built.purchase.quoteMint==='So11111111111111111111111111111111111111112')throw Error('Use the established SOL launch tables.');
 const programs=new Set(built.instructions.map(ix=>ix.programId.toBase58()));
 const covered=new Set(existing.flatMap(t=>t.state.addresses.map(a=>a.toBase58())));
 const candidates=[...new Map(built.instructions.flatMap(ix=>ix.keys.filter(k=>!k.isSigner).map(k=>[k.pubkey.toBase58(),k.pubkey] as const))).values()]
  .filter(k=>![built.launcher,built.mint].includes(k.toBase58())&&!programs.has(k.toBase58())&&!covered.has(k.toBase58()));
 const quote=new PublicKey(built.purchase.quoteMint);
 const ordered=[quote,...candidates.filter(k=>!k.equals(quote))];
 const tableKey=AddressLookupTableProgram.createLookupTable({authority:new PublicKey(built.launcher),payer:new PublicKey(built.launcher),recentSlot:1})[1];
 for(let length=1;length<=Math.min(24,ordered.length);length++){
  const addresses=ordered.slice(0,length),table=new AddressLookupTableAccount({key:tableKey,state:{addresses,deactivationSlot:18446744073709551615n,lastExtendedSlot:0,lastExtendedSlotStartIndex:0}});
  try{const compiled=compilePumpLaunch(built,blockhash,[...existing,table]);return {addresses:addresses.map(k=>k.toBase58()),bytes:compiled.bytes};}catch(error){if(!(error instanceof Error)||!error.message.includes('lookup table'))throw error;}
 }
 throw Error('The complete paired launch does not fit a supported address setup.');
}

export async function preparePumpLaunchTable(connection:Connection,built:Awaited<ReturnType<typeof import('./pump-launch.js').pumpLaunchInstructions>>,existing:AddressLookupTableAccount[],payer=built.launcher):Promise<PumpPairTablePlan>{
 if(await connection.getGenesisHash()!==MAINNET_GENESIS)throw Error('Mainnet required.');
 const [slot,block]=await Promise.all([connection.getSlot('finalized'),connection.getLatestBlockhash('confirmed')]);
 const {addresses}=pumpLaunchTableAddresses(built,existing,block.blockhash);
 const rentLamports=await connection.getMinimumBalanceForRentExemption(56+32*addresses.length);
 if(rentLamports>5000000)throw Error('Pair setup exceeds the reviewed rent limit.');
 const {transaction,table}=pairTableTransaction({owner:payer,addresses,slot,blockhash:block.blockhash});
 const [fee,before]=await Promise.all([connection.getFeeForMessage(transaction.message,'confirmed'),connection.getBalance(new PublicKey(payer),'confirmed')]);
 if(fee.value!==5000)throw Error('Pair setup network fee differs from review.');
 const result=await connection.simulateTransaction(transaction,{sigVerify:false,commitment:'confirmed',accounts:{encoding:'base64',addresses:[payer,table]}});
 if(result.value.err||!result.value.accounts?.[0]||!result.value.accounts[1])throw Error('Pair address setup simulation failed.');
 const [owner,account]=result.value.accounts;
 if(!Number.isSafeInteger(before)||!Number.isSafeInteger(owner.lamports)||before-owner.lamports!==rentLamports+5000||account.owner!==AddressLookupTableProgram.programId.toBase58()||account.lamports!==rentLamports)throw Error('Pair setup spending differs from review.');
 const state=AddressLookupTableAccount.deserialize(Buffer.from(account.data[0],'base64'));
 if(state.authority||state.deactivationSlot!==18446744073709551615n||state.addresses.map(k=>k.toBase58()).join()!==addresses.join())throw Error('Pair setup did not freeze the exact addresses.');
 const plan:PumpPairTablePlan={version:1,owner:payer,quoteMint:built.purchase.quoteMint,addresses,table,slot,blockhash:block.blockhash,lastValidBlockHeight:block.lastValidBlockHeight,rentLamports,feeLamports:5000,unsigned:Buffer.from(transaction.serialize()).toString('base64')};
 inspectPairTable(plan,payer,built.purchase.quoteMint,rentLamports);return plan;
}
