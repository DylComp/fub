import {AccountLayout,MintLayout} from '@solana/spl-token';
import {isMint} from '../src/assets.js';
import {associated} from '../src/transaction-review.js';
import {TOKEN_PROGRAM,USDC} from '../src/funding-model.js';
import {PAY_TRANSFER_FEE} from '../src/pay-transfer-model.js';
import type {GiftFundingReadiness} from '../src/gift-funding-model.js';
import {MAINNET_GENESIS} from './solana-network.js';
import type {Rpc} from './funding.js';
const SYSTEM='11111111111111111111111111111111';
function integer(v:unknown){if(!Number.isSafeInteger(v)||Number(v)<0)throw Error('Wallet funding could not be checked.');return BigInt(Number(v));}
function binary(a:any,owner:string,size:number){
 if(!a||a.owner!==owner||a.executable!==false||!Array.isArray(a.data)||a.data[1]!=='base64'||typeof a.data[0]!=='string'||a.data[0].length>2048)throw Error('Wallet funding could not be checked.');
 const bytes=Buffer.from(a.data[0],'base64');if(bytes.length!==size||bytes.toString('base64')!==a.data[0])throw Error('Wallet funding could not be checked.');return bytes;
}
function token(a:any,wallet:string){
 const t=AccountLayout.decode(binary(a,TOKEN_PROGRAM,165));
 if(t.mint.toBase58()!==USDC||t.owner.toBase58()!==wallet||t.state!==1||t.isNativeOption!==0)throw Error('An active Solana USDC account is required.');return t.amount;
}
// The catalog returns USD-denominated estimates. These are a readiness estimate,
// never invoice authority: payment review rechecks the actual USDC invoice.
export function giftFundingEstimate(price:string,currency:string){
 if(currency!=='USD'&&currency!=='USDC'||!/^\d{1,4}(?:\.\d{1,12})?$/.test(price))throw Error('Gift-card price estimate is unavailable.');
 const [whole,fraction='']=price.split('.');
 const raw=BigInt(whole)*1000000n+BigInt((fraction+'000000').slice(0,6))+(fraction.slice(6).match(/[1-9]/)?1n:0n);
 if(raw<=0n||raw>1000000000n)throw Error('Gift-card price estimate is unavailable.');return raw.toString();
}
export async function giftFundingReadiness(wallet:string,amount:string,rpc:Rpc,recipient?:string):Promise<GiftFundingReadiness>{
 if(!isMint(wallet)||recipient&&!isMint(recipient)||!/^\d{1,10}$/.test(amount)||BigInt(amount)<=0n||BigInt(amount)>1000000000n)throw Error('Wallet funding could not be checked.');
 if(await rpc('getGenesisHash',[])!==MAINNET_GENESIS)throw Error('Solana mainnet is required.');
 const addresses=[wallet,USDC,await associated(wallet,USDC)];if(recipient)addresses.push(await associated(recipient,USDC));
 const [accounts,rentValue]=await Promise.all([
  rpc('getMultipleAccounts',[addresses,{encoding:'base64',commitment:'finalized'}]),
  rpc('getMinimumBalanceForRentExemption',[165,{commitment:'finalized'}]),
 ]) as any[];
 const slot=integer(accounts?.context?.slot),rows=accounts?.value;
 if(slot<=0n||!Array.isArray(rows)||rows.length!==addresses.length)throw Error('Wallet funding could not be checked.');
 const mint=MintLayout.decode(binary(rows[1],TOKEN_PROGRAM,82));if(!mint.isInitialized||mint.decimals!==6)throw Error('USDC mint verification failed.');
 const sol=rows[0]?(binary(rows[0],SYSTEM,0),integer(rows[0].lamports)):0n;
 const balance=rows[2]?token(rows[2],wallet):0n;
 if(recipient&&rows[3])token(rows[3],recipient);
 const rent=integer(rentValue);if(rent<=0n||rent>3000000n)throw Error('Receiving account rent could not be checked.');
 const requiredRent=recipient&&rows[3]?0n:rent,requiredSol=requiredRent+BigInt(PAY_TRANSFER_FEE);
 const missingUsdc=BigInt(amount)>balance?BigInt(amount)-balance:0n,missingSol=requiredSol>sol?requiredSol-sol:0n;
 return {wallet,checkedAt:Date.now(),slot:Number(slot),ready:missingUsdc===0n&&missingSol===0n,
  requiredUsdcRaw:amount,balanceUsdcRaw:balance.toString(),missingUsdcRaw:missingUsdc.toString(),
  requiredSolLamports:requiredSol.toString(),balanceSolLamports:sol.toString(),missingSolLamports:missingSol.toString(),
  rentLamports:requiredRent.toString(),feeLamports:PAY_TRANSFER_FEE,estimate:!recipient};
}
