import {LaunchQuoteBalanceError} from './launch-errors.js';
import {preparePumpLaunchTable} from './pump-pair-table.js';
import {resolvePumpQuote} from './pump-pair-resolver.js';
import {inspectLaunch,type LaunchQuoteReview} from '../src/launch-signing.js';
import {proveLaunchNonlanding} from './launch-expiry.js';
import { SOL_PAIR_MINT, CUSTOM_PAIR_BLOCKER, pairAmount } from '../src/launch-pairs.js';
import { getCompiledTransactionMessageDecoder } from '@solana/kit';
import { verifyLoadedAddresses } from '../src/lookup-tables.js';
import type { Rpc } from './funding.js';
import { recoverWorkerReceipt } from './worker-block-recovery.js';
import { createRequire } from 'node:module';
import { AddressLookupTableAccount, AddressLookupTableProgram, Connection, PublicKey } from '@solana/web3.js';
import type { AccountInfo, VersionedTransactionResponse } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, unpackMint, unpackAccount, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { PublishedLaunch } from '../src/launch-publication.js';
import { initialBuyLamports } from '../src/launch-model.js';
import { compilePumpLaunch, pumpLaunchInstructions, verifyLaunchSharing } from './pump-launch.js';
import { launchAmount, launchPacket, validateLaunchPlan, validateLaunchExpiry, verifyLaunchSigned } from './launch-execution-model.js';
import type { LaunchExecutionPlan, LaunchExecutionReceipt } from './launch-execution-model.js';
import type {LookupProof} from '../src/lookup-tables.js';
import { MAINNET_GENESIS } from './solana-network.js';
const require=createRequire(import.meta.url);
const {PUMP_SDK,PUMP_PROGRAM_ID,PUMP_FEE_PROGRAM_ID,GLOBAL_PDA,PUMP_FEE_CONFIG_PDA,feeSharingConfigPda,bondingCurvePda}=require('@pump-fun/pump-sdk') as typeof import('@pump-fun/pump-sdk');
const NEXT=require('@pump-fun/pump-sdk-next') as typeof import('@pump-fun/pump-sdk-next');
const integer=(n:number)=>{if(!Number.isSafeInteger(n)||n<0)throw Error('Unsafe chain integer.');return BigInt(n);};
const info=(a:any):AccountInfo<Buffer>=>{if(!a||!Array.isArray(a.data)||a.data[1]!=='base64')throw Error('Missing simulated account.');return {...a,owner:new PublicKey(a.owner),data:Buffer.from(a.data[0],'base64')};};
export function verifyLaunchAccounts(p:Pick<LaunchExecutionPlan,'mint'|'publication'|'buybackWallet'|'openingTokens'>,accounts:(AccountInfo<Buffer>|null)[],checkBuy:boolean){
 const [mint,sharing,curve,token]=accounts;
 if(!mint?.owner.equals(TOKEN_2022_PROGRAM_ID)||!sharing?.owner.equals(PUMP_FEE_PROGRAM_ID)||!curve?.owner.equals(PUMP_PROGRAM_ID)||[mint,sharing,curve].some(a=>a.executable))throw Error('Unexpected launch account ownership.');
 const mintKey=new PublicKey(p.mint),m=unpackMint(mintKey,mint,TOKEN_2022_PROGRAM_ID);
 if(!m.isInitialized||m.decimals!==6)throw Error('Invalid launched mint.');
 const c=PUMP_SDK.decodeSharingConfig(sharing),state=(c as any).status;
 if(!state||Object.keys(state).length!==1||!('active' in state))throw Error('Sharing configuration is not active.');
 verifyLaunchSharing(c,p.mint,p.publication.recipient,p.buybackWallet);
 const custom=!!p.publication.draft.quoteMint&&p.publication.draft.quoteMint!==SOL_PAIR_MINT;
 const b=custom?NEXT.PUMP_SDK.decodeBondingCurve(curve):PUMP_SDK.decodeBondingCurve(curve);
 if(!b.creator.equals(feeSharingConfigPda(mintKey))||(custom?b.quoteMint.toBase58()!==p.publication.draft.quoteMint:(!b.quoteMint.equals(NATIVE_MINT)&&!b.quoteMint.equals(PublicKey.default)))||b.isMayhemMode||b.isCashbackCoin||b.isHolderReward)throw Error('Unexpected launch curve.');
 if(checkBuy&&launchAmount(p.openingTokens)>0n){
  if(!token)throw Error('Opening purchase missing.');
  const ata=getAssociatedTokenAddressSync(mintKey,new PublicKey(p.publication.owner),false,TOKEN_2022_PROGRAM_ID),t=unpackAccount(ata,token,TOKEN_2022_PROGRAM_ID);
  if(!t.mint.equals(mintKey)||t.owner.toBase58()!==p.publication.owner||t.isFrozen||t.amount!==launchAmount(p.openingTokens))throw Error('Opening purchase mismatch.');
 }
}
export function finalizedLaunchReceipt(p:LaunchExecutionPlan,signed:string,tx:VersionedTransactionResponse):LaunchExecutionReceipt|null{
 const signature=verifyLaunchSigned(p,signed),stored=launchPacket(signed);
 if(!tx.meta||tx.transaction.signatures[0]!==signature||!Buffer.from(tx.transaction.message.serialize()).equals(Buffer.from(stored.message.serialize()))||!Number.isSafeInteger(tx.slot)||tx.slot<p.contextSlot)throw Error('Finalized launch does not match the signed attempt.');
 verifyLoadedAddresses(getCompiledTransactionMessageDecoder().decode(stored.message.serialize()),p.review?.lookupTables,
  tx.meta.loadedAddresses ? {writable:tx.meta.loadedAddresses.writable.map(k=>k.toBase58()),readonly:tx.meta.loadedAddresses.readonly.map(k=>k.toBase58())} : undefined,tx.slot);
 const meta=tx.meta,keys=tx.transaction.message.getAccountKeys({accountKeysFromLookups:meta.loadedAddresses});
 if(meta.preBalances.length!==keys.length||meta.postBalances.length!==keys.length||keys.get(0)?.toBase58()!==p.publication.owner||integer(meta.fee)!==launchAmount(p.feeLamports))throw Error('Unexpected launch fee or accounts.');
 const debit=integer(meta.preBalances[0])-integer(meta.postBalances[0]);
 if(debit<integer(meta.fee)||debit>launchAmount(p.maxWalletDebitLamports))throw Error('Launch spending exceeded review.');
 if(meta.err){
  if(debit!==integer(meta.fee)||meta.preBalances.some((n,i)=>i>0&&integer(n)!==integer(meta.postBalances[i])))throw Error('Failed launch changed balances beyond its network fee.');
  if(p.quoteSpend)verifyFailedLaunchQuoteBalances(tx);
  return null;
 }
 const mintIndex=Array.from({length:keys.length},(_,i)=>i).find(i=>keys.get(i)?.toBase58()===p.mint);
 if(mintIndex===undefined||meta.preBalances[mintIndex]!==0||meta.postBalances[mintIndex]<=0)throw Error('Mint was not created by this launch.');
 let received=0n;
 if(launchAmount(p.openingTokens)>0n){
  if(!meta.preTokenBalances||!meta.postTokenBalances)throw Error('Opening buy receipt unavailable.');
  const ata=getAssociatedTokenAddressSync(new PublicKey(p.mint),new PublicKey(p.publication.owner),false,TOKEN_2022_PROGRAM_ID).toBase58();
  const rows=meta.postTokenBalances.filter(b=>keys.get(b.accountIndex)?.toBase58()===ata);
  if(rows.length!==1||rows[0].mint!==p.mint||rows[0].owner!==p.publication.owner||rows[0].programId!==TOKEN_2022_PROGRAM_ID.toBase58()||rows[0].uiTokenAmount.decimals!==6)throw Error('Opening buy owner mismatch.');
  const before=meta.preTokenBalances.filter(b=>b.accountIndex===rows[0].accountIndex);
  if(before.length>1||before.some(b=>b.mint!==p.mint||launchAmount(b.uiTokenAmount.amount)!==0n))throw Error('Opening token account was not empty.');
  received=launchAmount(rows[0].uiTokenAmount.amount);
  if(received!==launchAmount(p.openingTokens))throw Error('Opening buy token amount mismatch.');
 }
 const quoteDebit=p.quoteSpend?verifyLaunchQuoteDebit(p,tx):undefined;
 return {...(quoteDebit?{quoteDebit}:{}),slot:tx.slot,signature,mint:p.mint,owner:p.publication.owner,recipient:p.publication.recipient,buybackWallet:p.buybackWallet,networkFeeLamports:String(meta.fee),walletDebitLamports:debit.toString(),openingTokens:received.toString()};
}
export function launchExecutionChain(connection:Connection,recoveryRpc?:()=>Rpc,options:{customPairs?:boolean}={}){
 const mainnet=async()=>{if(await connection.getGenesisHash()!==MAINNET_GENESIS)throw Error('Mainnet required.');};
 return {
  async prepareTable(publication:PublishedLaunch,mint:string,buybackWallet:string,tableAddresses:string[],payer?:string){
   if(!options.customPairs||!publication.draft.quoteMint||publication.draft.quoteMint===SOL_PAIR_MINT)throw Error(CUSTOM_PAIR_BLOCKER);
   await mainnet();
   if(tableAddresses.length>=3||new Set(tableAddresses).size!==tableAddresses.length)throw Error('No address table slot available for this launch.');
   const result=await connection.getMultipleAccountsInfoAndContext([GLOBAL_PDA,PUMP_FEE_CONFIG_PDA,new PublicKey(mint),...tableAddresses.map(a=>new PublicKey(a))],{commitment:'finalized'});
   const [g,f,existing,...infos]=result.value;
   if(!g?.owner.equals(PUMP_PROGRAM_ID)||!f?.owner.equals(PUMP_FEE_PROGRAM_ID)||g.executable||f.executable||existing)throw Error('Pump terms unavailable or mint already exists.');
   const tables=infos.map((a,i)=>{
    if(!a?.owner.equals(AddressLookupTableProgram.programId)||a.executable)throw Error('Invalid launch lookup account.');
    const state=AddressLookupTableAccount.deserialize(a.data);if(state.lastExtendedSlot>=result.context.slot)throw Error('Lookup table is not active.');
    return new AddressLookupTableAccount({key:new PublicKey(tableAddresses[i]),state});
   });
   const quoteState=await resolvePumpQuote(connection,publication.draft.quoteMint);
   // Reject an unfunded opening buy before the platform pays table rent.
   const initial=pairAmount(publication.draft.initialBuy,quoteState.decimals);
   if(payer&&payer!==publication.owner&&initial>0n){
    const owner=new PublicKey(publication.owner),ata=getAssociatedTokenAddressSync(quoteState.mint,owner,false,quoteState.quoteTokenProgram);
    const account=await connection.getAccountInfo(ata,'finalized');
    const available=launchQuoteAccountAmount(ata,account,owner,quoteState.mint,quoteState.quoteTokenProgram);
    if(available<initial)throw new LaunchQuoteBalanceError(quoteState.mint.toBase58(),initial,available,quoteState.decimals);
   }
   const tableGlobal=NEXT.PUMP_SDK.decodeGlobal(g);
   const createBuybackQuoteAccount=pairAmount(publication.draft.initialBuy,quoteState.decimals)>0n?await launchBuybackQuoteSetup(connection,quoteState,tableGlobal):false;
   const built=await pumpLaunchInstructions({draft:publication.draft,launcher:publication.owner,mint,metadataUri:publication.metadataUrl,recipient:publication.recipient,buybackWallet,buyState:{global:tableGlobal,feeConfig:NEXT.PUMP_SDK.decodeFeeConfig(f)},quoteState,quoteControl:quoteState.quoteControl,customBuyVersion:3,createBuybackQuoteAccount});
   return preparePumpLaunchTable(connection,built,tables,payer);
  },
  async prepare(publication:PublishedLaunch,mint:string,buybackWallet:string,tableAddresses:string[],minContextSlot?:number):Promise<LaunchExecutionPlan>{
   const custom=!!publication.draft.quoteMint&&publication.draft.quoteMint!==SOL_PAIR_MINT;
   if(custom&&!options.customPairs)throw Error(CUSTOM_PAIR_BLOCKER);
   await mainnet();
   if(tableAddresses.length>3||new Set(tableAddresses).size!==tableAddresses.length)throw Error('Invalid launch lookup configuration.');
   const mintKey=new PublicKey(mint),owner=new PublicKey(publication.owner);
   const result=await connection.getMultipleAccountsInfoAndContext([GLOBAL_PDA,PUMP_FEE_CONFIG_PDA,mintKey,...tableAddresses.map(k=>new PublicKey(k))],{commitment:'finalized',...(minContextSlot===undefined?{}:{minContextSlot})});
   const [g,f,existing,...tables]=result.value;
   if(!g?.owner.equals(PUMP_PROGRAM_ID)||!f?.owner.equals(PUMP_FEE_PROGRAM_ID)||g.executable||f.executable||existing)throw Error('Pump terms unavailable or mint already exists.');
   const lookup=tables.map((a,i)=>{if(!a?.owner.equals(AddressLookupTableProgram.programId)||a.executable)throw Error('Invalid launch lookup account.');const state=AddressLookupTableAccount.deserialize(a.data);if(state.lastExtendedSlot>=result.context.slot)throw Error('Lookup table is not active at this slot.');return new AddressLookupTableAccount({key:new PublicKey(tableAddresses[i]),state});});
   const q=custom?await resolvePumpQuote(connection,publication.draft.quoteMint!):undefined;
   const global=custom?NEXT.PUMP_SDK.decodeGlobal(g):PUMP_SDK.decodeGlobal(g);
   let quoteReview:LaunchQuoteReview|undefined;
   if(q){
    if(q.source==='sol')throw Error('Custom pair resolved to SOL.');
    quoteReview={tokenProgram:q.quoteTokenProgram.toBase58(),decimals:q.decimals,source:q.source};
    if(q.pumpQuote?.accounts.pool){const underlying=NEXT.normalizeQuoteMint(q.pumpQuote.curve.bondingCurve.quoteMint),info=await connection.getAccountInfo(underlying,'finalized');if(!info||![TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID].some(k=>k.equals(info.owner)))throw Error('Quote pool token program unavailable.');quoteReview.pool={underlyingMint:underlying.toBase58(),underlyingTokenProgram:info.owner.toBase58()};}
   }
   const createBuybackQuoteAccount=q&&pairAmount(publication.draft.initialBuy,q.decimals)>0n?await launchBuybackQuoteSetup(connection,q,global):false;
   if(quoteReview&&pairAmount(publication.draft.initialBuy,q!.decimals)>0n)quoteReview.buy={version:3,slippageBps:100,createBuybackQuoteAccount};
   const terms={customBuyVersion:3 as const,createBuybackQuoteAccount,launcher:publication.owner,mint,metadataUri:publication.metadataUrl,recipient:publication.recipient,buybackWallet,buyState:{global,feeConfig:custom?NEXT.PUMP_SDK.decodeFeeConfig(f):PUMP_SDK.decodeFeeConfig(f)},quoteState:q,quoteControl:q?.quoteControl};
   let openingCurve:import('@pump-fun/pump-sdk-next').BondingCurve|undefined;
   let quoteContextSlot=result.context.slot;
   if(q&&pairAmount(publication.draft.initialBuy,q.decimals)>0n){
    // Pump-token starting reserves move with the quote coin. A finalized pool
    // estimate may already be several seconds behind a confirmed launch. Read
    // the exact create result before sizing the atomic opening purchase.
    const createOnly=await pumpLaunchInstructions({...terms,draft:{...publication.draft,initialBuy:'0'}});
    const block=await connection.getLatestBlockhash({commitment:'confirmed',minContextSlot:result.context.slot});
    const packet=compilePumpLaunch(createOnly,block.blockhash,lookup);
    const probe=await connection.simulateTransaction(launchPacket(packet.unsigned),{commitment:'confirmed',sigVerify:false,minContextSlot:result.context.slot,accounts:{encoding:'base64',addresses:[bondingCurvePda(mintKey).toBase58()]}});
    const account=probe.value.accounts?.[0];
    if(probe.value.err||!account||account.owner!==PUMP_PROGRAM_ID.toBase58()||account.executable)throw Error('The pair’s starting price could not be simulated.');
    openingCurve=NEXT.PUMP_SDK.decodeBondingCurve(info(account));quoteContextSlot=probe.context.slot;
   }
   const built=await pumpLaunchInstructions({...terms,draft:publication.draft,openingCurve});
   const latest=await connection.getLatestBlockhash({commitment:'confirmed',minContextSlot:quoteContextSlot});
   const compiled=compilePumpLaunch(built,latest.blockhash,lookup),tx=launchPacket(compiled.unsigned);
   const accountKeys=[owner,mintKey,feeSharingConfigPda(mintKey),bondingCurvePda(mintKey),getAssociatedTokenAddressSync(mintKey,owner,false,TOKEN_2022_PROGRAM_ID)];
   const quoteOwner=q?getAssociatedTokenAddressSync(q.mint,owner,false,q.quoteTokenProgram):undefined;
   const snapshot=q?await connection.getMultipleAccountsInfoAndContext([owner,quoteOwner!],{commitment:'confirmed',minContextSlot:quoteContextSlot}):null;
   if(snapshot&&!snapshot.value[0])throw Error('Launch wallet balance unavailable.');
   const before=snapshot?{context:snapshot.context,value:snapshot.value[0]!.lamports}:await connection.getBalanceAndContext(owner,{commitment:'confirmed',minContextSlot:result.context.slot});
   const quoteBefore=q?launchQuoteAccountAmount(quoteOwner!,snapshot!.value[1],owner,q.mint,q.quoteTokenProgram):0n;
   if(q&&quoteBefore<BigInt(built.purchase.maxQuoteRaw))throw new LaunchQuoteBalanceError(q.mint.toBase58(),BigInt(built.purchase.maxQuoteRaw),quoteBefore,q.decimals);
   if(q)accountKeys.push(quoteOwner!,...quoteSetupOwners(mintKey,owner,publication.recipient,buybackWallet).map(holder=>getAssociatedTokenAddressSync(q.mint,holder,true,q.quoteTokenProgram)));
   const simulation=await connection.simulateTransaction(tx,{commitment:'confirmed',sigVerify:false,minContextSlot:before.context.slot,accounts:{encoding:'base64',addresses:accountKeys.map(k=>k.toBase58())}});
   if(simulation.value.err||!simulation.value.accounts||simulation.value.accounts.length!==accountKeys.length)throw Error('Launch simulation failed.');
   const simulated=simulation.value.accounts.map(a=>a?info(a):null);
   if(!simulated[0])throw Error('Simulated owner missing.');
   const fee=(await connection.getFeeForMessage(tx.message,'confirmed')).value;
   if(fee===null||integer(fee)>100000n||fee<10000)throw Error('Launch fee unavailable or excessive.');
   const debit=integer(before.value)-integer(simulated[0].lamports);
   if(debit<BigInt(fee)||debit>(custom?0n:initialBuyLamports(publication.draft.initialBuy))+100_000_000n)throw Error('Unexpected simulated launch costs.');
   const lookupTables:LookupProof[]=tx.message.addressTableLookups.map(l=>{
    const table=lookup.find(t=>t.key.equals(l.accountKey))!;
    const select=(indexes:number[])=>indexes.map(index=>({index,address:table.state.addresses[index].toBase58()}));
    return {address:l.accountKey.toBase58(),contextSlot:result.context.slot,lastExtendedSlot:table.state.lastExtendedSlot,writable:select(l.writableIndexes),readonly:select(l.readonlyIndexes)};
   });
   const review={...(quoteReview?{quote:quoteReview}:{}),lookupTables,feeRecipients:built.purchase.tokenAmount==='0'?null:{fee:global.feeRecipient.toBase58(),buyback:global.buybackFeeRecipients.find(k=>!k.equals(PublicKey.default))!.toBase58()}};
   const plan:LaunchExecutionPlan={version:1,publication,mint,buybackWallet,unsigned:compiled.unsigned,lastValidBlockHeight:latest.lastValidBlockHeight,contextSlot:simulation.context.slot,feeLamports:String(fee),maxWalletDebitLamports:debit.toString(),openingTokens:built.purchase.tokenAmount,preparedAt:Date.now(),review,...(q?{quoteSpend:{mint:q.mint.toBase58(),tokenProgram:q.quoteTokenProgram.toBase58(),decimals:q.decimals,maxRaw:built.purchase.maxQuoteRaw}}:{})};
   if(q){
    const after=launchQuoteAccountAmount(quoteOwner!,simulated[5],owner,q.mint,q.quoteTokenProgram),spent=quoteBefore-after;
    if(spent<0n||spent>BigInt(built.purchase.maxQuoteRaw)||(BigInt(built.purchase.maxQuoteRaw)>0n&&spent===0n))throw Error('Simulated pair-token spending differs from review.');
    const holders=quoteSetupOwners(mintKey,owner,publication.recipient,buybackWallet);
    for(let i=0;i<holders.length;i++){if(!simulated[i+6])throw Error('Quote-fee account setup missing.');launchQuoteAccountAmount(accountKeys[i+6],simulated[i+6],holders[i],q.mint,q.quoteTokenProgram);}
   }
   verifyLaunchAccounts(plan,simulated.slice(1,5),true);validateLaunchPlan(plan);
   await inspectLaunch(plan.unsigned,plan,{publication,mint,buybackWallet});return plan;
  },
  async expiredUnsigned(p:LaunchExecutionPlan){
   validateLaunchPlan(p);await mainnet();
   const epoch=await connection.getEpochInfo('finalized');
   const proof={blockHeight:epoch.blockHeight!,slot:epoch.absoluteSlot,checkedAt:Date.now()};
   validateLaunchExpiry(p,proof);
   // Read at or after the finalized height used to prove expiration. A mint
   // created by a transaction submitted outside this service blocks refresh.
   const mint=await connection.getAccountInfoAndContext(new PublicKey(p.mint),{commitment:'finalized',minContextSlot:proof.slot});
   if(mint.context.slot<proof.slot||mint.value!==null)throw Error('The previous mint exists or its finalized absence cannot be verified.');
   return {...proof,slot:mint.context.slot};
  },
  async reconcile(p:LaunchExecutionPlan,signed:string){
   await mainnet();const signature=verifyLaunchSigned(p,signed);
   let tx:VersionedTransactionResponse|null;
   try{tx=await connection.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});}
   catch(error){if(!recoveryRpc)throw error;tx=null;}
   // A fresh transport gets its own request deadline on every reconciliation.
   if(!tx&&recoveryRpc)tx=await recoverWorkerReceipt({signature,signed,minContextSlot:p.contextSlot},recoveryRpc());
   if(!tx){
    if(await connection.getBlockHeight('finalized')<=p.lastValidBlockHeight)return {kind:'pending'} as const;
    try{return {kind:'expired_unresolved',nonlandingProof:await proveLaunchNonlanding(p,signed,connection)} as const;}catch{return {kind:'expired_unresolved'} as const;}
   }
   const receipt=finalizedLaunchReceipt(p,signed,tx);if(!receipt)return {kind:'failed'} as const;
   const mint=new PublicKey(p.mint),accounts=await connection.getMultipleAccountsInfoAndContext([mint,feeSharingConfigPda(mint),bondingCurvePda(mint)],{commitment:'finalized',minContextSlot:tx.slot});
   if(!Number.isSafeInteger(accounts.context.slot)||accounts.context.slot<tx.slot)throw Error('Finalized launch account read predates its receipt.');
   verifyLaunchAccounts(p,accounts.value,false);return {kind:'confirmed',receipt} as const;
  },
  async send(p:LaunchExecutionPlan,signed:string){
   await mainnet();const signature=verifyLaunchSigned(p,signed);
   if(await connection.getBlockHeight('confirmed')>p.lastValidBlockHeight)return 'expired' as const;
   const sent=await connection.sendRawTransaction(Buffer.from(signed,'base64'),{skipPreflight:false,maxRetries:0,preflightCommitment:'confirmed'});
   if(sent!==signature)throw Error('Launch submission response mismatch.');return 'sent' as const;
  },
 };
}
export type LaunchExecutionChain=ReturnType<typeof launchExecutionChain>;

