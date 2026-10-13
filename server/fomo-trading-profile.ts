import {address,isOffCurveAddress} from '@solana/kit';
import {isMint} from '../src/assets.js';
import {fomoHandle} from '../src/fomo-identity.js';
export type FomoTradingProfile={handle:string;profileId:string;sourceWallet:string;wallet:string;observedAt:number;source:'fomo-direct'};
/** Trading addresses from a normal public profile are NOT transfer destinations.
 * Attribution alone grants no ownership or signing authority. */
export function parseFomoTradingProfile(raw:unknown,handle:string,now=Date.now()):FomoTradingProfile|null{
 if(fomoHandle(handle)!==handle||!Number.isSafeInteger(now)||now<=0||!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid trading profile.');
 const p=raw as Record<string,unknown>;
 if(p.private===true)throw Error('Private trading profile.');
 if(typeof p.userHandle!=='string'||fomoHandle(p.userHandle)!==handle||typeof p.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(p.id))throw Error('Trading identity changed.');
 // Old/missing responses must not infer a chain address from another field.
 if(p.private!==false||p.address==null||p.evmAddress==null)return null;
 if(typeof p.address!=='string'||!isMint(p.address)||p.address==='11111111111111111111111111111111'||isOffCurveAddress(address(p.address))||typeof p.evmAddress!=='string'||!/^0x[0-9a-f]{40}$/i.test(p.evmAddress)||/^0x0{40}$/i.test(p.evmAddress))throw Error('Invalid trading wallets.');
 return{handle,profileId:p.id,sourceWallet:p.address,wallet:p.evmAddress.toLowerCase(),observedAt:now,source:'fomo-direct'};
}
export function validFomoTradingProfile(value:unknown,now=Date.now()):value is FomoTradingProfile{
 const p=value as FomoTradingProfile;
 try{return !!p&&p.source==='fomo-direct'&&p.observedAt<=now&&JSON.stringify(parseFomoTradingProfile({id:p.profileId,userHandle:p.handle,address:p.sourceWallet,evmAddress:p.wallet,private:false},p.handle,p.observedAt))===JSON.stringify({handle:p.handle,profileId:p.profileId,sourceWallet:p.sourceWallet,wallet:p.wallet,observedAt:p.observedAt,source:p.source});}catch{return false;}
}
