import {nativeBuyBound} from './native-buy-bound.js';
// Direct Pump bonding-curve verification. This module cannot sign or submit.
import {createHash} from 'node:crypto';
import {PublicKey,TransactionMessage,VersionedTransaction,ComputeBudgetProgram} from '@solana/web3.js';
import {createAssociatedTokenAccountIdempotentInstruction,getAssociatedTokenAddressSync} from '@solana/spl-token';
import BN from 'bn.js';
// Use the SDK's CommonJS entry consistently on Vercel and worker runtimes.
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {PUMP_SDK,PUMP_PROGRAM_ID,PUMP_FEE_PROGRAM_ID,GLOBAL_PDA,PUMP_FEE_CONFIG_PDA,bondingCurvePda,userVolumeAccumulatorPda,getBuyTokenAmountFromSolAmount,getSellSolAmountFromTokenAmount}=require('@pump-fun/pump-sdk') as typeof import('@pump-fun/pump-sdk');
import {record} from '../src/live-orders.js';
import {isMint} from '../src/assets.js';
import {TOKEN_PROGRAM,WSOL} from '../src/funding-model.js';
import {TOKEN_2022} from './jupiter-routes.js';
import {inspectToken2022Mint,verifyToken2022Account,token2022Bytes} from './token2022-setup.js';
import {inspectStandardNativeMint,verifyStandardNativeAccount,standardNativeBytes} from './standard-native-accounts.js';
import type {Rpc} from './funding.js';

export type CurveRequest={wallet:string;mint:string;direction:'buy'|'sell';inputRaw:string;slippageBps:number};
export type CurveReview={version:1|2;curveRent?:number;request:CurveRequest;unsigned:string;messageHash:string;minimumRaw:string;quotedRaw:string;
 tokenProgram:typeof TOKEN_PROGRAM|typeof TOKEN_2022;decimals:number;curve:string;tokenAccount:string;curveTokenAccount:string;
 feeAccounts:string[];tracker:string;trackerRent:number;tokenRent:number;feeLamports:number;minContextSlot:number;
 blockhash:string;lastValidBlockHeight:number;reviewedAt:number;expiresAt:number};