function quoteSetupOwners(mint:PublicKey,owner:PublicKey,recipient:string,treasury:string){return [NEXT.creatorVaultPda(NEXT.feeSharingConfigPda(mint)),owner,NEXT.ammCreatorVaultPda(NEXT.feeSharingConfigPda(mint)),new PublicKey(recipient),new PublicKey(treasury)].filter((key,i,all)=>all.findIndex(k=>k.equals(key))===i);}
function launchQuoteAccountAmount(address:PublicKey,info:AccountInfo<Buffer>|null,owner:PublicKey,mint:PublicKey,program:PublicKey){
 if(!info)return 0n;
 if(info.executable||!info.owner.equals(program))throw Error('Quote token account program mismatch.');
 const a=unpackAccount(address,info,program);
 if(!a.owner.equals(owner)||!a.mint.equals(mint)||!a.isInitialized||a.isFrozen||a.isNative||a.delegate||a.closeAuthority)throw Error('Quote token account authority mismatch.');
 return a.amount;
}
export function verifyLaunchQuoteDebit(p:LaunchExecutionPlan,tx:VersionedTransactionResponse){
 const q=p.quoteSpend;if(!q||!tx.meta)throw Error('Quote receipt unavailable.');
 const keys=tx.transaction.message.getAccountKeys({accountKeysFromLookups:tx.meta.loadedAddresses});
 const ata=getAssociatedTokenAddressSync(new PublicKey(q.mint),new PublicKey(p.publication.owner),false,new PublicKey(q.tokenProgram)).toBase58();
 const read=(rows:NonNullable<typeof tx.meta.postTokenBalances>|null|undefined,required:boolean)=>{
  if(!rows)throw Error('Quote token balances missing.');const found=rows.filter(row=>keys.get(row.accountIndex)?.toBase58()===ata);
  if(found.length>1||required&&found.length!==1)throw Error('Quote token balance evidence is ambiguous.');
  for(const row of found)if(row.mint!==q.mint||row.owner!==p.publication.owner||row.programId!==q.tokenProgram||row.uiTokenAmount.decimals!==q.decimals)throw Error('Quote token balance identity mismatch.');
  return found.length?launchAmount(found[0].uiTokenAmount.amount):0n;
 };
 const before=read(tx.meta.preTokenBalances,launchAmount(q.maxRaw)>0n),after=read(tx.meta.postTokenBalances,true),spent=before-after;
 if(spent<0n||spent>launchAmount(q.maxRaw)||(launchAmount(q.maxRaw)>0n&&spent===0n))throw Error('Quote debit exceeded review or purchase was missing.');
 return {mint:q.mint,tokenProgram:q.tokenProgram,decimals:q.decimals,raw:spent.toString()};
}

