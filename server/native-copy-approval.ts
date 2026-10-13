import {FUB_CANONICAL_ORIGIN} from '../src/fub-origin.js';
import {randomUUID} from 'node:crypto';
import {neon} from '@neondatabase/serverless';
import {isMint} from '../src/assets.js';
import {operationId} from '../src/funding-model.js';
import {CopyValidation} from '../src/copy-account.js';
import {CopyConflict} from './copy-store.js';
import {parseToken22Permission,token22PermissionMessage,type Token22Permission} from '../src/native-copy-permission.js';
import {verifyToken22Permission} from './token2022-permission.js';
import {MONITOR_LIMIT} from './copy-monitor-store.js';
export class NativeApprovalConflict extends CopyConflict {
 constructor(readonly reason:string,message:string){super(message);}
}
function blocked(reason:string,message:string):never{throw new NativeApprovalConflict(reason,message);}
function checkPlan(p:Record<string,any>|undefined,scope?:Token22Permission){
 if(!p)blocked('plan_missing','This copy plan no longer exists. Refresh your saved plans.');
 if(p.archived)blocked('plan_archived','This plan is archived. Restore it before setting SOL limits.');
 if(p.stopped)blocked('wallet_stopped','Copying is stopped for this wallet. Resume copying before setting SOL limits.');
 if(scope&&(p.version!==scope.planVersion||p.leader!==scope.leader||p.data.slippageBps!==scope.slippageBps||p.data.copySells!==scope.copySells))blocked('plan_changed','This plan changed after review. Refresh the plan and review its current limits.');
 if(p.legacy_active)blocked('other_limits','This plan has active USDC limits. Revoke those limits before approving SOL limits.');
 if(p.feed_status==='gap')blocked('activity_gap','Leader activity has a gap. Resolve it in Leader activity before approving SOL limits.');
 if(p.other_monitors>=MONITOR_LIMIT)blocked('capacity','Copy monitoring is at capacity. No new approval is needed until a monitoring slot is available.');
}
export type NativeCopyLimits={buyLamports:string;dailySpendLamports:string;maxFeeLamports:string;maxRentLamports:string;durationMs:number;mint?:string};
export function nativeCopyApproval(url:string){
 const db=()=>neon(url,{fetchOptions:{signal:AbortSignal.timeout(10000)}});
 function identity(wallet:string,id:string){if(!isMint(wallet)||!operationId(id))throw new CopyValidation('Invalid wallet or plan.');}
 const planState=(sql:ReturnType<typeof db>,wallet:string,id:string)=>sql`SELECT p.*,
   EXISTS(SELECT 1 FROM fomo_copy_controls c WHERE c.wallet=p.wallet) AS stopped,
   EXISTS(SELECT 1 FROM fomo_copy_permissions g WHERE g.plan_id=p.id AND g.revoked_at IS NULL AND g.expires_at>statement_timestamp()) AS legacy_active,
   (SELECT f.status FROM fomo_copy_feed f WHERE f.plan_id=p.id) AS feed_status,
   (SELECT count(*)::int FROM fomo_copy_monitors m JOIN fomo_copy_plans q ON q.id=m.plan_id WHERE m.enabled AND m.expires_at>statement_timestamp() AND NOT q.archived AND m.plan_id<>p.id) AS other_monitors
   FROM fomo_copy_plans p WHERE p.id=${id} AND p.wallet=${wallet}`;
 return {
  async prepare(wallet:string,id:string,limits:NativeCopyLimits){
   identity(wallet,id);
   if(!limits||Object.keys(limits).sort().join(',')!==('buyLamports,dailySpendLamports,durationMs,maxFeeLamports,maxRentLamports'+(Object.hasOwn(limits,'mint')?',mint':''))||![3600000,86400000].includes(limits.durationMs))throw new CopyValidation('Choose a one-hour or one-day permission.');
   const sql=db(),[p]=await planState(sql,wallet,id);
   checkPlan(p);
   const now=Date.now(),scope:Token22Permission={...(Object.hasOwn(limits,'mint')?{version:10 as const,mint:limits.mint!}:{version:9 as const}),policy:'native-sol-venues-v4',origin:FUB_CANONICAL_ORIGIN,network:'solana:mainnet',id:randomUUID(),planId:id,planVersion:p.version,wallet,leader:p.leader,buyLamports:limits.buyLamports,dailySpendLamports:limits.dailySpendLamports,maxFeeLamports:limits.maxFeeLamports,maxRentLamports:limits.maxRentLamports,copySells:p.data.copySells,slippageBps:p.data.slippageBps,issuedAt:now,acceptBy:now+300000,expiresAt:now+limits.durationMs};
   try{parseToken22Permission(scope);}catch{throw new CopyValidation('SOL limits are invalid. The daily cap must include the buy, network fee and account rent.');}
   return {scope,message:token22PermissionMessage(scope)};
  },
  async accept(wallet:string,scope:Token22Permission,signature:string){
   identity(wallet,scope?.planId);if(scope.wallet!==wallet)throw new CopyValidation('Approval belongs to another wallet.');
   let hash:string;try{hash=verifyToken22Permission(scope,signature);}catch{throw new CopyValidation('The exact approval was not signed by this wallet.');}
   if(scope.issuedAt>Date.now())throw new CopyValidation('This approval has a future timestamp. Review fresh limits.');
   // The SQL admission deadline still prevents new activation. An exact saved
   // approval can be acknowledged after a lost response without signing again.
   const sql=db();
   const result=await sql.transaction([
    sql`SELECT pg_advisory_xact_lock(hashtextextended('copy-monitor-capacity',0))`,
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${wallet},0))`,
    sql`WITH eligible AS MATERIALIZED (
      SELECT p.id,p.wallet
      FROM fomo_copy_plans p LEFT JOIN fomo_copy_feed f ON f.plan_id=p.id
      WHERE p.id=${scope.planId} AND p.wallet=${wallet} AND p.leader=${scope.leader} AND p.version=${scope.planVersion} AND NOT p.archived
       AND (p.data->>'slippageBps')::int=${scope.slippageBps} AND (p.data->>'copySells')::boolean=${scope.copySells}
       AND to_timestamp(${scope.acceptBy}/1000.0)>statement_timestamp() AND NOT EXISTS(SELECT 1 FROM fomo_copy_controls WHERE wallet=${wallet})
       AND NOT EXISTS(SELECT 1 FROM fomo_copy_permissions old WHERE old.plan_id=p.id AND old.revoked_at IS NULL AND old.expires_at>statement_timestamp())
       AND COALESCE(f.status,'idle')<>'gap'
       AND (SELECT count(*) FROM fomo_copy_monitors m JOIN fomo_copy_plans q ON q.id=m.plan_id WHERE m.enabled AND m.expires_at>statement_timestamp() AND NOT q.archived AND m.plan_id<>p.id)<${MONITOR_LIMIT}
       AND NOT EXISTS(SELECT 1 FROM fomo_token22_permissions used WHERE used.id=${scope.id})
       AND NOT EXISTS(SELECT 1 FROM fomo_token22_permissions newer WHERE newer.plan_id=p.id AND (newer.scope->>'issuedAt')::bigint>=${scope.issuedAt})
     ), retired AS (
      UPDATE fomo_token22_permissions SET revoked_at=statement_timestamp()
      WHERE plan_id IN(SELECT id FROM eligible) AND wallet=${wallet} AND revoked_at IS NULL
      RETURNING id
     ), accepted AS (
      INSERT INTO fomo_token22_permissions(id,plan_id,wallet,scope,signature,scope_hash,expires_at)
      SELECT ${scope.id},p.id,p.wallet,${JSON.stringify(scope)}::jsonb,${signature},${hash},to_timestamp(${scope.expiresAt}/1000.0)
      FROM eligible p WHERE (SELECT count(*) FROM retired)>=0
      ON CONFLICT DO NOTHING RETURNING plan_id
     ), activated AS (
      UPDATE fomo_copy_plans SET enabled=true,enabled_at=statement_timestamp() WHERE id IN(SELECT plan_id FROM accepted) RETURNING id
     ), watched AS (
      INSERT INTO fomo_copy_monitors(plan_id,enabled,expires_at) SELECT id,true,to_timestamp(${scope.expiresAt}/1000.0) FROM activated
      ON CONFLICT(plan_id) DO UPDATE SET enabled=true,expires_at=EXCLUDED.expires_at,revision=fomo_copy_monitors.revision+1,lease_id=NULL,lease_until=NULL,failures=0,next_run_at=statement_timestamp(),outcome='idle' RETURNING plan_id
     ), invalidated AS (
      UPDATE fomo_copy_feed SET lease_id=NULL,lease_until=NULL,monitor_revision=NULL WHERE plan_id IN(SELECT plan_id FROM watched)
     ) SELECT plan_id FROM accepted`,
    sql`SELECT g.id,g.scope_hash,g.signature,g.revoked_at,g.expires_at>statement_timestamp() AS grant_live,p.enabled,p.archived,p.version,
      EXISTS(SELECT 1 FROM fomo_copy_monitors m WHERE m.plan_id=p.id AND m.enabled AND m.expires_at>statement_timestamp()) AS monitor_live,EXISTS(SELECT 1 FROM fomo_copy_controls c WHERE c.wallet=p.wallet) AS stopped
      FROM fomo_token22_permissions g JOIN fomo_copy_plans p ON p.id=g.plan_id WHERE g.id=${scope.id} AND g.wallet=${wallet}`,
    planState(sql,wallet,scope.planId),
    sql`SELECT EXISTS(SELECT 1 FROM fomo_token22_permissions WHERE plan_id=${scope.planId} AND wallet=${wallet} AND (scope->>'issuedAt')::bigint>=${scope.issuedAt} AND id<>${scope.id}) AS newer`,
   ]);
   const saved=result[3][0];
   if(!saved||saved.scope_hash!==hash||saved.signature!==signature||saved.revoked_at||!saved.grant_live||!saved.monitor_live||saved.archived||saved.stopped||!saved.enabled||saved.version!==scope.planVersion){
    checkPlan(result[4][0],scope);
    if(saved&&(saved.scope_hash!==hash||saved.signature!==signature))blocked('review_changed','This approval ID already belongs to different limits. Review fresh limits.');
    if(result[5][0]?.newer)blocked('superseded','Newer SOL limits replaced this review. Refresh the plan to see the current approval.');
    if(saved?.revoked_at||saved&&!saved.enabled)blocked('revoked','This approval was revoked or the plan was paused. Review fresh limits only if you want to resume.');
    if(scope.acceptBy<=Date.now()||scope.expiresAt<=Date.now())blocked('expired','This approval expired before it could be activated. Review fresh limits.');
    if(saved&&!saved.monitor_live)blocked('monitor_stopped','Monitoring is paused or expired. Review fresh limits only if you want to resume.');
    blocked('changed','Approval state changed. Refresh the plan before reviewing again.');
   }
   return {id:scope.id,planId:scope.planId,wallet,status:'accepted' as const,expiresAt:scope.expiresAt};
  },
 };
}
