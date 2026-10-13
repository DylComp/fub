import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import canonicalize from 'canonicalize';
import {Connection,PublicKey,SystemProgram,ComputeBudgetProgram,TransactionMessage,VersionedTransaction,type AccountInfo,type VersionedTransactionResponse} from '@solana/web3.js';
import {NATIVE_MINT,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,getAssociatedTokenAddressSync,unpackAccount,unpackMint,getExtensionTypes,ExtensionType,createAssociatedTokenAccountInstruction,createCloseAccountInstruction} from '@solana/spl-token';
import {rawLamports,verifyPayoutSignature} from './launch-payout-model.js';
import {MAINNET_GENESIS} from './solana-network.js';
import {recoverWorkerReceipt} from './worker-block-recovery.js';
import type {Rpc} from './funding.js';
import type {QuoteFeeAsset} from './launch-quote-fees.js';
const require=createRequire(import.meta.url),sdk=require('@pump-fun/pump-sdk-next') as typeof import('@pump-fun/pump-sdk-next'),BN=require('bn.js') as typeof import('bn.js');
export type ConversionPolicy={treasury:string;maxOverheadLamports:string;dailyFeeCapLamports:string;minimumOutputLamports:string;slippageBps:100};
export type ConversionPlan={version:1;policy:ConversionPolicy;asset:QuoteFeeAsset;inputRaw:string;minimumOutputRaw:string;quotedOutputRaw:string;route:'curve'|'pool';buyback:string;feeLamports:string;rentCapLamports:string;temporaryRentLamports:string;contextSlot:number;lastValidBlockHeight:number;preparedAt:number;unsigned:string};
export type ConversionReceipt={success:boolean;slot:number;inputRaw:string;netSolLamports:string;feeLamports:string;rentLamports:string};
export type ConversionAttempt={id:string;plan:ConversionPlan;signed:string;signature:string};
const pk=(s:string)=>new PublicKey(s),n=(v:number)=>{if(!Number.isSafeInteger(v)||v<0)throw Error('Invalid conversion chain integer.');return BigInt(v);};
export function validateConversionPolicy(p:ConversionPolicy){
 if(!p||Object.keys(p).sort().join()!=='dailyFeeCapLamports,maxOverheadLamports,minimumOutputLamports,slippageBps,treasury'||pk(p.treasury).toBase58()!==p.treasury||!PublicKey.isOnCurve(pk(p.treasury).toBytes())||p.slippageBps!==100||rawLamports(p.maxOverheadLamports)<5400n||rawLamports(p.maxOverheadLamports)>5000000n||rawLamports(p.dailyFeeCapLamports)<rawLamports(p.maxOverheadLamports)||rawLamports(p.dailyFeeCapLamports)>100000000n||rawLamports(p.minimumOutputLamports)<100000n)throw Error('Invalid conversion policy.');
}
export const conversionPolicyId=(p:ConversionPolicy)=>{validateConversionPolicy(p);return createHash('sha256').update(canonicalize(p)!).digest('hex');};
export function conversionAddresses(p:Pick<ConversionPlan,'policy'|'asset'|'route'|'buyback'>){
 const mint=pk(p.asset.mint),user=pk(p.policy.treasury),program=pk(p.asset.tokenProgram),pool=sdk.canonicalPumpPoolPdaWithQuote(mint,NATIVE_MINT),curve=sdk.bondingCurvePda(mint),market=p.route==='pool'?pool:curve;
 return {mint,user,program,pool,curve,market,source:getAssociatedTokenAddressSync(mint,user,false,program),wrapped:getAssociatedTokenAddressSync(NATIVE_MINT,user),baseVault:getAssociatedTokenAddressSync(mint,market,true,program),quoteVault:getAssociatedTokenAddressSync(NATIVE_MINT,market,true),tracker:p.route==='pool'?PublicKey.findProgramAddressSync([Buffer.from('user_volume_accumulator'),user.toBuffer()],sdk.PUMP_AMM_PROGRAM_ID)[0]:sdk.userVolumeAccumulatorPda(user),buyback:p.route==='pool'?getAssociatedTokenAddressSync(NATIVE_MINT,pk(p.buyback),true):pk(p.buyback)};
}
export async function conversionInstructions(p:ConversionPlan){
 validateConversionPolicy(p.policy);
 if(p.version!==1||!['curve','pool'].includes(p.route)||p.asset.mint===NATIVE_MINT.toBase58()||p.asset.mint===p.policy.treasury||!PublicKey.isOnCurve(pk(p.asset.mint).toBytes())||![TOKEN_PROGRAM_ID.toBase58(),TOKEN_2022_PROGRAM_ID.toBase58()].includes(p.asset.tokenProgram)||!Number.isInteger(p.asset.decimals)||p.asset.decimals<0||p.asset.decimals>18||rawLamports(p.inputRaw)===0n||rawLamports(p.minimumOutputRaw)===0n||rawLamports(p.quotedOutputRaw)<rawLamports(p.minimumOutputRaw)||p.feeLamports!=='5400'||rawLamports(p.rentCapLamports)+rawLamports(p.temporaryRentLamports)+5400n>rawLamports(p.policy.maxOverheadLamports)||![p.contextSlot,p.lastValidBlockHeight,p.preparedAt].every(v=>Number.isSafeInteger(v)&&v>0)||pk(p.buyback).equals(pk(p.policy.treasury)))throw Error('Invalid conversion plan.');
 const a=conversionAddresses(p),compute=[ComputeBudgetProgram.setComputeUnitLimit({units:400000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:1000})];
 if(p.route==='curve')return [...compute,await sdk.PUMP_SDK.getSellV3InstructionRaw({user:a.user,mint:a.mint,amount:new BN(p.inputRaw),quoteAmount:new BN(p.minimumOutputRaw),tokenProgram:a.program,quoteMint:NATIVE_MINT,quoteTokenProgram:TOKEN_PROGRAM_ID,buybackFeeRecipient:pk(p.buyback)})];
 const program=sdk.getPumpAmmProgram({} as Connection);
 const sell=await program.methods.sellV2(new BN(p.inputRaw),new BN(p.minimumOutputRaw)).accountsStrict({pool:a.pool,user:a.user,globalConfig:sdk.AMM_GLOBAL_PDA,baseMint:a.mint,quoteMint:NATIVE_MINT,userBaseTokenAccount:a.source,userQuoteTokenAccount:a.wrapped,poolBaseTokenAccount:a.baseVault,poolQuoteTokenAccount:a.quoteVault,baseTokenProgram:a.program,quoteTokenProgram:TOKEN_PROGRAM_ID,systemProgram:SystemProgram.programId,userVolumeAccumulator:a.tracker,feeConfig:PublicKey.findProgramAddressSync([Buffer.from('fee_config'),sdk.PUMP_AMM_PROGRAM_ID.toBuffer()],sdk.PUMP_FEE_PROGRAM_ID)[0],buybackFeeRecipient:a.buyback,eventAuthority:sdk.PUMP_AMM_EVENT_AUTHORITY_PDA,program:sdk.PUMP_AMM_PROGRAM_ID}).instruction();
 // A fresh WSOL account is created and closed atomically. An existing account
 // makes the transaction fail instead of unwrapping unrelated treasury funds.
 return [...compute,createAssociatedTokenAccountInstruction(a.user,a.wrapped,a.user,NATIVE_MINT),sell,createCloseAccountInstruction(a.wrapped,a.user,a.user)];
}
export async function verifyConversionPlan(p:ConversionPlan){
 if(rawLamports(p.quotedOutputRaw)<rawLamports(p.policy.minimumOutputLamports)||rawLamports(p.minimumOutputRaw)<rawLamports(p.quotedOutputRaw)*99n/100n)throw Error('Conversion slippage limit changed.');
 const tx=VersionedTransaction.deserialize(Buffer.from(p.unsigned,'base64'));
 const message=new TransactionMessage({payerKey:pk(p.policy.treasury),recentBlockhash:tx.message.recentBlockhash,instructions:await conversionInstructions(p)}).compileToV0Message();
 if(tx.serialize().length>1232||tx.signatures.some(s=>s.some(Boolean))||!Buffer.from(tx.message.serialize()).equals(Buffer.from(message.serialize())))throw Error('Conversion instructions changed.');
}
export function verifyConversionSignature(a:ConversionAttempt){return verifyPayoutSignature({unsigned:a.plan.unsigned,lastValidBlockHeight:a.plan.lastValidBlockHeight,feeLamports:a.plan.feeLamports},a.signed,a.plan.policy.treasury);}
type Balances={pre:bigint[];post:bigint[];beforeTokens:Map<string,bigint>;afterTokens:Map<string,bigint>;failed:boolean};
export function conversionBalances(p:ConversionPlan,keys:string[],b:Balances,slot:number,allowUnprofitableProbe=false):ConversionReceipt{
 const a=conversionAddresses(p),index=(k:PublicKey)=>{const i=keys.indexOf(k.toBase58());if(i<0)throw Error('Missing conversion account.');return i;};
 if(keys[0]!==p.policy.treasury||keys.length!==b.pre.length||keys.length!==b.post.length||new Set(keys).size!==keys.length||!Number.isSafeInteger(slot)||slot<p.contextSlot)throw Error('Conversion balance identity mismatch.');
 if(b.pre.some(v=>v<0n)||b.post.some(v=>v<0n)||b.pre.reduce((s,v,i)=>s+b.post[i]-v,0n)!==-5400n)throw Error('Conversion native conservation failed.');
 const source=index(a.source),market=index(a.market),tracker=index(a.tracker),buyback=index(a.buyback),base=index(a.baseVault);
 const tokenDelta=(k:PublicKey)=>(b.afterTokens.get(k.toBase58())??0n)-(b.beforeTokens.get(k.toBase58())??0n);
 if(b.failed){
  if(b.pre.some((v,i)=>v-b.post[i]!==(i===0?5400n:0n))||[...new Set([...b.beforeTokens.keys(),...b.afterTokens.keys()])].some(k=>(b.beforeTokens.get(k)??0n)!==(b.afterTokens.get(k)??0n)))throw Error('Failed conversion changed assets.');
  return{success:false,slot,inputRaw:'0',netSolLamports:'0',feeLamports:p.feeLamports,rentLamports:'0'};
 }
 const rent=b.post[tracker]-b.pre[tracker]+(p.route==='pool'?b.post[market]-b.pre[market]:0n),net=b.post[0]-b.pre[0],gross=net+5400n+rent;
 if(rent<0n||rent>rawLamports(p.rentCapLamports)||(!allowUnprofitableProbe&&net<=0n)||gross<rawLamports(p.minimumOutputRaw)||tokenDelta(a.source)!==-rawLamports(p.inputRaw)||tokenDelta(a.baseVault)!==rawLamports(p.inputRaw)||b.post[source]!==b.pre[source]||b.post[base]!==b.pre[base])throw Error('Conversion proceeds, input or rent mismatch.');
 const allowed=new Set([0,market,tracker,buyback]);
 if(p.route==='pool'){
  const quote=index(a.quoteVault),wrapped=index(a.wrapped);allowed.add(quote);
  if(b.pre[wrapped]!==0n||b.post[wrapped]!==0n||tokenDelta(a.wrapped)!==0n||b.post[quote]>=b.pre[quote]||tokenDelta(a.quoteVault)!==b.post[quote]-b.pre[quote]||tokenDelta(a.buyback)!==b.post[buyback]-b.pre[buyback])throw Error('Conversion did not settle native SOL.');
 }
 const allowedTokens=new Set([a.source,a.baseVault,...(p.route==='pool'?[a.wrapped,a.quoteVault,a.buyback]:[])].map(k=>k.toBase58()));
 if([...new Set([...b.beforeTokens.keys(),...b.afterTokens.keys()])].some(k=>!allowedTokens.has(k)&&(b.beforeTokens.get(k)??0n)!==(b.afterTokens.get(k)??0n)))throw Error('Unexpected conversion token change.');
 if(b.post[buyback]<b.pre[buyback]||keys.some((_,i)=>!allowed.has(i)&&b.pre[i]!==b.post[i]))throw Error('Unexpected conversion account change.');
 return{success:true,slot,inputRaw:p.inputRaw,netSolLamports:net.toString(),feeLamports:p.feeLamports,rentLamports:rent.toString()};
}
export async function conversionReceipt(a:ConversionAttempt,tx:VersionedTransactionResponse){
 await verifyConversionPlan(a.plan);const original=VersionedTransaction.deserialize(Buffer.from(a.signed,'base64')),m=tx.meta,keys=tx.transaction.message.staticAccountKeys.map(k=>k.toBase58());
 if(!m||verifyConversionSignature(a)!==a.signature||tx.transaction.signatures[0]!==a.signature||!Buffer.from(tx.transaction.message.serialize()).equals(Buffer.from(original.message.serialize()))||m.fee!==5400||m.loadedAddresses&&(m.loadedAddresses.readonly.length||m.loadedAddresses.writable.length))throw Error('Conversion receipt mismatch.');
 const addresses=conversionAddresses(a.plan);
 const tokens=(rows:typeof m.postTokenBalances)=>{if(!rows)throw Error('Missing token balances.');const result=new Map<string,bigint>();for(const row of rows){const key=keys[row.accountIndex];if(!key||result.has(key))throw Error('Invalid token row.');const base=[addresses.source,addresses.baseVault].some(k=>k.toBase58()===key);if(row.mint!==(base?a.plan.asset.mint:NATIVE_MINT.toBase58())||row.programId!==(base?a.plan.asset.tokenProgram:TOKEN_PROGRAM_ID.toBase58())||row.uiTokenAmount.decimals!==(base?a.plan.asset.decimals:9))throw Error('Conversion token identity changed.');const owner=key===addresses.source.toBase58()||key===addresses.wrapped.toBase58()?addresses.user.toBase58():key===addresses.baseVault.toBase58()||key===addresses.quoteVault.toBase58()?addresses.market.toBase58():key===addresses.buyback.toBase58()?a.plan.buyback:null;if(!owner||row.owner!==owner)throw Error('Conversion token owner changed.');result.set(key,rawLamports(row.uiTokenAmount.amount));}return result;};
 return conversionBalances(a.plan,keys,{pre:m.preBalances.map(n),post:m.postBalances.map(n),beforeTokens:tokens(m.preTokenBalances),afterTokens:tokens(m.postTokenBalances),failed:!!m.err},tx.slot);
}
const info=(v:any):AccountInfo<Buffer>|null=>v?{...v,owner:pk(v.owner),data:Buffer.from(v.data[0],'base64')}:null;
function tokenAmount(key:PublicKey,v:AccountInfo<Buffer>|null){return v&&[TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID].some(p=>p.equals(v.owner))?unpackAccount(key,v,v.owner).amount:null;}
export function quoteConversionChain(c:Connection,recoveryRpc?:()=>Rpc){
 return{
  async prepare(policy:ConversionPolicy,asset:QuoteFeeAsset,inputRaw:string):Promise<ConversionPlan|null>{
   validateConversionPolicy(policy);if(await c.getGenesisHash()!==MAINNET_GENESIS)throw Error('Mainnet required.');
   const mint=pk(asset.mint),curveKey=sdk.bondingCurvePda(mint);
   const r=await c.getMultipleAccountsInfoAndContext([sdk.GLOBAL_PDA,curveKey,mint],{commitment:'finalized'}),[g,b,m]=r.value;
   if(!g?.owner.equals(sdk.PUMP_PROGRAM_ID)||!b?.owner.equals(sdk.PUMP_PROGRAM_ID)||!m||m.owner.toBase58()!==asset.tokenProgram||[g,b,m].some(i=>i.executable))throw Error('Unsupported conversion market.');
   const global=sdk.PUMP_SDK.decodeGlobal(g),curve=sdk.PUMP_SDK.decodeBondingCurve(b),mintState=unpackMint(mint,m,m.owner);
   if(!sdk.normalizeQuoteMint(curve.quoteMint).equals(NATIVE_MINT)||curve.isMayhemMode||curve.isCashbackCoin||curve.isHolderReward||!mintState.isInitialized||mintState.mintAuthority||mintState.freezeAuthority||mintState.decimals!==asset.decimals||getExtensionTypes(mintState.tlvData).some(t=>![ExtensionType.MetadataPointer,ExtensionType.TokenMetadata].includes(t)))throw Error('Conversion needs a supported SOL-backed Pump coin.');
   const route=curve.complete?'pool':'curve',buyback=global.buybackFeeRecipients.find(k=>!k.equals(PublicKey.default));if(!buyback)throw Error('Conversion protocol fee recipient unavailable.');
   const lifetime=await c.getLatestBlockhash('confirmed');
   let p:ConversionPlan={version:1,policy,asset,inputRaw,minimumOutputRaw:'1',quotedOutputRaw:'1',route,buyback:buyback.toBase58(),feeLamports:'5400',rentCapLamports:'0',temporaryRentLamports:route==='pool'?String(await c.getMinimumBalanceForRentExemption(165)):'0',contextSlot:r.context.slot,lastValidBlockHeight:lifetime.lastValidBlockHeight,preparedAt:Date.now(),unsigned:''};
   const a=conversionAddresses(p),marketInfo=route==='curve'?b:await c.getAccountInfo(a.pool,'finalized');
   if(!marketInfo||marketInfo.executable||!marketInfo.owner.equals(route==='pool'?sdk.PUMP_AMM_PROGRAM_ID:sdk.PUMP_PROGRAM_ID))throw Error('Conversion pool is unavailable.');
   if(route==='pool'){
    const program=sdk.getPumpAmmProgram(c),pool=program.coder.accounts.decode('pool',Buffer.concat([marketInfo.data,Buffer.alloc(Math.max(0,program.account.pool.size-marketInfo.data.length))]));
    if(!pool.baseMint.equals(mint)||!pool.quoteMint.equals(NATIVE_MINT)||!pool.poolBaseTokenAccount.equals(a.baseVault)||!pool.poolQuoteTokenAccount.equals(a.quoteVault)||pool.isMayhemMode||pool.isCashbackCoin||pool.isHolderReward)throw Error('Conversion pool mismatch.');
   }
   const trackerInfo=await c.getAccountInfo(a.tracker,'confirmed');
   if(trackerInfo&&(!trackerInfo.owner.equals(route==='pool'?sdk.PUMP_AMM_PROGRAM_ID:sdk.PUMP_PROGRAM_ID)||trackerInfo.executable))throw Error('Conversion tracker owner changed.');
   const trackerRent=trackerInfo?0:await c.getMinimumBalanceForRentExemption(137);
   // Include exact protocol account growth; preparation cannot hide it in output.
   const marketRent=Math.max(0,await c.getMinimumBalanceForRentExemption(Math.max(marketInfo.data.length,route==='curve'?sdk.BONDING_CURVE_SIZE:sdk.getPumpAmmProgram(c).account.pool.size))-marketInfo.lamports);
   p.rentCapLamports=String(trackerRent+marketRent);
   const simulate=async()=>{
    const instructions=await conversionInstructions(p),message=new TransactionMessage({payerKey:a.user,recentBlockhash:lifetime.blockhash,instructions}).compileToV0Message(),tx=new VersionedTransaction(message);
    if(tx.serialize().length>1232)throw Error('Conversion packet exceeds size limit.');
    p.unsigned=Buffer.from(tx.serialize()).toString('base64');
    const keys=message.staticAccountKeys,writable=keys.filter((_,i)=>message.isAccountWritable(i));
    const before=await c.getMultipleAccountsInfoAndContext(writable,{commitment:'confirmed',minContextSlot:p.contextSlot});
    const source=before.value[writable.findIndex(k=>k.equals(a.source))];if(!source)throw Error('Treasury quote account is missing.');
    const token=unpackAccount(a.source,source,a.program);if(!token.owner.equals(a.user)||!token.mint.equals(a.mint)||!token.isInitialized||token.isNative||token.isFrozen||token.delegate||token.closeAuthority||token.amount<rawLamports(inputRaw))throw Error('Treasury quote balance is unavailable.');
    if(route==='pool'&&before.value[writable.findIndex(k=>k.equals(a.wrapped))])throw Error('Existing treasury WSOL must not be unwrapped by conversion.');
    if((await c.getFeeForMessage(message,'confirmed')).value!==5400)throw Error('Conversion network fee changed.');
    const sim=await c.simulateTransaction(tx,{sigVerify:false,commitment:'confirmed',minContextSlot:before.context.slot,accounts:{encoding:'base64',addresses:writable.map(k=>k.toBase58())}});
    if(sim.value.err||!sim.value.accounts||sim.value.accounts.length!==writable.length)throw Error('Conversion simulation failed.');
    const after=sim.value.accounts.map(info),pre:bigint[]=[],post:bigint[]=[],beforeTokens=new Map<string,bigint>(),afterTokens=new Map<string,bigint>();
    keys.forEach(key=>{const i=writable.findIndex(k=>k.equals(key));pre.push(i<0?0n:n(before.value[i]?.lamports??0));post.push(i<0?0n:n(after[i]?.lamports??0));if(i>=0){const b=tokenAmount(key,before.value[i]),v=tokenAmount(key,after[i]);if(b!==null)beforeTokens.set(key.toBase58(),b);if(v!==null)afterTokens.set(key.toBase58(),v);}});
    const receipt=conversionBalances(p,keys.map(k=>k.toBase58()),{pre,post,beforeTokens,afterTokens,failed:false},sim.context.slot,true);
    return BigInt(receipt.netSolLamports)+5400n+BigInt(receipt.rentLamports);
   };
   const quoted=await simulate();if(quoted<rawLamports(policy.minimumOutputLamports)||quoted*99n/100n<=rawLamports(p.rentCapLamports)+5400n)return null;
   p={...p,quotedOutputRaw:String(quoted),minimumOutputRaw:String(quoted*99n/100n)};
   const second=await simulate();if(BigInt(p.minimumOutputRaw)<second*99n/100n)throw Error('Conversion quote moved; review again.');
   await verifyConversionPlan(p);return p;
  },
  async reconcile(a:ConversionAttempt){
   await verifyConversionPlan(a.plan);if(await c.getGenesisHash()!==MAINNET_GENESIS||verifyConversionSignature(a)!==a.signature)throw Error('Conversion recovery mismatch.');
   let tx=await c.getTransaction(a.signature,{commitment:'finalized',maxSupportedTransactionVersion:0}).catch(e=>{if(!recoveryRpc)throw e;return null;});
   if(!tx&&recoveryRpc)tx=await recoverWorkerReceipt({signature:a.signature,signed:a.signed,minContextSlot:a.plan.contextSlot},recoveryRpc());
   if(tx)return{kind:'settled' as const,receipt:await conversionReceipt(a,tx)};
   return{kind:await c.getBlockHeight('finalized')>a.plan.lastValidBlockHeight?'expired_unresolved' as const:'pending' as const};
  },
  async send(a:ConversionAttempt){
   await verifyConversionPlan(a.plan);if(await c.getGenesisHash()!==MAINNET_GENESIS||verifyConversionSignature(a)!==a.signature)throw Error('Conversion send mismatch.');
   if(await c.getBlockHeight('confirmed')>a.plan.lastValidBlockHeight)return'expired' as const;
   if(await c.sendRawTransaction(Buffer.from(a.signed,'base64'),{skipPreflight:false,preflightCommitment:'confirmed'})!==a.signature)throw Error('Conversion submission mismatch.');return'sent' as const;
  }
 };
}