const SYSTEM='11111111111111111111111111111111';
const fail=():never=>{throw Error('Pump bonding-curve evidence is unsupported or inconsistent.');};
const integer=(n:unknown):n is number=>Number.isSafeInteger(n)&&(n as number)>=0;
const units=(n:unknown)=>{if(typeof n!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(n)||BigInt(n)>18446744073709551615n)return fail();return BigInt(n);};
const hash=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const curveReviewHash=(r:CurveReview)=>hash(JSON.stringify(canonical(r)));
function account(value:unknown,owner:string,size?:number){
 const a=record(value),d=a.data;
 if(a.owner!==owner||a.executable!==false||!integer(a.lamports)||!Array.isArray(d)||d.length!==2||d[1]!=='base64'||typeof d[0]!=='string'||d[0].length>22000)return fail();
 const b=Buffer.from(d[0],'base64');if(b.toString('base64')!==d[0]||size!==undefined&&b.length!==size)return fail();
 return{...a,owner:new PublicKey(owner),data:b,lamports:a.lamports,executable:false,rentEpoch:0};
}
// Pump's current IDL appends max_curve_depth to Global and fee buckets /
// depth / post-completion accounting to BondingCurve. Legacy v1 SOL trades
// remain supported. Decode the known prefix with our pinned SDK, but validate
// the current extension explicitly instead of silently discarding its bytes.
// Source: pump-fun/pump-public-docs/idl/pump.json and official SDK 4.0.0.
function globalAccount(value:unknown){
 const a=account(value,PUMP_PROGRAM_ID.toBase58());
 if(![1087,1088].includes(a.data.length))return fail();
 return a;
}
function curveAccount(value:unknown,allowCompletedLegacy=false){
 const a=account(value,PUMP_PROGRAM_ID.toBase58()),b=a.data;
 if(![151,166,...(allowCompletedLegacy?[150]:[])].includes(b.length)||[48,81,82,123,124].some(i=>![0,1].includes(b[i])))return fail();
 const curve=PUMP_SDK.decodeBondingCurve(a);
 if(b.length===150&&!curve.complete)return fail();
 // The 151-byte deployment reserved this suffix, and has no depth fields.
 // Reject an unknown partial extension rather than decoding truncated values.
 if(b.length!==166&&b.subarray(125).some(n=>n!==0))return fail();
 return {account:a,curve,creatorFee:b.length===166?b.readBigUInt64LE(125):0n,protocolFees:b.length===166?b.readBigUInt64LE(133):0n,
   depth:b.length===166?b[141]:0,initialVirtualQuoteReserves:b.length===166?b.readBigUInt64LE(142):0n,
   postCompleteBaseOut:b.length===166?b.readBigUInt64LE(150):0n,postCompleteQuoteIn:b.length===166?b.readBigUInt64LE(158):0n};
}
export function verifyCurveBalances(r:Pick<CurveReview,'request'|'minimumRaw'|'tokenProgram'|'decimals'|'curve'|'tokenAccount'|'curveTokenAccount'|'feeAccounts'|'tracker'|'trackerRent'|'tokenRent'|'curveRent'|'feeLamports'>,keys:string[],value:unknown){
 const m=record(value),pre=m.preBalances,post=m.postBalances;
 if(!Array.isArray(pre)||!Array.isArray(post)||pre.length!==keys.length||post.length!==keys.length||![...pre,...post].every(integer)||m.fee!==r.feeLamports||m.err===undefined||keys[0]!==r.request.wallet||new Set(keys).size!==keys.length)return fail();
 const ti=keys.indexOf(r.tokenAccount),ci=keys.indexOf(r.curveTokenAccount),pi=keys.indexOf(r.curve),ri=keys.indexOf(r.tracker),fi=r.feeAccounts.map(a=>keys.indexOf(a));
 if([ti,ci,pi,...fi].some(i=>i<1)||new Set([0,ti,ci,pi,...fi]).size!==7||r.trackerRent&&ri<1)return fail();
 const tokens=(rows:unknown,before:boolean)=>{
  if(!Array.isArray(rows))return fail();const out=new Map<number,bigint>();
  for(const v of rows){const row=record(v),amount=record(row.uiTokenAmount),i=row.accountIndex;
   if(!integer(i)||![ti,ci].includes(i)||out.has(i)||row.mint!==r.request.mint||row.owner!==(i===ti?r.request.wallet:r.curve)||row.programId!==r.tokenProgram||amount.decimals!==r.decimals||before&&pre[i]===0)return fail();
   out.set(i,units(amount.amount));
  }
  if(!out.has(ci)||((!before||pre[ti]>0)&&!out.has(ti))||pre[ci]===0)return fail();return out;
 };
 const before=tokens(m.preTokenBalances,true),after=tokens(m.postTokenBalances,m.err!==null);
 if(m.err!==null){
  if(pre.some((n,i)=>BigInt(n)-BigInt(post[i])!==(i===0?BigInt(r.feeLamports):0n))||[ti,ci].some(i=>(before.get(i)??0n)!==(after.get(i)??0n)))return fail();
  return{kind:'failed' as const,feeLamports:String(r.feeLamports),rentLamports:'0'};
 }
 const buy=r.request.direction==='buy',input=units(r.request.inputRaw),delta=(after.get(ti)??0n)-(before.get(ti)??0n),poolDelta=after.get(ci)!-before.get(ci)!;
 const fees=fi.reduce((n,i)=>{if(post[i]<pre[i])return fail();return n+BigInt(post[i])-BigInt(pre[i]);},0n);
 const curveRent=BigInt(r.curveRent??0),rent=BigInt(r.tokenRent+r.trackerRent)+curveRent,walletDelta=BigInt(post[0])-BigInt(pre[0]);
 const received=buy?delta:walletDelta+BigInt(r.feeLamports)+curveRent;
 if(received<units(r.minimumRaw)||delta!==-poolDelta||(!buy&&delta!==-input)||buy&&delta<=0n||
  (pre[ti]===0)!==(r.tokenRent>0)||r.tokenRent&&post[ti]!==r.tokenRent||r.trackerRent&&(pre[ri]!==0||post[ri]!==r.trackerRent)||
  buy&&walletDelta!==-input-rent-BigInt(r.feeLamports)||!buy&&rent!==curveRent||
  BigInt(post[pi])-BigInt(pre[pi])!==(buy?input-fees+curveRent:-received-fees+curveRent)||
  keys.some((_,i)=>![0,pi,...fi,...(r.tokenRent?[ti]:[]),...(r.trackerRent?[ri]:[])].includes(i)&&pre[i]!==post[i]))return fail();
 return{kind:'succeeded' as const,inputRaw:input.toString(),outputRaw:received.toString(),feeLamports:String(r.feeLamports),rentLamports:rent.toString()};
}

