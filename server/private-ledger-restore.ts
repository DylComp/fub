import {neon} from '@neondatabase/serverless';
import {PRIVATE_BACKUP_TABLES,PRIVATE_CASH_BACKUP_TABLES,PRIVATE_LIMIT_BACKUP_TABLES,ledgerDigest,validateLedgerBackup,type PrivateLedgerBackup} from './private-ledger-backup.js';

const dbFor=(url:string)=>neon(url,{fetchOptions:{signal:AbortSignal.timeout(20000)}});
const identifier=(name:string)=>{if(!/^[a-z_][a-z0-9_]*$/.test(name))throw Error('Invalid private schema identifier.');return '"'+name+'"';};
// No role-specific ACLs or database OIDs: the isolated target uses other roles.
const schemaSql=`SELECT jsonb_build_object(
 'tables',(SELECT jsonb_agg(jsonb_build_array(c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relpersistence) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN('r','p') AND c.relname~'^(signer_|fub_cash_purchases$|fub_cash_sales$)'),
 'columns',(SELECT jsonb_agg(jsonb_build_array(c.relname,a.attname,a.attnum,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid)) ORDER BY c.relname,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE n.nspname='public' AND c.relkind IN('r','p') AND c.relname~'^(signer_|fub_cash_purchases$|fub_cash_sales$)' AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(c.relname,k.conname,pg_get_constraintdef(k.oid)) ORDER BY c.relname,k.conname) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname~'^(signer_|fub_cash_purchases$|fub_cash_sales$)'),
 'indexes',(SELECT jsonb_agg(jsonb_build_array(tablename,indexname,indexdef) ORDER BY tablename,indexname) FROM pg_indexes WHERE schemaname='public' AND tablename~'^(signer_|fub_cash_purchases$|fub_cash_sales$)'),
 'views',(SELECT jsonb_agg(jsonb_build_array(viewname,definition) ORDER BY viewname) FROM pg_views WHERE schemaname='public' AND viewname~'^(signer_|fub_cash_purchases$|fub_cash_sales$)'),
 'functions',(SELECT jsonb_agg(pg_get_functiondef(p.oid) ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname~'^(signer_|fub_cash_purchases$|fub_cash_sales$)' AND p.prokind='f'),
 'triggers',(SELECT jsonb_agg(jsonb_build_array(c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY c.relname,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname~'^(signer_|fub_cash_purchases$|fub_cash_sales$)' AND NOT t.tgisinternal),
 'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY tablename,policyname) FROM pg_policies p WHERE schemaname='public' AND tablename~'^(signer_|fub_cash_purchases$|fub_cash_sales$)')
)::text AS schema`;
const tableSql=(name:string)=>`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS rows,count(*)::int AS count FROM public.${identifier(name)} t`;

export async function snapshotPrivateLedger(url:string,migrations:PrivateLedgerBackup['migrations']):Promise<PrivateLedgerBackup&{version:2|3|4}>{
 const db=dbFor(url);
 const [initial]=await db.query(schemaSql),names=JSON.parse(initial.schema).tables?.map((t:unknown[])=>t[0]).join(',');
 const tables:readonly string[]=names===[...PRIVATE_LIMIT_BACKUP_TABLES].sort().join(',')?PRIVATE_LIMIT_BACKUP_TABLES:names===[...PRIVATE_CASH_BACKUP_TABLES].sort().join(',')?PRIVATE_CASH_BACKUP_TABLES:PRIVATE_BACKUP_TABLES;
 if(names!==[...tables].sort().join(','))throw Error('Private schema has missing or unreviewed tables.');
 const result=await db.transaction([db.query(schemaSql),...tables.map(t=>db.query(tableSql(t)))],{isolationLevel:'RepeatableRead',readOnly:true});
 const schema:string=result[0][0].schema;
 if(JSON.parse(schema).tables.map((t:unknown[])=>t[0]).join(',')!==[...tables].sort().join(','))throw Error('Private schema has missing or unreviewed tables.');
 if(JSON.parse(schema).columns.some((c:unknown[])=>c[5]!==''||typeof c[7]==='string'&&c[7].includes('nextval(')))throw Error('Unreviewed private identity counter.');
 return validateLedgerBackup({version:tables===PRIVATE_LIMIT_BACKUP_TABLES?4:tables===PRIVATE_CASH_BACKUP_TABLES?3:2,kind:'fub-private-ledger',createdAt:new Date().toISOString(),schema,schemaHash:ledgerDigest(schema),migrations,tables:tables.map((name,i)=>({name,rows:result[i+1][0].rows,count:result[i+1][0].count,sha256:ledgerDigest(result[i+1][0].rows)}))}) as PrivateLedgerBackup&{version:2|3|4};
}

// Rehearsal only. Legacy v1 files remain decryptable, but do not carry the
// original schema required for this verified restore path.
export async function restorePrivateLedger(url:string,value:PrivateLedgerBackup){
 const database=new URL(url).pathname.slice(1);
 if(!/^(?:fub_restore_check_|fomo_check_)[a-f0-9]{32}$/.test(database))throw Error('Isolated restore database required.');
 validateLedgerBackup(value);
 if(value.version===1)throw Error('Private restore requires a schema-bound version 2, 3 or 4 snapshot.');
 const db=dbFor(url),[schema]=await db.query(schemaSql);
 if(schema.schema!==value.schema)throw Error('Private restore schema differs from the saved snapshot.');
 const columns=await db`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name~'^(signer_|fub_cash_purchases$|fub_cash_sales$)' AND is_generated='NEVER' AND is_identity='NO' ORDER BY table_name,ordinal_position`;
 const queries=[
  db.query(`LOCK TABLE ${value.tables.map(t=>'public.'+identifier(t.name)).join(',')} IN ACCESS EXCLUSIVE MODE`),
  db.query('SELECT 1 / CASE WHEN current_database()=$1 THEN 1 ELSE 0 END AS isolated_target',[database]),
  db.query(`SELECT 1 / CASE WHEN s.schema=$1 THEN 1 ELSE 0 END AS unchanged_schema FROM (${schemaSql}) s`,[value.schema]),
 ];
 for(const t of value.tables){
  queries.push(db.query(`SELECT 1 / CASE WHEN EXISTS(SELECT 1 FROM public.${identifier(t.name)}) THEN 0 ELSE 1 END AS empty_target`));
 }
 for(const t of value.tables){
  const names=columns.filter(c=>c.table_name===t.name).map(c=>identifier(c.column_name)).join(',');
  if(!names)throw Error('Private restore columns unavailable.');
  queries.push(db.query(`INSERT INTO public.${identifier(t.name)} (${names}) SELECT ${names} FROM jsonb_populate_recordset(NULL::public.${identifier(t.name)},$1::jsonb)`,[t.rows]));
 }
 await db.transaction(queries);
 const restored=await snapshotPrivateLedger(url,value.migrations);
 if(restored.schema!==value.schema||restored.tables.some((t,i)=>t.sha256!==value.tables[i].sha256||t.count!==value.tables[i].count))throw Error('Restored private ledger differs.');
 return{tables:value.tables.length,rows:value.tables.reduce((sum,t)=>sum+t.count,0),exactRows:true,schemaHash:value.schemaHash};
}
