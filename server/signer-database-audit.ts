import { neon } from "@neondatabase/serverless";

export const APPLICATION_SIGNER_TABLES = [
  "fomo_copy_attempts", "fomo_copy_authorized_plans", "fomo_copy_permissions",
  "fomo_copy_dispatch", "fomo_copy_dispatch_control", "fomo_copy_feed",
  "fomo_copy_feed_events", "fomo_copy_plans", "fomo_copy_controls",
  "fomo_token22_executions", "fomo_token22_permissions", "fomo_token22_authorized_reservations", "fomo_token22_current_jobs", "fomo_token22_jobs",
] as const;
export const PRIVATE_SIGNER_TABLES = ["signer_copy_requests", "signer_wallet_epochs", "signer_enrollments", "signer_copy_inventory", "signer_inventory_reviews", "signer_native_requests"] as const;
export const DIRECT_EXIT_SIGNER_TABLES=['signer_direct_exits'] as const;
export const CASH_COPY_SIGNER_TABLES=['signer_cash_journals','signer_cash_parts'] as const;
export const CASH_LIMIT_SIGNER_TABLES=['signer_cash_limits','signer_cash_parts','fub_cash_purchases','fub_cash_sales','signer_cash_nonce_claims'] as const;
export type DatabaseAuditConfig = { applicationReadUrl: string; privateBudgetUrl: string; trustedAdminRoles: string[]; directExits?:boolean;cashCopies?:boolean;cashLimits?:boolean };
export class SignerDatabaseRefused extends Error {
  constructor() { super("Signing database isolation is unavailable or does not meet the required privileges."); }
}
// One catalog statement gives a consistent privilege snapshot. No business rows,
// passwords, signing material or connection strings are returned or logged.
export const SIGNER_DATABASE_AUDIT_SQL = `
WITH RECURSIVE reachable AS (
  SELECT oid AS root, oid AS member FROM pg_roles
  UNION
  SELECT r.root, m.roleid FROM reachable r JOIN pg_auth_members m ON m.member=r.member
), me AS (SELECT * FROM pg_roles WHERE rolname=current_user),
objects AS (
 SELECT c.oid,n.nspname,c.relname,c.relkind,c.relowner,c.relrowsecurity
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
   AND c.relkind IN ('r','p','v','m','f','S')
)
SELECT json_build_object(
 'database',current_database(),'role',current_user,'sessionRole',session_user,
 'unsafeRole', EXISTS(SELECT 1 FROM me WHERE rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)
   OR EXISTS(SELECT 1 FROM reachable r JOIN me ON me.oid=r.root WHERE r.member<>me.oid),
 'ownsDatabase', EXISTS(SELECT 1 FROM pg_database d,me WHERE d.datname=current_database() AND d.datdba=me.oid),
 'createDatabaseObjects',has_database_privilege(current_database(),'CREATE') OR has_database_privilege(current_database(),'TEMP'),
 'schemaWrite',EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
   AND (has_schema_privilege(n.oid,'CREATE') OR n.nspowner=(SELECT oid FROM me))),
 'schemaPublicWrite',EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname='public' AND has_schema_privilege('public',n.oid,'CREATE')),
 'searchPath',current_schemas(false),
 'objects',COALESCE((SELECT json_agg(json_build_object(
   'schema',nspname,'name',relname,'kind',relkind,'owned',relowner=(SELECT oid FROM me),'rls',relrowsecurity,
   'select',CASE WHEN relkind='S' THEN has_sequence_privilege(oid,'SELECT,USAGE,UPDATE') ELSE has_table_privilege(oid,'SELECT') END,
   'insert',CASE WHEN relkind='S' THEN false ELSE has_table_privilege(oid,'INSERT') END,
   'update',CASE WHEN relkind='S' THEN false ELSE has_table_privilege(oid,'UPDATE') END,
   'delete',CASE WHEN relkind='S' THEN false ELSE has_table_privilege(oid,'DELETE,TRUNCATE,REFERENCES,TRIGGER') END,
   'columnRead',CASE WHEN relkind='S' THEN false ELSE has_any_column_privilege(oid,'SELECT') END,
   'columnWrite',CASE WHEN relkind='S' THEN false ELSE has_any_column_privilege(oid,'INSERT,UPDATE,REFERENCES') END,
   'grant',CASE WHEN relkind='S' THEN has_sequence_privilege(oid,'SELECT WITH GRANT OPTION,USAGE WITH GRANT OPTION,UPDATE WITH GRANT OPTION')
     ELSE has_table_privilege(oid,'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,DELETE WITH GRANT OPTION,TRUNCATE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION,TRIGGER WITH GRANT OPTION')
       OR has_any_column_privilege(oid,'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION') END
 )) FROM objects),'[]'::json),
 'functions',COALESCE((SELECT json_agg(json_build_object('schema',n.nspname,'name',p.proname,'definer',p.prosecdef,
   'execute',has_function_privilege(p.oid,'EXECUTE'),'owned',p.proowner=(SELECT oid FROM me),
   'grant',has_function_privilege(p.oid,'EXECUTE WITH GRANT OPTION')))
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog','information_schema')),'[]'::json),
 'connectingRoles',COALESCE((SELECT json_agg(r.rolname) FROM pg_roles r WHERE r.rolcanlogin AND NOT r.rolsuper AND EXISTS(
   SELECT 1 FROM reachable x WHERE x.root=r.oid AND has_database_privilege(x.member,current_database(),'CONNECT')
 )),'[]'::json)
) AS audit`;