export async function simulateCurveSwap(request:CurveRequest,rpc:Rpc,prior?:CurveReview,priorityFeeLamports:0|5000=5000,maxBuyRaw='10000000'){
 if(prior)verifyCurveReview(prior,maxBuyRaw);
 // Keep existing reviewed bytes unchanged; new curves include a bounded priority fee.
 const priority=prior?prior.feeLamports===10000:priorityFeeLamports===5000;
 if(!prior&&priorityFeeLamports!==0&&priorityFeeLamports!==5000)return fail();
 const {wallet,mint,direction,slippageBps}=request,buy=direction==='buy',input=units(request.inputRaw);
 if(![wallet,mint].every(isMint)||wallet===mint||mint===WSOL||!['buy','sell'].includes(direction)||input<1n||buy&&input>nativeBuyBound(maxBuyRaw)||!Number.isInteger(slippageBps)||slippageBps<10||slippageBps>500)return fail();
 const user=new PublicKey(wallet),mintKey=new PublicKey(mint),curve=bondingCurvePda(mintKey),tracker=userVolumeAccumulatorPda(user);
 const latest=record(await rpc('getLatestBlockhash',[{commitment:'finalized'}])),life=record(latest.value),slot=record(latest.context).slot;
 if(!integer(slot)||slot<1||!isMint(String(life.blockhash))||!integer(life.lastValidBlockHeight))return fail();
 const read=async(addresses:string[],min=slot)=>{const v=record(await rpc('getMultipleAccounts',[addresses,{encoding:'base64',commitment:'finalized',minContextSlot:min}]));const at=record(v.context).slot;
  if(!integer(at)||at<min||!Array.isArray(v.value)||v.value.length!==addresses.length)return fail();return{slot:at,values:v.value};};
 const snapshot=await read([GLOBAL_PDA.toBase58(),curve.toBase58(),PUMP_FEE_CONFIG_PDA.toBase58(),mint,wallet,tracker.toBase58()]);
 const ga=globalAccount(snapshot.values[0]),curveBefore=curveAccount(snapshot.values[1]),fa=account(snapshot.values[2],PUMP_FEE_PROGRAM_ID.toBase58()),ma=record(snapshot.values[3]);
 const global=PUMP_SDK.decodeGlobal(ga),bonding=curveBefore.curve,feeConfig=PUMP_SDK.decodeFeeConfig(fa);
 if(!global.initialized||bonding.complete||bonding.isCashbackCoin||bonding.isHolderReward||!bonding.quoteMint.equals(PublicKey.default)||bonding.creator.equals(PublicKey.default)||bonding.creatorFeeBps.toString()!=='0'||bonding.canEditCreatorFee||curveBefore.depth!==0||curveBefore.postCompleteBaseOut!==0n||curveBefore.postCompleteQuoteIn!==0n)return fail();
 const program=ma.owner;if(program!==TOKEN_PROGRAM&&program!==TOKEN_2022)return fail();
 const config=program===TOKEN_PROGRAM?inspectStandardNativeMint(ma,mint):inspectToken2022Mint(ma,mint);
 if(config.transferFee)return fail();
 const mintBytes=program===TOKEN_PROGRAM?standardNativeBytes(ma,82):token2022Bytes(ma),decimals=mintBytes[44],supply=new BN(mintBytes.readBigUInt64LE(36).toString());
 const verifyToken=(v:unknown,owner:string)=>config.accountSize===165?verifyStandardNativeAccount(v,owner,mint):verifyToken2022Account(v,owner,mint,config);
 account(snapshot.values[4],SYSTEM,0);
 const ata=getAssociatedTokenAddressSync(mintKey,user,false,new PublicKey(program)),curveAta=getAssociatedTokenAddressSync(mintKey,curve,true,new PublicKey(program));
 const endpoints=await read([ata.toBase58(),curveAta.toBase58()],snapshot.slot);
 verifyToken(endpoints.values[1],curve.toBase58());if(endpoints.values[0]!==null)verifyToken(endpoints.values[0],wallet);else if(!buy)return fail();
 const trackerMissing=buy&&snapshot.values[5]===null;
 if(buy&&!trackerMissing){const a=account(snapshot.values[5],PUMP_PROGRAM_ID.toBase58(),137);PUMP_SDK.decodeUserVolumeAccumulator(a);if(!a.data.subarray(8,40).equals(user.toBuffer()))return fail();}
 const rent=async(size:number)=>{const n=await rpc('getMinimumBalanceForRentExemption',[size,{commitment:'finalized'}]);if(!integer(n)||n<1||n>2500000)return fail();return n;};
 const tokenRent=endpoints.values[0]===null?await rent(config.accountSize):0,trackerRent=trackerMissing?await rent(137):0;
 // Current trades extend old curve storage in-program. The rent delta is
 // separately authorized and accounted, never folded into the swap input.
 const curveRent=ga.data.length===1088&&curveBefore.account.data.length===151?await rent(166)-await rent(151):0;
 if(curveRent<0)return fail();
 const quoted=buy?getBuyTokenAmountFromSolAmount({global,feeConfig,mintSupply:supply,bondingCurve:bonding,amount:new BN(input.toString()),quoteMint:PublicKey.default}):getSellSolAmountFromTokenAmount({global,feeConfig,mintSupply:supply,bondingCurve:bonding,amount:new BN(input.toString())});
 const quotedRaw=quoted.toString(),freshMinimum=BigInt(quotedRaw)*BigInt(10000-slippageBps)/10000n,minimum=prior?units(prior.minimumRaw):BigInt(quotedRaw)*BigInt(10000-Math.floor(slippageBps/2))/10000n;
 if(minimum<1n||minimum<freshMinimum||prior&&JSON.stringify(canonical(prior.request))!==JSON.stringify(canonical(request)))return fail();
 const recipients=(bonding.isMayhemMode?[global.reservedFeeRecipient,...global.reservedFeeRecipients]:[global.feeRecipient,...global.feeRecipients]).filter(a=>!a.equals(PublicKey.default));
 const buybacks=global.buybackFeeRecipients.filter(a=>!a.equals(PublicKey.default));
 if(!recipients.length||!buybacks.length)return fail();
 const selected=prior?prior.feeAccounts:undefined;
 const feeRecipient=selected?recipients.find(k=>k.toBase58()===selected[0]):recipients[0],buybackFeeRecipient=selected?buybacks.find(k=>k.toBase58()===selected[2]):buybacks[0];
 if(!feeRecipient||!buybackFeeRecipient)return fail();
 const common={user,mint:mintKey,creator:bonding.creator,amount:new BN((buy?minimum:input).toString()),solAmount:new BN((buy?input:minimum).toString()),feeRecipient,buybackFeeRecipient,tokenProgram:new PublicKey(program)};
 const swap=buy?await PUMP_SDK.getBuyInstructionRaw(common):await PUMP_SDK.getSellInstructionRaw({...common,cashback:false});
 if(!swap.programId.equals(PUMP_PROGRAM_ID)||swap.keys.length!==(buy?18:16)||swap.data.length!==(buy?25:24))return fail();
 if(buy){const data=Buffer.alloc(25);createHash('sha256').update('global:buy_exact_sol_in').digest().copy(data,0,0,8);data.writeBigUInt64LE(input,8);data.writeBigUInt64LE(minimum,16);data[24]=1;swap.data=data;}
 const feeAccounts=[feeRecipient.toBase58(),swap.keys[buy?9:8].pubkey.toBase58(),buybackFeeRecipient.toBase58()];
 const instructions=[ComputeBudgetProgram.setComputeUnitLimit({units:400000}),...(priority?[ComputeBudgetProgram.setComputeUnitPrice({microLamports:12500})]:[]),...(buy?[createAssociatedTokenAccountIdempotentInstruction(user,ata,user,mintKey,new PublicKey(program))]:[]),swap];
 const blockhash=prior?.blockhash??String(life.blockhash),lastValidBlockHeight=prior?.lastValidBlockHeight??life.lastValidBlockHeight;
 if(prior){const valid=record(await rpc('isBlockhashValid',[blockhash,{commitment:'finalized',minContextSlot:endpoints.slot}])),height=await rpc('getBlockHeight',[{commitment:'finalized',minContextSlot:endpoints.slot}]);if(valid.value!==true||!integer(height)||height>lastValidBlockHeight)return fail();}
 const message=new TransactionMessage({payerKey:user,recentBlockhash:blockhash,instructions}).compileToV0Message(),tx=new VersionedTransaction(message),bytes=tx.serialize();
 if(bytes.length>1232||tx.signatures.some(s=>s.some(n=>n!==0))||message.header.numRequiredSignatures!==1)return fail();
 const keys=message.staticAccountKeys.map(k=>k.toBase58()),feeReply=record(await rpc('getFeeForMessage',[Buffer.from(message.serialize()).toString('base64'),{commitment:'finalized',minContextSlot:endpoints.slot}])),fee=feeReply.value;
 if(typeof fee!=='number'||fee!==(priority?10000:5000))return fail();
 const requested=[mint,ata.toBase58(),curveAta.toBase58(),curve.toBase58(),...(trackerMissing?[tracker.toBase58()]:[])];
 const result=record(await rpc('simulateTransaction',[Buffer.from(bytes).toString('base64'),{encoding:'base64',commitment:'finalized',sigVerify:false,replaceRecentBlockhash:false,minContextSlot:endpoints.slot,accounts:{encoding:'base64',addresses:requested}}])),sim=record(result.value),at=record(result.context).slot;
 if(!integer(at)||at<endpoints.slot||sim.err!==null||sim.replacementBlockhash!=null||!Array.isArray(sim.accounts)||sim.accounts.length!==requested.length)return fail();
 if((program===TOKEN_PROGRAM?inspectStandardNativeMint(sim.accounts[0],mint):inspectToken2022Mint(sim.accounts[0],mint)).mintHash!==config.mintHash)return fail();
 verifyToken(sim.accounts[1],wallet);verifyToken(sim.accounts[2],curve.toBase58());
 const curveAfter=curveAccount(sim.accounts[3]);
 if(curveAfter.account.data.length!==(curveRent?166:curveBefore.account.data.length))return fail();
 // v1 trades pay the existing three recipients immediately. They must not
 // alter v3's accumulated fee buckets, quote depth, or post-completion state.
 for(const key of ['creatorFee','protocolFees','depth','initialVirtualQuoteReserves','postCompleteBaseOut','postCompleteQuoteIn'] as const)if(curveAfter[key]!==curveBefore[key])return fail();
 if(trackerMissing){const trackerAfter=account(sim.accounts[4],PUMP_PROGRAM_ID.toBase58(),137);PUMP_SDK.decodeUserVolumeAccumulator(trackerAfter);if(trackerAfter.lamports!==trackerRent||!trackerAfter.data.subarray(8,40).equals(user.toBuffer()))return fail();}
 const now=Date.now(),review:CurveReview={version:curveRent?2:1,...(curveRent?{curveRent}:{}),request,unsigned:Buffer.from(bytes).toString('base64'),messageHash:hash(message.serialize()),minimumRaw:minimum.toString(),quotedRaw,tokenProgram:program,decimals,curve:curve.toBase58(),tokenAccount:ata.toBase58(),curveTokenAccount:curveAta.toBase58(),feeAccounts,tracker:tracker.toBase58(),trackerRent,tokenRent,feeLamports:fee,minContextSlot:at,blockhash,lastValidBlockHeight,reviewedAt:now,expiresAt:now+60000};
 verifyCurveReview(review,maxBuyRaw);if(prior&&at<prior.minContextSlot)return fail();
 const outcome=verifyCurveBalances(review,keys,sim);if(outcome.kind!=='succeeded'||minimum<BigInt(outcome.outputRaw)*BigInt(10000-slippageBps)/10000n)return fail();
 for(let i=0;i<requested.length;i++)if(record(sim.accounts[i]).lamports!==(sim.postBalances as number[])[keys.indexOf(requested[i])])return fail();
 if(prior){const fixed=(r:CurveReview)=>({...r,minContextSlot:0,reviewedAt:0,expiresAt:0,quotedRaw:''});if(JSON.stringify(canonical(fixed(review)))!==JSON.stringify(canonical(fixed(prior))))return fail();}
 return{review,reviewHash:curveReviewHash(review),outcome,transactionBytes:bytes.length};
}

