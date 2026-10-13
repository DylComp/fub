import {neon} from '@neondatabase/serverless';
import {createHash,createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import type {GiftSelection} from '../src/gift-checkout-model.js';
import type {Invoice,InvoiceStatus} from './bitrefill-invoice.js';
export type GiftSecret = { selection:GiftSelection; name:string; currency:string; invoice?:Invoice; status?:InvoiceStatus };
export type StoredGift = {id:string;wallet:string;hash:string;revision:number;state:'creating'|'uncertain'|'ready';createdAt:number;closed:boolean;secret:GiftSecret};
export function giftCipher(secret:string){
 if(!/^[a-f0-9]{64}$/.test(secret))throw Error('Purchase encryption is unavailable.');const key=Buffer.from(secret,'hex');
 return {
 seal(id:string,wallet:string,value:GiftSecret){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(`fub-gift-v1:${id}:${wallet}`));return Buffer.concat([iv,c.update(JSON.stringify(value)),c.final(),c.getAuthTag()]).toString('base64url');},
 open(id:string,wallet:string,raw:string):GiftSecret{try{const b=Buffer.from(raw,'base64url');if(b.length<29||b.length>75000)throw Error();const d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAAD(Buffer.from(`fub-gift-v1:${id}:${wallet}`));d.setAuthTag(b.subarray(-16));return JSON.parse(Buffer.concat([d.update(b.subarray(12,-16)),d.final()]).toString());}catch{throw Error('Purchase record could not be opened.');}}
 };
}
export const giftRequestHash=(s:GiftSelection)=>createHash('sha256').update(JSON.stringify([s.product,s.value,s.country,s.email])).digest('hex');
export function giftCheckoutStore(url:string,key:string){
 const cipher=giftCipher(key),query=()=>neon(url,{fetchOptions:{signal:AbortSignal.timeout(8000)}});
 const parse=(r:any):StoredGift=>({id:r.id,wallet:r.wallet,hash:r.request_hash,revision:Number(r.revision),state:r.state,createdAt:new Date(r.created_at).getTime(),closed:!!r.closed_at,secret:cipher.open(r.id,r.wallet,r.encrypted)});
 return {
 async get(wallet:string,id:string){const r=await query()`SELECT * FROM fub_gift_purchases WHERE wallet=${wallet} AND id=${id}`;return r[0]?parse(r[0]):null;},
 async list(wallet:string){return (await query()`SELECT * FROM fub_gift_purchases WHERE wallet=${wallet} ORDER BY created_at DESC LIMIT 30`).map(parse);},
 async create(wallet:string,id:string,hash:string,secret:GiftSecret){
  const rows=await query()`INSERT INTO fub_gift_purchases(id,wallet,request_hash,encrypted,state) SELECT ${id},${wallet},${hash},${cipher.seal(id,wallet,secret)},'creating'
   WHERE (SELECT count(*) FROM fub_gift_purchases WHERE wallet=${wallet} AND created_at>clock_timestamp()-interval '1 day')<10
   ON CONFLICT DO NOTHING RETURNING *`;
  if(rows[0])return {created:true,order:parse(rows[0])};
  const r=await this.get(wallet,id);if(!r||r.hash!==hash)throw Error('An open purchase already exists, or the daily purchase limit was reached. Open purchase history.');return {created:false,order:r};
 },
 async ready(order:StoredGift,invoice:Invoice){const secret={...order.secret,invoice};const r=await query()`UPDATE fub_gift_purchases SET state='ready',revision=revision+1,encrypted=${cipher.seal(order.id,order.wallet,secret)},updated_at=clock_timestamp() WHERE id=${order.id} AND wallet=${order.wallet} AND state IN('creating','uncertain') RETURNING *`;if(!r[0])throw Error('Invoice could not be recorded.');return parse(r[0]);},
 async uncertain(order:StoredGift){await query()`UPDATE fub_gift_purchases SET state='uncertain',updated_at=clock_timestamp() WHERE id=${order.id} AND wallet=${order.wallet} AND state='creating'`;},
 async reserveCheck(wallet:string,id:string){const r=await query()`UPDATE fub_gift_purchases SET next_check_at=clock_timestamp()+interval '20 seconds' WHERE wallet=${wallet} AND id=${id} AND state='ready' AND next_check_at<=clock_timestamp() RETURNING id`;return !!r.length;},
 async status(order:StoredGift,status:InvoiceStatus){const secret={...order.secret,status};const r=await query()`UPDATE fub_gift_purchases SET revision=revision+1,encrypted=${cipher.seal(order.id,order.wallet,secret)},closed_at=CASE WHEN ${status.delivery.status==='delivered'||status.delivery.refunded} THEN COALESCE(closed_at,clock_timestamp()) ELSE closed_at END,updated_at=clock_timestamp() WHERE id=${order.id} AND wallet=${order.wallet} AND state='ready' AND revision=${order.revision} RETURNING *`;if(!r[0]){const current=await this.get(order.wallet,order.id);if(!current)throw Error('Purchase status unavailable.');return current;}return parse(r[0]);},
 async close(order:StoredGift){await query()`UPDATE fub_gift_purchases SET closed_at=COALESCE(closed_at,clock_timestamp()),updated_at=clock_timestamp() WHERE wallet=${order.wallet} AND id=${order.id} AND state='ready'`;}
 };
}
export type GiftStore=ReturnType<typeof giftCheckoutStore>;
