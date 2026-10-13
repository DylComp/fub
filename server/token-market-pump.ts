import {createRequire} from 'node:module';
import {Connection,PublicKey,SystemProgram} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,unpackMint} from '@solana/spl-token';
import {SOL_PAIR_MINT} from '../src/launch-pairs.js';
import {MAINNET_GENESIS} from './solana-network.js';
import {freshMarketTime,type MarketSupply} from '../src/token-market-model.js';
const require=createRequire(import.meta.url);
const sdk=require('@pump-fun/pump-sdk-next') as typeof import('@pump-fun/pump-sdk-next');
export type CurveMarket=({state:'active';priceSol:number;reservesSol:number;slot:number;checkedAt:number}|{state:'complete'|'absent'|'unsupported'})&{supply?:MarketSupply};
export function curveMarketAmounts(virtualQuote:bigint,virtualToken:bigint,realQuote:bigint,decimals:number){
 if(virtualQuote<=0n||virtualToken<=0n||realQuote<0n||!Number.isInteger(decimals)||decimals<0||decimals>18)throw Error('Invalid curve reserves');
 const priceSol=Number(virtualQuote)/Number(virtualToken)*10**decimals/1e9,reservesSol=Number(realQuote)/1e9;
 if(!Number.isFinite(priceSol)||priceSol<=0||!Number.isFinite(reservesSol))throw Error('Invalid curve price');
 return{priceSol,reservesSol};
}
// A confirmed bank may be a skipped slot or too new for getBlockTime.
// Use a finalized ancestor only as a conservative freshness timestamp.
export async function marketSlotTime(c:Pick<Connection,'getBlockTime'|'getSlot'>,slot:number){
 let blockTime=await c.getBlockTime(slot).catch(()=>null);
 if(blockTime===null){
  const ancestor=await c.getSlot('finalized');
  if(!Number.isSafeInteger(ancestor)||ancestor<1||ancestor>slot)throw Error('Inconsistent market slots');
  blockTime=await c.getBlockTime(ancestor);
 }
 const checkedAt=blockTime===null?0:blockTime*1000;
 if(!freshMarketTime(checkedAt))throw Error('Stale market RPC');
 return checkedAt;
}
// Read supply and market values for display and order-entry conversion. Never signs or sends.
export async function readPumpMarket(mint:string,env=process.env):Promise<CurveMarket>{
 if(!env.SOLANA_RPC_URL)throw Error('Market RPC unavailable');
 const c=new Connection(env.SOLANA_RPC_URL,{commitment:'confirmed',disableRetryOnRateLimit:true,fetch:(u,o)=>fetch(u,{...o,signal:AbortSignal.timeout(5000)})});
 const key=new PublicKey(mint);
 const [genesis,reply]=await Promise.all([c.getGenesisHash(),c.getMultipleAccountsInfoAndContext([key,sdk.bondingCurvePda(key)])]);
 if(genesis!==MAINNET_GENESIS)throw Error('Mainnet required');
 const [mi,ci]=reply.value;
 if(!mi||mi.executable||![TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID].some(p=>mi.owner.equals(p)))throw Error('Invalid curve accounts');
 const token=unpackMint(key,mi,mi.owner);
 if(!token.isInitialized)throw Error('Uninitialized mint');
 // Verify freshness even for completed curves before choosing a pool source.
 const checkedAt=await marketSlotTime(c,reply.context.slot);
 // Wrapped SOL's mint supply is not circulating SOL supply.
 const supply=token.supply>0n&&mint!==SOL_PAIR_MINT?{raw:token.supply.toString(),decimals:token.decimals,slot:reply.context.slot,checkedAt}:undefined;
 // An empty system-owned PDA can receive SOL before any curve exists.
 if(!ci||!ci.executable&&ci.data.length===0&&ci.owner.equals(SystemProgram.programId))return{state:'absent',supply};
 if(!ci.owner.equals(sdk.PUMP_PROGRAM_ID)||ci.executable)throw Error('Invalid curve accounts');
 const curve=sdk.PUMP_SDK.decodeBondingCurve(ci);
 if(curve.complete)return{state:'complete',supply};
 if(!sdk.normalizeQuoteMint(curve.quoteMint).equals(new PublicKey(SOL_PAIR_MINT)))return{state:'unsupported',supply};
 return{state:'active',supply,...curveMarketAmounts(BigInt(curve.virtualQuoteReserves.toString()),BigInt(curve.virtualTokenReserves.toString()),BigInt(curve.realQuoteReserves.toString()),token.decimals),slot:reply.context.slot,checkedAt};
}
