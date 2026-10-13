import {neon} from '@neondatabase/serverless';
import type {CashSigningParts,CashSigningPart} from './cash-copy-signing-parts.js';
export function cashLimitSigningParts(url:string):CashSigningParts{
 const query=()=>neon(url,{fetchOptions:{signal:AbortSignal.timeout(5000)}});
 const valid=(id:string,digest:string)=>{if(!/^cash-limit:[0-9a-f-]{36}:(buy|sell):[01]$/.test(id)||!/^[0-9a-f]{64}$/.test(digest))throw Error('Invalid signing identity.');};
 return{
  async claim(id,digest){valid(id,digest);const sql=query();return(await sql`INSERT INTO signer_cash_parts(id,digest) VALUES(${id},${digest}) ON CONFLICT DO NOTHING RETURNING id`).length===1;},
  async get(id){const rows=await query()`SELECT id,digest,state,signed FROM signer_cash_parts WHERE id=${id}`;return rows[0]?rows[0] as CashSigningPart:null;},
  async complete(id,digest,signed){valid(id,digest);if(typeof signed!=='string'||!signed||signed.length>140000)throw Error('Invalid signature record.');const sql=query();
   const rows=await sql`UPDATE signer_cash_parts SET state='signed',signed=${signed},updated_at=clock_timestamp() WHERE id=${id} AND digest=${digest} AND state='claimed' AND signed IS NULL RETURNING id`;
   if(rows.length===1)return;const old=await this.get(id);if(old?.digest!==digest||old.state!=='signed'||old.signed!==signed)throw Error('Signing result changed.');
  }
 };
}
