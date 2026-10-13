import {neon} from '@neondatabase/serverless';
export const RESOLVER_TABLES=['fomo_resolver_control','fomo_resolver_jobs','fomo_resolver_attempts'];
export async function auditResolverDatabase(url:string) {
 const db=neon(url,{fetchOptions:{signal:AbortSignal.timeout(8000)}});
 try {
  const [grants,attributes,memberships,extra]=await db.transaction([
   db`SELECT c.relname,has_table_privilege(current_user,c.oid,'SELECT') AS read,has_table_privilege(current_user,c.oid,'INSERT') AS insert,has_table_privilege(current_user,c.oid,'UPDATE') AS update,has_table_privilege(current_user,c.oid,'DELETE') AS delete,has_table_privilege(current_user,c.oid,'TRUNCATE') AS truncate,has_table_privilege(current_user,c.oid,'TRIGGER') AS trigger,has_table_privilege(current_user,c.oid,'REFERENCES') AS reference FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m')`,
   db`SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=current_user`,
   db`SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)`,
   db`SELECT has_schema_privilege(current_user,'public','CREATE') AS schema_create,has_database_privilege(current_user,current_database(),'CREATE') AS db_create,has_database_privilege(current_user,current_database(),'TEMP') AS temp`,
  ]);
  if(RESOLVER_TABLES.some(t=>!grants.some(r=>r.relname===t))||grants.some(({relname,...rights})=>RESOLVER_TABLES.includes(relname)?!rights.read||!rights.insert||!rights.update||rights.delete||rights.truncate||rights.trigger||rights.reference:Object.values(rights).some(Boolean))||attributes.length!==1||Object.values(attributes[0]).some(Boolean)||memberships.length||extra.length!==1||Object.values(extra[0]).some(Boolean))throw Error();
  return {allowedTables:RESOLVER_TABLES.length};
 }catch {throw Error('Resolver database must be restricted to its three lookup tables.');}
}
