import {neon} from '@neondatabase/serverless';
import {createHash} from 'node:crypto';
import canonicalize from 'canonicalize';
import type {CashCopyJob} from './cash-copy-service.js';
export type CashSigningPart={id:string;digest:string;state:'claimed'|'signed';signed:string|null};
export interface CashSigningParts{
 claim(id:string,digest:string):Promise<boolean>;
 get(id:string):Promise<CashSigningPart|null>;
 complete(id:string,digest:string,signed:string):Promise<void>;
}
export function cashSigningAttempt(job:Pick<CashCopyJob,'signingAttempt'>){const n=job.signingAttempt??0;if(!Number.isSafeInteger(n)||n<0||n>2)throw Error('Invalid cash signing attempt.');return n;}
export function cashSigningPartId(job:Pick<CashCopyJob,'id'|'scope'|'event'|'signingAttempt'>,index:number){if(index!==0&&index!==1)throw Error('Invalid signing part.');const n=cashSigningAttempt(job);return `cash-copy:${job.scope.planId}:${job.id}:${job.event.side==='buy'?'buy':'sale'}:${index}${n?`:retry:${n}`:''}`;}
export function cashSigningDigest(value:unknown){const body=canonicalize(value);if(!body)throw Error('Invalid signing commitment.');return createHash('sha256').update(body).digest('hex');}
// This table belongs ONLY to the isolated signer database. Neither the web
// application nor observers/executors may create, update or read its rows.
export function cashSigningParts(url:string):CashSigningParts{
 const query=()=>neon(url,{fetchOptions:{signal:AbortSignal.timeout(5000)}});
 const valid=(id:string,digest:string)=>{if(!/^cash-copy:[0-9a-f-]{36}:[0-9a-f-]{36}:(buy|sale):[01](?::retry:[12])?$/.test(id)||!/^[0-9a-f]{64}$/.test(digest))throw Error('Invalid signing identity.');};
 return{
  async claim(id,digest){valid(id,digest);const sql=query();return(await sql`INSERT INTO signer_cash_parts(id,digest) VALUES(${id},${digest}) ON CONFLICT DO NOTHING RETURNING id`).length===1;},
  async get(id){const rows=await query()`SELECT id,digest,state,signed FROM signer_cash_parts WHERE id=${id}`;return rows[0]?rows[0] as CashSigningPart:null;},
  async complete(id,digest,signed){valid(id,digest);if(typeof signed!=='string'||!signed||signed.length>140000)throw Error('Invalid signature record.');const sql=query();
   const rows=await sql`UPDATE signer_cash_parts SET state='signed',signed=${signed},updated_at=clock_timestamp() WHERE id=${id} AND digest=${digest} AND state='claimed' AND signed IS NULL RETURNING id`;
   if(rows.length===1)return;const old=await this.get(id);if(old?.digest!==digest||old.state!=='signed'||old.signed!==signed)throw Error('Signing result changed.');
  }
 };
}