export function verifyCurveReview(r:CurveReview,maxBuyRaw='10000000'){
 if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).filter(k=>r.version===2?k!=='curveRent':true).sort().join(',')!=='blockhash,curve,curveTokenAccount,decimals,expiresAt,feeAccounts,feeLamports,lastValidBlockHeight,messageHash,minContextSlot,minimumRaw,quotedRaw,request,reviewedAt,tokenAccount,tokenProgram,tokenRent,tracker,trackerRent,unsigned,version'||!r.request||Object.keys(r.request).sort().join(',')!=='direction,inputRaw,mint,slippageBps,wallet'||!Array.isArray(r.feeAccounts))return fail();
 if(!r||![1,2].includes(r.version)||r.version===2&&(!integer(r.curveRent)||r.curveRent<1||r.curveRent>2500000)||!r.request||!['buy','sell'].includes(r.request.direction)||![r.request.wallet,r.request.mint,r.curve,r.tokenAccount,r.curveTokenAccount,r.tracker,r.blockhash,...r.feeAccounts].every(isMint)||r.feeAccounts.length!==3||new Set(r.feeAccounts).size!==3||![''+TOKEN_PROGRAM,''+TOKEN_2022].includes(r.tokenProgram)||![r.decimals,r.trackerRent,r.tokenRent,r.feeLamports,r.minContextSlot,r.lastValidBlockHeight,r.reviewedAt,r.expiresAt].every(integer)||r.decimals>18||r.trackerRent>2500000||r.tokenRent>2500000||r.feeLamports<1||r.feeLamports>50000||r.minContextSlot<1||r.expiresAt<=r.reviewedAt||r.expiresAt-r.reviewedAt>60000||!Number.isInteger(r.request.slippageBps)||r.request.slippageBps<10||r.request.slippageBps>500||units(r.request.inputRaw)<1n||r.request.direction==='buy'&&units(r.request.inputRaw)>nativeBuyBound(maxBuyRaw)||units(r.minimumRaw)<1n||units(r.quotedRaw)<units(r.minimumRaw)||r.request.direction==='sell'&&(r.tokenRent!==0||r.trackerRent!==0))return fail();
 const user=new PublicKey(r.request.wallet),mint=new PublicKey(r.request.mint),curve=bondingCurvePda(mint);
 if(!PublicKey.isOnCurve(user.toBytes())||r.curve!==curve.toBase58()||r.tokenAccount!==getAssociatedTokenAddressSync(mint,user,false,new PublicKey(r.tokenProgram)).toBase58()||r.curveTokenAccount!==getAssociatedTokenAddressSync(mint,curve,true,new PublicKey(r.tokenProgram)).toBase58()||r.tracker!==userVolumeAccumulatorPda(user).toBase58())return fail();
 if(typeof r.unsigned!=='string'||r.unsigned.length>1644)return fail();const bytes=Buffer.from(r.unsigned,'base64');if(!bytes.length||bytes.toString('base64')!==r.unsigned||bytes.length>1232)return fail();
 const tx=VersionedTransaction.deserialize(bytes),m=tx.message;if(m.version!==0||m.header.numRequiredSignatures!==1||m.header.numReadonlySignedAccounts!==0||m.addressTableLookups.length||tx.signatures.some(s=>s.some(b=>b!==0))||m.recentBlockhash!==r.blockhash||hash(m.serialize())!==r.messageHash||!Buffer.from(tx.serialize()).equals(bytes))return fail();
 const keys=m.staticAccountKeys.map(k=>k.toBase58()),buy=r.request.direction==='buy',swap=m.compiledInstructions.at(-1)!;
 if(keys[0]!==r.request.wallet||new Set(keys).size!==keys.length||![r.curve,r.tokenAccount,r.curveTokenAccount,...r.feeAccounts].every(k=>keys.includes(k))||keys[swap.programIdIndex]!==PUMP_PROGRAM_ID.toBase58()||swap.data.length!==(buy?25:24)||!Buffer.from(swap.data).subarray(0,8).equals(createHash('sha256').update('global:'+(buy?'buy_exact_sol_in':'sell')).digest().subarray(0,8))||Buffer.from(swap.data).readBigUInt64LE(8)!==units(r.request.inputRaw)||Buffer.from(swap.data).readBigUInt64LE(16)!==units(r.minimumRaw))return fail();
 const accounts=Array.from(swap.accountKeyIndexes,i=>keys[i]),instructions=m.compiledInstructions,priority=r.feeLamports===10000;
 if(r.feeLamports!==5000&&!priority)return fail();
 if(instructions.length!==(buy?3:2)+(priority?1:0)||accounts.length!==(buy?18:16)||accounts[0]!==GLOBAL_PDA.toBase58()||accounts[1]!==r.feeAccounts[0]||accounts[2]!==r.request.mint||accounts[3]!==r.curve||accounts[4]!==r.curveTokenAccount||accounts[5]!==r.tokenAccount||accounts[6]!==r.request.wallet||accounts[7]!==SYSTEM||accounts[buy?8:9]!==r.tokenProgram||accounts[buy?9:8]!==r.feeAccounts[1]||accounts[11]!==PUMP_PROGRAM_ID.toBase58()||accounts[buy?14:12]!==PUMP_FEE_CONFIG_PDA.toBase58()||accounts[buy?15:13]!==PUMP_FEE_PROGRAM_ID.toBase58()||accounts[buy?17:15]!==r.feeAccounts[2]||buy&&(accounts[13]!==r.tracker||swap.data[24]!==1))return fail();
 const compute=instructions[0];if(keys[compute.programIdIndex]!==ComputeBudgetProgram.programId.toBase58()||compute.accountKeyIndexes.length||!Buffer.from(compute.data).equals(ComputeBudgetProgram.setComputeUnitLimit({units:400000}).data))return fail();
 if(priority){const price=instructions[1];if(keys[price.programIdIndex]!==ComputeBudgetProgram.programId.toBase58()||price.accountKeyIndexes.length||!Buffer.from(price.data).equals(ComputeBudgetProgram.setComputeUnitPrice({microLamports:12500}).data))return fail();}
 if(buy){const setup=instructions[priority?2:1],expected=createAssociatedTokenAccountIdempotentInstruction(user,new PublicKey(r.tokenAccount),user,mint,new PublicKey(r.tokenProgram));if(keys[setup.programIdIndex]!==expected.programId.toBase58()||!Buffer.from(setup.data).equals(expected.data)||Array.from(setup.accountKeyIndexes,i=>keys[i]).join(',')!==expected.keys.map(k=>k.pubkey.toBase58()).join(','))return fail();}
 return{tx,keys};
}

export async function hasActivePumpCurve(mint:string,rpc:Rpc){
 if(!isMint(mint))return fail();const key=bondingCurvePda(new PublicKey(mint));
 const reply=record(await rpc('getMultipleAccounts',[[key.toBase58()],{encoding:'base64',commitment:'finalized'}]));
 if(!integer(record(reply.context).slot)||!Array.isArray(reply.value)||reply.value.length!==1)return fail();
 if(reply.value[0]===null)return false;
 const {curve}=curveAccount(reply.value[0],true);
 return !curve.complete;
}