type DbObject = { schema: string; name: string; kind: string; owned: boolean; rls: boolean; select: boolean; insert: boolean; update: boolean; delete: boolean; columnRead: boolean; columnWrite: boolean; grant: boolean };
export type DatabaseAuditSnapshot = {
  database: string; role: string; sessionRole: string; unsafeRole: boolean; ownsDatabase: boolean;
  createDatabaseObjects: boolean; schemaWrite: boolean; schemaPublicWrite: boolean; searchPath: string[];
  objects: DbObject[]; functions: { schema: string; name: string; definer: boolean; execute: boolean; owned: boolean; grant: boolean }[];
  connectingRoles: string[];
};
export function verifyDatabaseSnapshot(s: DatabaseAuditSnapshot, lane: "application" | "private", expectedRole: string, admins: string[], directExits=false,cashCopies=false,cashLimits=false) {
  if (!s || s.role !== expectedRole || s.sessionRole !== expectedRole || s.unsafeRole !== false || s.ownsDatabase !== false ||
      s.createDatabaseObjects !== false || s.schemaWrite !== false || s.schemaPublicWrite !== false ||
      !Array.isArray(s.searchPath) || s.searchPath.join(",") !== "public" ||
      !Array.isArray(s.objects) || !Array.isArray(s.functions) || !Array.isArray(s.connectingRoles)) throw new SignerDatabaseRefused();
  const required: readonly string[] = lane === "application" ? APPLICATION_SIGNER_TABLES : [...PRIVATE_SIGNER_TABLES,...(directExits?DIRECT_EXIT_SIGNER_TABLES:[]),...(cashCopies?CASH_COPY_SIGNER_TABLES:[]),...(cashLimits?CASH_LIMIT_SIGNER_TABLES:[])];
  for (const name of required) {
    const matches = s.objects.filter(o => o.schema === "public" && o.name === name);
    if (matches.length !== 1 || matches[0].select !== true || !["r", "v"].includes(matches[0].kind) || matches[0].rls !== false ||
        (lane === "private" && (matches[0].kind !== "r" || matches[0].insert !== true || matches[0].update !== true))) throw new SignerDatabaseRefused();
  }
  for (const o of s.objects) {
    const allowed = o.schema === "public" && (required.includes(o.name)||(lane==='private'&&cashCopies&&CASH_LIMIT_SIGNER_TABLES.includes(o.name as typeof CASH_LIMIT_SIGNER_TABLES[number])));
    if (o.owned !== false || o.grant !== false || o.delete !== false ||
        (!allowed && (o.select !== false || o.columnRead !== false || o.insert !== false || o.update !== false || o.columnWrite !== false)) ||
        (lane === "application" && (o.insert !== false || o.update !== false || o.columnWrite !== false))) throw new SignerDatabaseRefused();
  }
  for (const f of s.functions) {
    if (f.owned !== false || f.grant !== false || (f.execute && f.definer)) throw new SignerDatabaseRefused();
  }
  if (lane === "application" && !s.functions.some(f => f.schema === "public" && f.name === "fomo_copy_dispatch_allowed" && f.execute && !f.definer)) throw new SignerDatabaseRefused();
  if (lane === "private" && s.connectingRoles.some(r => r !== s.role && !admins.includes(r))) throw new SignerDatabaseRefused();
}
function databaseConfig(c: DatabaseAuditConfig) {
  const app = new URL(c.applicationReadUrl), priv = new URL(c.privateBudgetUrl);
  const role = (u: URL) => decodeURIComponent(u.username);
  if (![app,priv].every(u => ["postgres:","postgresql:"].includes(u.protocol) && u.username && u.pathname.length>1) ||
      (app.hostname===priv.hostname && app.pathname===priv.pathname) || role(app)===role(priv) ||
      !Array.isArray(c.trustedAdminRoles) || !c.trustedAdminRoles.length || c.trustedAdminRoles.length>8 ||
      c.trustedAdminRoles.some(r => !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(r) || [role(app),role(priv)].includes(r))) throw new SignerDatabaseRefused();
  return { app, priv, role };
}
export async function auditSignerDatabases(c: DatabaseAuditConfig) {
  try {
    const { app, priv, role } = databaseConfig(c);
    const read = async (url: string) => {
      const rows = await neon(url,{fetchOptions:{signal:AbortSignal.timeout(5000)}}).query(SIGNER_DATABASE_AUDIT_SQL);
      if (rows.length!==1) throw new SignerDatabaseRefused();
      return rows[0].audit as DatabaseAuditSnapshot;
    };
    const [a,p] = await Promise.all([read(c.applicationReadUrl),read(c.privateBudgetUrl)]);
    verifyDatabaseSnapshot(a,"application",role(app),c.trustedAdminRoles);
    verifyDatabaseSnapshot(p,"private",role(priv),c.trustedAdminRoles,c.directExits,c.cashCopies,c.cashLimits);
    if(c.cashLimits){
      const rows=await neon(c.privateBudgetUrl,{fetchOptions:{signal:AbortSignal.timeout(5000)}})`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='signer_cash_limits' AND column_name IN ('next_check_at','next_delivery_at','document','revision')`;
      if(rows.length!==4)throw new SignerDatabaseRefused();
    }
    if(c.directExits){
      const rows=await neon(c.privateBudgetUrl,{fetchOptions:{signal:AbortSignal.timeout(5000)}})`SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='signer_direct_exits' AND column_name IN ('trigger_observation','delivery_id','delivery_until','next_check_at','next_observe_at')`;
      if(rows.length!==5)throw new SignerDatabaseRefused();
    }
    if (a.database!==decodeURIComponent(app.pathname.slice(1)) || p.database!==decodeURIComponent(priv.pathname.slice(1))) throw new SignerDatabaseRefused();
  } catch { throw new SignerDatabaseRefused(); }
}
