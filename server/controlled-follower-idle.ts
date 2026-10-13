import {neon} from '@neondatabase/serverless';
import {token22Journal} from './token2022-journal.js';

// A signed journal stays signed after proved expiry to preserve its bytes and
// duplicate fence. Only the validated expiry proof makes it terminal.
export async function controlledFollowerIdle(url:string,wallet:string):Promise<boolean>{
 const sql=neon(url,{fetchOptions:{signal:AbortSignal.timeout(10000)}});
 const rows=await sql`SELECT id FROM fomo_token22_executions
  WHERE wallet=${wallet} AND state IN('prepared','signing','signed')`;
 const journal=token22Journal(url);
 for(const row of rows){
  const record=await journal.get(wallet,row.id);
  if(!record || (record.state!=='confirmed' && record.state!=='failed' && record.state!=='canceled' &&
    !(record.state==='signed' && record.signedExpiry)))return false;
 }
 return true;
}
