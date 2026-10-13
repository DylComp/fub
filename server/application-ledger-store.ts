import {neon} from '@neondatabase/serverless';
import {applicationBackupTables,appDigest,validateApplicationBackup,applicationRestoreOrder,type ApplicationBackup} from './application-ledger-backup.js';
type DB=ReturnType<typeof dbFor>;
const dbFor=(url:string)=>neon(url,{fetchOptions:{signal:AbortSignal.timeout(20000)}});
const identifier=(s:string)=>{if(!/^[a-z_][a-z0-9_]*$/.test(s))throw Error('Invalid schema identifier.');return '"'+s+'"';};
const schemaSql=`SELECT jsonb_build_object(
 'tables',(SELECT jsonb_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname='public' AND tablename~'^(fomo|fub)_'),
 'columns',(SELECT jsonb_agg(jsonb_build_array(table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default,is_identity,identity_generation,is_generated,generation_expression) ORDER BY table_name,ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name IN (SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename~'^(fomo|fub)_')),
 'constraints',(SELECT jsonb_agg(jsonb_build_array(c.relname,k.conname,pg_get_constraintdef(k.oid)) ORDER BY c.relname,k.conname) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname~'^(fomo|fub)_'),
 'indexes',(SELECT jsonb_agg(jsonb_build_array(tablename,indexname,indexdef) ORDER BY tablename,indexname) FROM pg_indexes WHERE schemaname='public' AND tablename~'^(fomo|fub)_'),
 'views',(SELECT jsonb_agg(jsonb_build_array(viewname,definition) ORDER BY viewname) FROM pg_views WHERE schemaname='public' AND viewname~'^(fomo|fub)_'),
 'functions',(SELECT jsonb_agg(pg_get_functiondef(p.oid) ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname~'^(fomo|fub)_' AND p.prokind='f')
)::text AS schema`;
// Column position is physical layout, not a restore dependency: inserts name
// every column explicitly. Keep v1 fingerprints exact for old archives.
const schemaQuery = (version:1|2|3|4|5|6|7) => version === 1 ? schemaSql : schemaSql
 .replace('column_name,ordinal_position,data_type', 'column_name,data_type')
 .replace('ORDER BY table_name,ordinal_position)', 'ORDER BY table_name,column_name)');
