// Public receipt observation only. Never grants permission or builds a trade.
import bs58 from 'bs58';
import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {getAssociatedTokenAddressSync} from '@solana/spl-token';
// Use the SDK's CommonJS entry consistently on Vercel and worker runtimes.
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {PUMP_PROGRAM_ID,GLOBAL_PDA,bondingCurvePda,userVolumeAccumulatorPda}=require('@pump-fun/pump-sdk') as typeof import('@pump-fun/pump-sdk');
import {record} from '../src/live-orders.js';
import {TOKEN_PROGRAM,WSOL} from '../src/funding-model.js';
import {TOKEN_2022} from './jupiter-routes.js';
import {verifyCurveBalances} from './pump-curve-execution.js';
import {ATA,parsedAta} from './copy-native.js';
import type {FeedDecision} from '../src/copy-feed.js';
export const PUMP_CURVE=PUMP_PROGRAM_ID.toBase58();
const COMPUTE='ComputeBudget111111111111111111111111111111';
const discriminator=(name:string)=>createHash('sha256').update('global:'+name).digest().subarray(0,8);
// The upgraded legacy trade first pays storage-extension rent to its own
// curve PDA. Read that exact first CPI, not an unexplained wallet difference.
// Remaining swap/fee/token deltas are still independently checked below.
function observedCurveRent(meta:Record<string,unknown>,index:number,keys:string[],leader:string,curve:string){
 if(meta.innerInstructions==null)return 0;
 if(!Array.isArray(meta.innerInstructions))throw Error('Invalid inner instructions');
 const groups=meta.innerInstructions.filter(v=>record(v).index===index);if(groups.length>1)throw Error('Ambiguous curve instructions');
 if(!groups.length)return 0;
 const rows=record(groups[0]).instructions;if(!Array.isArray(rows))throw Error('Invalid curve instructions');
 if(!rows.length)return 0;const first=record(rows[0]);
 const program=typeof first.programId==='string'?first.programId:Number.isSafeInteger(first.programIdIndex)?keys[Number(first.programIdIndex)]:'';
 if(program!==PublicKey.default.toBase58())return 0;
 if(first.stackHeight!==2)throw Error('Unverified curve rent call');
 let source:unknown,destination:unknown,lamports:unknown;
 if(first.parsed){const p=record(first.parsed);if(p.type!=='transfer')return 0;const info=record(p.info);({source,destination,lamports}=info);}
 else{
  if(typeof first.data!=='string'||!Array.isArray(first.accounts)||first.accounts.length!==2)return 0;
  const data=Buffer.from(bs58.decode(first.data));if(data.length!==12||data.readUInt32LE(0)!==2)return 0;
  const key=(v:unknown)=>typeof v==='string'?v:Number.isSafeInteger(v)?keys[Number(v)]:null;
  source=key(first.accounts[0]);destination=key(first.accounts[1]);const raw=data.readBigUInt64LE(4);if(raw>2500000n)throw Error('Curve rent exceeds bound');lamports=Number(raw);
 }
 if(source!==leader||destination!==curve)return 0;
 if(!Number.isSafeInteger(lamports)||Number(lamports)<1||Number(lamports)>2500000)throw Error('Invalid curve rent');
 return Number(lamports);
}
export function observePumpCurve(instructions:Record<string,unknown>[],keys:string[],meta:Record<string,unknown>,leader:string):FeedDecision{
 const ignored=():FeedDecision=>({kind:'ignored',reason:'Unsupported or inconsistent Pump bonding-curve receipt.'});
 try{
  const swaps=instructions.filter(ix=>ix.programId===PUMP_CURVE);if(swaps.length!==1||keys[0]!==leader)return ignored();
  const ix=swaps[0],a=ix.accounts;if(!Array.isArray(a)||!a.every(x=>typeof x==='string'&&keys.includes(x))||typeof ix.data!=='string')return ignored();
  const data=Buffer.from(bs58.decode(ix.data)),name=['buy_exact_sol_in','buy','sell'].find(n=>data.subarray(0,8).equals(discriminator(n)));
  if(!name)return ignored();const buy=name!=='sell';
  if(a.length!==(buy?18:16)||data.length!==(buy?25:24)||buy&&data[24]!==1||a[0]!==GLOBAL_PDA.toBase58()||a[6]!==leader||a[11]!==PUMP_CURVE||a[7]!==PublicKey.default.toBase58())return ignored();
  const program=a[buy?8:9];if(program!==TOKEN_PROGRAM&&program!==TOKEN_2022)return ignored();
  const mint=new PublicKey(a[2]),user=new PublicKey(leader),curve=bondingCurvePda(mint),tracker=userVolumeAccumulatorPda(user).toBase58();
  if(a[3]!==curve.toBase58()||a[4]!==getAssociatedTokenAddressSync(mint,curve,true,new PublicKey(program)).toBase58()||a[5]!==getAssociatedTokenAddressSync(mint,user,false,new PublicKey(program)).toBase58()||buy&&a[13]!==tracker)return ignored();
  let setups=0;
  for(const other of instructions){
   if(other===ix)continue;
   if(other.programId===COMPUTE){if(instructions.indexOf(other)>instructions.indexOf(ix)||typeof other.data!=='string'||!Array.isArray(other.accounts)||other.accounts.length)return ignored();const b=bs58.decode(other.data);if(!((b[0]===2&&b.length===5)||(b[0]===3&&b.length===9)))return ignored();continue;}
   if(other.programId!==ATA||!buy||++setups>1||instructions.indexOf(other)>instructions.indexOf(ix))return ignored();
   const parsed=parsedAta(other);
   if(parsed){if(parsed.account!==a[5]||parsed.owner!==leader||parsed.mint!==a[2]||parsed.program!==program||record(record(other.parsed).info).source!==leader)return ignored();}
   else if(typeof other.data!=='string'||!Buffer.from(bs58.decode(other.data)).equals(Buffer.from([1]))||!Array.isArray(other.accounts)||other.accounts.join(',')!==[leader,a[5],leader,a[2],PublicKey.default.toBase58(),program].join(','))return ignored();
  }
  const pre=meta.preBalances,post=meta.postBalances;if(!Array.isArray(pre)||!Array.isArray(post)||![...pre,...post,meta.fee].every(n=>Number.isSafeInteger(n)&&Number(n)>=0))return ignored();
  const ti=keys.indexOf(a[5]),ri=keys.indexOf(tracker),tokenRent=pre[ti]===0?Number(post[ti]):0,trackerRent=buy&&pre[ri]===0?Number(post[ri]):0;
  if(tokenRent>2500000||trackerRent>2500000||tokenRent>0&&setups!==1)return ignored();
  const tokenRows=meta.postTokenBalances;if(!Array.isArray(tokenRows))return ignored();const token=record(tokenRows.find(v=>record(v).accountIndex===ti)),decimals=record(token.uiTokenAmount).decimals;
  if(!Number.isInteger(decimals)||Number(decimals)<0||Number(decimals)>18)return ignored();
  const first=data.readBigUInt64LE(8),second=data.readBigUInt64LE(16);
  const curveRent=observedCurveRent(meta,instructions.indexOf(ix),keys,leader,curve.toBase58());
  const spent=BigInt(pre[0])-BigInt(post[0])-BigInt(Number(meta.fee)+tokenRent+trackerRent+curveRent);
  const input=buy?name==='buy_exact_sol_in'?first:spent:first;
  if(input<=0n||name==='buy'&&spent>second)return ignored();
  const outcome=verifyCurveBalances({request:{wallet:leader,mint:a[2],direction:buy?'buy':'sell',inputRaw:String(input),slippageBps:100},minimumRaw:String(buy?name==='buy'?first:second:second),tokenProgram:program,decimals:Number(decimals),curve:a[3],tokenAccount:a[5],curveTokenAccount:a[4],feeAccounts:[a[1],a[buy?9:8],a[buy?17:15]],tracker,trackerRent,curveRent,tokenRent,feeLamports:Number(meta.fee)},keys,meta);
  if(outcome.kind!=='succeeded'||name==='buy'&&BigInt(outcome.outputRaw)!==first)return ignored();
  const before=Array.isArray(meta.preTokenBalances)?record(meta.preTokenBalances.find(v=>record(v).accountIndex===ti)??{}):{};
  return{kind:'swap',route:'pump_bonding_curve',decoderVersion:7,tokenProgram:program,quoteMode:'native',side:buy?'buy':'sell',mint:a[2],quoteMint:WSOL,tokenRaw:buy?outcome.outputRaw:outcome.inputRaw,quoteRaw:buy?outcome.inputRaw:outcome.outputRaw,tokenDecimals:Number(decimals),quoteDecimals:9,leaderTokenBeforeRaw:String(record(before.uiTokenAmount??{}).amount??'0')};
 }catch{return ignored();}
}