function verifyFailedLaunchQuoteBalances(tx:VersionedTransactionResponse){
 const meta=tx.meta!;
 if(!meta.preTokenBalances||!meta.postTokenBalances)throw Error('Failed launch token evidence missing.');
 const canonical=(rows:NonNullable<typeof meta.preTokenBalances>)=>{
  if(new Set(rows.map(r=>r.accountIndex)).size!==rows.length)throw Error('Duplicate failed launch token evidence.');
  return rows.map(r=>[r.accountIndex,r.mint,r.owner,r.programId,r.uiTokenAmount.decimals,launchAmount(r.uiTokenAmount.amount).toString()]).sort((a,b)=>Number(a[0])-Number(b[0]));
 };
 if(JSON.stringify(canonical(meta.preTokenBalances))!==JSON.stringify(canonical(meta.postTokenBalances)))throw Error('Failed launch changed token balances.');
}

async function launchBuybackQuoteSetup(connection:Connection,q:Awaited<ReturnType<typeof resolvePumpQuote>>,global:import('@pump-fun/pump-sdk').Global){
 const owner=global.buybackFeeRecipients.find(k=>!k.equals(PublicKey.default));if(!owner)throw Error('Pump buyback recipient unavailable.');
 const ata=getAssociatedTokenAddressSync(q.mint,owner,true,q.quoteTokenProgram),info=await connection.getAccountInfo(ata,'confirmed');
 if(info)launchQuoteAccountAmount(ata,info,owner,q.mint,q.quoteTokenProgram);
 return !info;
}
