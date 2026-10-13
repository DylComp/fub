import { SOL_PAIR_MINT, pairAmount } from './launch-pairs.js';
import {address,getAddressEncoder,getProgramDerivedAddress,getCompiledTransactionMessageDecoder,getTransactionDecoder,getTransactionEncoder} from '@solana/kit';
import bs58 from 'bs58';
import canonicalize from 'canonicalize';
import layouts from './pump-launch-layouts.json' with {type:'json'};
import {fromBase64,toBase64,associated,ATA_PROGRAM} from './transaction-review.js';
import {resolveMessageAccounts} from './lookup-tables.js';
import type {LookupProof} from './lookup-tables.js';
import {initialBuyLamports,launchShares} from './launch-model.js';
import {validPublishedLaunch} from './launch-publication.js';
import type {PublishedLaunch} from './launch-publication.js';
import type {LaunchExecutionPlan} from '../server/launch-execution-model.js';
import {isMint} from './assets.js';
export type LaunchQuoteReview={tokenProgram:string;decimals:number;source:'global'|'quoteControl'|'pumpCoin';pool?:{underlyingMint:string;underlyingTokenProgram:string};buy?:{version:3;slippageBps:100;createBuybackQuoteAccount:boolean}};
export type LaunchReviewEvidence={quote?:LaunchQuoteReview;lookupTables:LookupProof[];feeRecipients:{fee:string;buyback:string}|null};
export type LaunchSigningIntent={publication:PublishedLaunch;mint:string;buybackWallet:string};
const PUMP=layouts.createV2.program,FEE=layouts.createFeeSharingConfig.program;
const SYSTEM='11111111111111111111111111111111',COMPUTE='ComputeBudget111111111111111111111111111111';
const SPL='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',TOKEN='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',SOL='So11111111111111111111111111111111111111112';
const enc=new TextEncoder(),key=(s:string)=>Uint8Array.from(getAddressEncoder().encode(address(s)));
const equal=(a:ArrayLike<number>,b:ArrayLike<number>)=>a.length===b.length&&Array.from(a).every((v,i)=>v===b[i]);
const concat=(...parts:ArrayLike<number>[])=>Uint8Array.from(parts.flatMap(p=>Array.from(p)));
const num=(n:bigint,size:number)=>{const b=new Uint8Array(size);for(let i=0;i<size;i++){b[i]=Number(n&255n);n>>=8n;}if(n)throw Error('Integer overflow.');return b;};
const str=(s:string)=>{const b=enc.encode(s);return concat(num(BigInt(b.length),4),b);};
const amount=(s:string)=>{if(typeof s!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(s)||BigInt(s)>18446744073709551615n)throw Error('Invalid launch amount.');return BigInt(s);};
const pda=async(program:string,seeds:Uint8Array[])=>(await getProgramDerivedAddress({programAddress:address(program),seeds}))[0] as string;
type Seed={kind:string;value?:number[];path?:string};
type Account={name:string;writable?:boolean;signer?:boolean;optional?:boolean;address?:string;pda?:{seeds:Seed[];program?:Seed}};
type Layout={program:string;discriminator:number[];accounts:Account[]};
// Pinned account layouts are extracted from the official pump-sdk 2.0.0 IDLs.
// We derive addresses and encode allowed arguments here, independently of the
// server builder. No transaction instruction supplied by the API is trusted.
export async function inspectLaunch(encoded:string,p:LaunchExecutionPlan,intent:LaunchSigningIntent){
 if(!validPublishedLaunch(intent.publication,intent.publication.owner)||!validPublishedLaunch(p.publication,intent.publication.owner)||
   canonicalize(p.publication)!==canonicalize(intent.publication)||p.mint!==intent.mint||p.buybackWallet!==intent.buybackWallet||
   ![p.mint,p.buybackWallet].every(isMint)||[p.publication.owner,p.publication.recipient,p.buybackWallet].includes(p.mint))throw Error('Launch does not match the chosen coin or recipients.');
 const custom=!!p.publication.draft.quoteMint&&p.publication.draft.quoteMint!==SOL_PAIR_MINT;
 const quote=p.review?.quote,quoteMint=custom?p.publication.draft.quoteMint!:SOL,quoteProgram=custom?quote?.tokenProgram:SPL;
 if(custom&&(!quote||![SPL,TOKEN].includes(quote.tokenProgram)||!Number.isInteger(quote.decimals)||quote.decimals<0||quote.decimals>18||!['global','quoteControl','pumpCoin'].includes(quote.source)))throw Error('Missing quote-asset review.');
 if(!custom&&(quote||p.quoteSpend))throw Error('Unexpected token spending in a SOL launch.');
 if(quote?.pool&&(quote.source!=='pumpCoin'||!isMint(quote.pool.underlyingMint)||![SPL,TOKEN].includes(quote.pool.underlyingTokenProgram)))throw Error('Invalid quote pool review.');
 launchShares(p.publication.recipient,p.buybackWallet);
 const review=p.review;if(!review||!Array.isArray(review.lookupTables)||review.lookupTables.some(t=>t.contextSlot>p.contextSlot))throw Error('Launch address evidence is missing.');
 const buy=custom?pairAmount(p.publication.draft.initialBuy,quote!.decimals):initialBuyLamports(p.publication.draft.initialBuy),tokens=amount(p.openingTokens);
 if(quote?.buy&&(!custom||buy===0n||quote.buy.version!==3||quote.buy.slippageBps!==100||typeof quote.buy.createBuybackQuoteAccount!=='boolean'||Object.keys(quote.buy).sort().join()!=='createBuybackQuoteAccount,slippageBps,version'))throw Error('Unsupported opening-buy review.');
 if(custom&&(!p.quoteSpend||p.quoteSpend.mint!==quoteMint||p.quoteSpend.tokenProgram!==quoteProgram||p.quoteSpend.decimals!==quote!.decimals||amount(p.quoteSpend.maxRaw)!==buy))throw Error('Quote spending differs from the selected pair or amount.');
 if((buy>0n)!==(tokens>0n)||amount(p.feeLamports)!==10600n||amount(p.maxWalletDebitLamports)<10600n||amount(p.maxWalletDebitLamports)>(custom?0n:buy)+100000000n||p.version!==1||![p.contextSlot,p.lastValidBlockHeight,p.preparedAt].every(n=>Number.isSafeInteger(n)&&n>0))throw Error('Launch costs or opening buy do not match.');
 if(buy>0n&&(!review.feeRecipients||![review.feeRecipients.fee,review.feeRecipients.buyback].every(isMint)))throw Error('Pump fee destinations are missing.');
 const tx=getTransactionDecoder().decode(fromBase64(encoded));
 if(toBase64(new Uint8Array(getTransactionEncoder().encode(tx)))!==encoded)throw Error('Non-canonical launch transaction.');
 const message=getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
 if(message.version!==0||message.header.numSignerAccounts!==2||message.header.numReadonlySignerAccounts!==0||Object.keys(tx.signatures).length!==2)throw Error('Unexpected launch signing permissions.');
 const instructions=message.instructions;
 const {keys,writable}=resolveMessageAccounts(message,review.lookupTables);
 if(keys[0]!==intent.publication.owner||keys[1]!==intent.mint||(!custom&&message.instructions.length!==(buy>0n?7:5)))throw Error('Unexpected launch instructions or signers.');
 const owner=intent.publication.owner,mint=intent.mint,used=new Set<string>(),writes=new Set<string>(),signers=new Set<string>();
 const sharing=await pda(FEE,[enc.encode('sharing-config'),key(mint)]);
 let index=0;
 function check(program:string,accounts:{address:string;writable?:boolean;signer?:boolean}[],data:Uint8Array){
  const ix=instructions[index++];
  if(!ix||keys[ix.programAddressIndex]!==program||!equal(ix.data||[],data)||(ix.accountIndices||[]).length!==accounts.length||accounts.some((a,i)=>keys[ix.accountIndices![i]]!==a.address))throw Error('Launch instruction differs from the reviewed coin, purchase, or 80/20 split.');
  used.add(program);for(const a of accounts){used.add(a.address);if(a.writable)writes.add(a.address);if(a.signer)signers.add(a.address);}
 }
 async function pump(name:keyof typeof layouts,data:Uint8Array,extra:{address:string;writable?:boolean}[]=[]){
  const layout:Layout=layouts[name],values:Record<string,string>={mint,user:owner,payer:owner,authority:owner,program:layout.program,tokenProgram:name==='createV2'||name==='buy'?TOKEN:quoteProgram!,quoteMint,baseMint:mint,baseTokenProgram:TOKEN,quoteTokenProgram:quoteProgram!,
   'bondingCurve.creator':sharing,pool:layout.program};
  if(name==='buy'||name==='buyV2'||name==='buyV3'){values.associatedBaseUser=await associated(owner,mint,TOKEN);values.associatedQuoteUser=await associated(owner,quoteMint,quoteProgram!);values.feeRecipient=review!.feeRecipients!.fee;values.buybackFeeRecipient=name==='buyV3'?await associated(review!.feeRecipients!.buyback,quoteMint,quoteProgram!):review!.feeRecipients!.buyback;values.associatedUser=await associated(owner,mint,TOKEN);}
  async function seed(s:Seed):Promise<Uint8Array>{if(s.kind==='const'&&s.value)return Uint8Array.from(s.value);if(s.kind==='account'&&s.path)return key(await resolve(s.path));throw Error('Unsupported launch account seed.');}
  async function resolve(name:string):Promise<string>{
   if(values[name])return values[name];
   const a=layout.accounts.find(a=>a.name===name);if(!a)throw Error('Unknown launch account.');
   if(a.address)return values[name]=a.address;
   if(a.pda){const program=a.pda.program?bs58.encode(await seed(a.pda.program)):layout.program;return values[name]=await pda(program,await Promise.all(a.pda.seeds.map(seed)));}
   if(name==='mayhemTokenVault')return values[name]=await associated(await resolve('solVault'),mint,TOKEN);
   if(name==='coinCreatorVaultAta')return values[name]=await associated(await resolve('coinCreatorVaultAuthority'),quoteMint,quoteProgram!);
   throw Error('Unreviewed launch account.');
  }
  const accounts=await Promise.all(layout.accounts.map(async a=>({address:await resolve(a.name),writable:a.writable&&!(a.optional&&values[a.name]===layout.program),signer:a.signer})));
  check(layout.program,[...accounts,...extra],concat(layout.discriminator,data));
 }
 check(COMPUTE,[],concat([2],num(600000n,4)));
 check(COMPUTE,[],concat([3],num(1000n,8)));
 const d=p.publication.draft;
 const curve=await pda(PUMP,[enc.encode('bonding-curve'),key(mint)]);
 const extraCreate:{address:string;writable?:boolean}[]=[];
 if(custom){
  extraCreate.push({address:quoteMint},{address:await associated(curve,quoteMint,quoteProgram!),writable:true},{address:quoteProgram!},{address:await pda(PUMP,[enc.encode('quote-control')])});
  if(quote!.source==='pumpCoin'){
   extraCreate.push({address:await pda(PUMP,[enc.encode('bonding-curve'),key(quoteMint)])});
   if(quote!.pool){const underlying=quote!.pool;const amm='pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';const authority=await pda(PUMP,[enc.encode('pool-authority'),key(quoteMint)]);const pool=await pda(amm,[enc.encode('pool'),num(0n,2),key(authority),key(quoteMint),key(underlying.underlyingMint)]);extraCreate.push({address:pool},{address:await associated(pool,quoteMint,quoteProgram!)},{address:await associated(pool,underlying.underlyingMint,underlying.underlyingTokenProgram)});}
  }
 }
 await pump('createV2',concat(str(d.name),str(d.ticker),str(p.publication.metadataUrl),key(owner),[0,0],num(0n,8),[0]),extraCreate);
 await pump('createFeeSharingConfig',new Uint8Array());
 async function ata(holder:string,asset:string,program:string){check(ATA_PROGRAM,[{address:owner,writable:true,signer:true},{address:await associated(holder,asset,program),writable:true},{address:holder},{address:asset},{address:SYSTEM},{address:program}],new Uint8Array([1]));}
 if(custom){const creator=await pda(PUMP,[enc.encode('creator-vault'),key(sharing)]),ammCreator=await pda('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',[enc.encode('creator_vault'),key(sharing)]);for(const holder of [...new Set([creator,owner,ammCreator,p.publication.recipient,p.buybackWallet])])await ata(holder,quoteMint,quoteProgram!);}
 await pump(buy>0n&&!custom?'updateFeeShares':'updateFeeSharesV2',concat(num(2n,4),key(p.publication.recipient),num(8000n,2),key(p.buybackWallet),num(2000n,2)),[{address:owner,writable:true},...(custom?[{address:await associated(owner,quoteMint,quoteProgram!),writable:true}]:[])]);
 if(buy>0n){
  check(ATA_PROGRAM,[{address:owner,writable:true,signer:true},{address:await associated(owner,mint,TOKEN),writable:true},{address:owner},{address:mint},{address:SYSTEM},{address:TOKEN}],new Uint8Array([1]));
  if(custom&&quote?.buy?.version===3){
   if(quote.buy.createBuybackQuoteAccount)await ata(review.feeRecipients!.buyback,quoteMint,quoteProgram!);
   await pump('buyV3',concat(num(tokens,8),num(buy,8),[0]));
  }
  else if(custom)await pump('buyV2',concat(num(tokens,8),num(buy,8)));
  else await pump('buy',concat(num(tokens,8),num(buy,8),[1]),[{address:await pda(PUMP,[enc.encode('bonding-curve-v2'),key(mint)])},{address:review.feeRecipients!.buyback,writable:true}]);
 }
 if(index!==instructions.length)throw Error('Unexpected extra launch instruction.');
 const h=message.header,staticCount=message.staticAccounts.length;
 for(const [i,k] of keys.entries()){
  const actualWrite=i<staticCount?(i<h.numSignerAccounts?i<h.numSignerAccounts-h.numReadonlySignerAccounts:i<staticCount-h.numReadonlyNonSignerAccounts):i<staticCount+writable.length;
  if(!used.has(k)||actualWrite!==writes.has(k)||(i<h.numSignerAccounts)!==signers.has(k))throw Error('Unexpected launch account privileges.');
 }
 return {tx,message};
}
export async function verifySignedLaunch(p:LaunchExecutionPlan,intent:LaunchSigningIntent,signed:string){
 const original=await inspectLaunch(p.unsigned,p,intent),checked=await inspectLaunch(signed,p,intent);
 if(!equal(original.tx.messageBytes,checked.tx.messageBytes))throw Error('Wallet changed the launch transaction.');
 for(const signer of [intent.publication.owner,intent.mint]){
  const signature=checked.tx.signatures[address(signer)];if(!signature)throw Error('Both launch signatures are required.');
  const publicKey=await crypto.subtle.importKey('raw',Uint8Array.from(bs58.decode(signer)),'Ed25519',false,['verify']);
  if(!await crypto.subtle.verify('Ed25519',publicKey,Uint8Array.from(signature),Uint8Array.from(checked.tx.messageBytes)))throw Error('Invalid launch signature.');
 }
 return bs58.encode(checked.tx.signatures[address(intent.publication.owner)]!);
}
// A fresh token mint key, never a user's wallet key. The non-extractable private
// key stays in this closure. Paired launches may restore a non-extractable mint
// signer from the publication-bound local store to resume paid table setup.
export async function createLaunchMint(existing?:CryptoKeyPair){
 const pair=existing??await crypto.subtle.generateKey('Ed25519',false,['sign','verify']) as CryptoKeyPair;
 const mint=bs58.encode(new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey)));
 return {address:mint,async sign(p:LaunchExecutionPlan,intent:LaunchSigningIntent){
  if(intent.mint!==mint)throw Error('The mint key belongs to another launch.');
  const {tx}=await inspectLaunch(p.unsigned,p,intent);
  if(Object.values(tx.signatures).some(s=>s&&Array.from(s).some(Boolean)))throw Error('Expected a fully unsigned launch.');
  const signature=new Uint8Array(await crypto.subtle.sign('Ed25519',pair.privateKey,Uint8Array.from(tx.messageBytes)));
  const signed={...tx,signatures:{...tx.signatures,[mint]:signature}} as typeof tx;
  return toBase64(new Uint8Array(getTransactionEncoder().encode(signed)));
 }};
}
export async function verifyMintSignedLaunch(p:LaunchExecutionPlan,intent:LaunchSigningIntent,partial:string){
 const original=await inspectLaunch(p.unsigned,p,intent),checked=await inspectLaunch(partial,p,intent);
 if(!equal(original.tx.messageBytes,checked.tx.messageBytes)||checked.tx.signatures[address(intent.publication.owner)])throw Error('The mint signature does not match the unsigned launch.');
 const signature=checked.tx.signatures[address(intent.mint)];if(!signature)throw Error('Mint signature is missing.');
 const publicKey=await crypto.subtle.importKey('raw',Uint8Array.from(bs58.decode(intent.mint)),'Ed25519',false,['verify']);
 if(!await crypto.subtle.verify('Ed25519',publicKey,Uint8Array.from(signature),Uint8Array.from(checked.tx.messageBytes)))throw Error('Invalid mint signature.');
 return checked;
}