const tableSql=(name:string)=>`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS rows,count(*)::int AS count FROM public.${identifier(name)} t`;
async function sequences(db:DB){
 const rows=await db`SELECT table_name AS "table",column_name AS "column",pg_get_serial_sequence(format('%I.%I',table_schema,table_name),column_name) AS qualified FROM information_schema.columns WHERE table_schema='public' AND table_name~'^(fomo|fub)_' AND is_identity='YES' ORDER BY table_name,column_name`;
 return rows.map(r=>{if(typeof r.qualified!=='string'||!/^public\.[a-z_][a-z0-9_]*$/.test(r.qualified))throw Error('Sequence discovery failed.');return{name:r.qualified.slice(7),table:r.table as string,column:r.column as string};});
}
export async function snapshotApplicationLedger(url:string,migrations:ApplicationBackup['migrations'],version:1|2|3|4|5|6|7=7):Promise<ApplicationBackup>{
 const db=dbFor(url),seq=await sequences(db),tables=applicationBackupTables(version);
 const queries=[db.query(schemaQuery(version)),...tables.map(n=>db.query(tableSql(n))),...seq.map(s=>db.query(`SELECT last_value::text AS value,is_called,COALESCE((SELECT max(${identifier(s.column)}) FROM public.${identifier(s.table)}),0)::text AS maximum FROM public.${identifier(s.name)}`))];
 const rows=await db.transaction(queries,{isolationLevel:'RepeatableRead',readOnly:true}),schema=rows[0][0].schema;
 if(JSON.parse(schema).tables.join(',')!==tables.join(','))throw Error('Application schema has missing or unreviewed tables.');
 return validateApplicationBackup({version,kind:'fub-application-ledger',createdAt:new Date().toISOString(),schema,schemaHash:appDigest(schema),migrations,tables:tables.map((name,i)=>({name,...rows[i+1][0],sha256:appDigest(rows[i+1][0].rows)})) as ApplicationBackup['tables'],sequences:seq.map((s,i)=>{const r=rows[1+tables.length+i][0],above=BigInt(r.maximum)>=BigInt(r.value);return{...s,lastValue:above?r.maximum:r.value,isCalled:above||r.is_called};})});
}
// Restores only into an isolated rehearsal database. Seed rows are the only
// allowed pre-existing data. All table inserts are atomic; FKs remain enabled.
export async function restoreApplicationLedger(url:string,value:ApplicationBackup){
 const database=new URL(url).pathname.slice(1);if(!/^(?:fub_app_restore_check_|fomo_check_)[a-f0-9]{32}$/.test(database))throw Error('Isolated application restore database required.');
 validateApplicationBackup(value);const tables=applicationBackupTables(value.version);const db=dbFor(url),[identity]=await db`SELECT current_database() AS name`;
 if(identity.name!==database)throw Error('Restore database identity changed.');
 const [schema]=await db.query(schemaQuery(value.version));if(schema.schema!==value.schema)throw Error('Restore schema differs from the saved snapshot.');
 const seq=await sequences(db);if(JSON.stringify(seq)!==JSON.stringify(value.sequences.map(({name,table,column})=>({name,table,column}))))throw Error('Restore sequence schema differs.');
 const edges=await db`SELECT c.relname AS child,p.relname AS parent FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_class p ON p.oid=k.confrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname~'^(fomo|fub)_' AND k.contype='f'`;
 const order=applicationRestoreOrder(edges as {child:string;parent:string}[],value.version),queries=[db.query(`LOCK TABLE ${tables.map(n=>'public.'+identifier(n)).join(',')} IN ACCESS EXCLUSIVE MODE`)];
 // Assertion is evaluated inside the locked transaction; another restore cannot
 // slip rows in between emptiness inspection and the actual insertion.
 for(const name of tables){
  let condition='TRUE';
  if(name==='fomo_copy_dispatch_control')condition="NOT(name='execution' AND NOT enabled AND epoch=1)";
  if(name==='fomo_resolver_control')condition='NOT(id=1 AND heartbeat_at IS NULL AND pause_reason IS NULL AND lease_token IS NULL AND lease_until IS NULL AND daily_cap=100)';
  queries.push(db.query(`SELECT 1 / CASE WHEN EXISTS(SELECT 1 FROM public.${identifier(name)} WHERE ${condition}) THEN 0 ELSE 1 END AS empty_target`));
 }
 queries.push(db.query('DELETE FROM public.fomo_copy_dispatch_control'),db.query('DELETE FROM public.fomo_resolver_control'));
 const allColumns=await db`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name~'^(fomo|fub)_' AND is_generated='NEVER' ORDER BY table_name,ordinal_position`;
 for(const name of order){
  const cols=allColumns.filter(c=>c.table_name===name);
  const names=cols.map(c=>identifier(c.column_name)).join(',');if(!names)throw Error('Restore columns unavailable.');const saved=value.tables.find(t=>t.name===name)!;
  queries.push(db.query(`INSERT INTO public.${identifier(name)} (${names}) OVERRIDING SYSTEM VALUE SELECT ${names} FROM jsonb_populate_recordset(NULL::public.${identifier(name)},$1::jsonb)`,[saved.rows]));
 }
 await db.transaction(queries);
 // setval is nontransactional. Run only after a successful data commit; no
 // worker has credentials for this isolated target. A sequence failure is fatal.
 for(const s of value.sequences)await db.query(`SELECT setval($1::regclass,$2::bigint,$3::boolean)`,['public.'+s.name,s.lastValue,s.isCalled]);
 const restored=await snapshotApplicationLedger(url,value.migrations,value.version);
 for(const t of value.tables){const r=restored.tables.find(r=>r.name===t.name)!;if(r.sha256!==t.sha256||r.count!==t.count)throw Error('Restored application rows differ.');}
 if(JSON.stringify(restored.sequences)!==JSON.stringify(value.sequences))throw Error('Restored identity counters differ.');
 return{tables:value.tables.length,rows:value.tables.reduce((n,t)=>n+t.count,0),sequences:value.sequences.length,exactRows:true};
}
