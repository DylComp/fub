import {createHash} from 'node:crypto';
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
// One immutable return identity per purchase. Changing a client-generated sale
// ID cannot resell the same acquired position after a completed return.
export function cashPublicSaleId(purchaseId:string){
 if(!uuid(purchaseId))throw Error('Invalid purchase identity.');
 const bytes=createHash('sha256').update('fub-cash-return:v1:'+purchaseId.toLowerCase()).digest().subarray(0,16);bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
 const h=bytes.toString('hex');return`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
