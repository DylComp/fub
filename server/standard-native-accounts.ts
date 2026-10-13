import {createHash} from 'node:crypto';
import bs58 from 'bs58';
import {TOKEN_PROGRAM} from '../src/funding-model.js';
import {record} from '../src/live-orders.js';
const invalid=():never=>{throw Error('Standard SPL account evidence is invalid.');};
export function standardNativeBytes(value:unknown,max=165){
 const a=record(value),d=a.data;
 if(a.owner!==TOKEN_PROGRAM||a.executable!==false||!Number.isSafeInteger(a.lamports)||(a.lamports as number)<1||!Array.isArray(d)||d.length!==2||d[1]!=='base64'||typeof d[0]!=='string'||d[0].length>Math.ceil(max/3)*4)return invalid();
 const b=Buffer.from(d[0],'base64');if(b.length>max||b.toString('base64')!==d[0])return invalid();return b;
}
export function inspectStandardNativeMint(value:unknown,_mint:string){
 const b=standardNativeBytes(value,82);
 if(b.length!==82||b[45]!==1||b[44]>18||b.readUInt32LE(0)>1||b.readUInt32LE(46)>1)return invalid();
 return {program:TOKEN_PROGRAM,accountSize:165 as const,transferFee:false,extensions:[] as number[],mintHash:createHash('sha256').update(b).digest('hex')};
}
export function verifyStandardNativeAccount(value:unknown,wallet:string,mint:string,_config?:unknown){
 const b=standardNativeBytes(value);
 if(b.length!==165||bs58.encode(b.subarray(0,32))!==mint||bs58.encode(b.subarray(32,64))!==wallet||b[108]!==1||b.readUInt32LE(72)!==0||b.readUInt32LE(109)!==0||b.readBigUInt64LE(121)!==0n||b.readUInt32LE(129)!==0)return invalid();
 return {lamports:record(value).lamports as number};
}
