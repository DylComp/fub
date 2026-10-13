import {randomUUID} from 'node:crypto';
import {validFomoTradingProfile,type FomoTradingProfile} from './fomo-trading-profile.js';
import { neon } from '@neondatabase/serverless';
import type { FomoRecipient } from '../src/fomo-recipient.js';
import { validFomoRecipient } from '../src/fomo-recipient.js';
import { fomoHandle } from '../src/fomo-identity.js';
import { isMint } from '../src/assets.js';

export type ResolverPause = 'login_required' | 'operator_setup' | 'upstream_changed' | 'rate_limited' | 'rpc_unavailable';
export type ResolverJob = { handle: string; lease: string };
export function fomoResolverStore(url: string) {
  const db = () => neon(url, { fetchOptions: { signal: AbortSignal.timeout(8000) } });
  return {
    async tradingRecipient(profile:FomoTradingProfile):Promise<string|null> {
      if(!validFomoTradingProfile(profile))throw Error('Invalid trading profile');
      const rows=await db()`SELECT profile,matched_address FROM fomo_resolver_jobs WHERE handle=${profile.handle}
        AND profile_id=${profile.profileId} AND state='ready' AND expires_at>clock_timestamp()`;
      const r=rows[0];if(!r)return null;
      if(!validFomoRecipient(r.profile,profile.handle)||r.profile.source!=='fomo-direct'||r.profile.state!=='matched'||r.profile.address!==r.matched_address)throw Error('Invalid recipient binding');
      return r.matched_address;
    },
    async reserveTradingProfileRead(handle:string):Promise<boolean> {
      if(fomoHandle(handle)!==handle)throw Error('Invalid trading handle');
      const sql=db(),id=randomUUID();
      const results=await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended('fomo-resolver-worker',0))`,
        sql`INSERT INTO fomo_resolver_attempts(id,handle) SELECT ${id}::uuid,${handle} WHERE
          EXISTS(SELECT 1 FROM fomo_resolver_control WHERE id=1 AND pause_reason IS NULL AND heartbeat_at>clock_timestamp()-interval '90 seconds'
            AND (SELECT count(*) FROM fomo_resolver_attempts WHERE started_at>clock_timestamp()-interval '24 hours')<daily_cap)
          AND (SELECT count(*) FROM fomo_resolver_attempts WHERE started_at>clock_timestamp()-interval '1 minute')<5 RETURNING id`,
      ]);return results[1].length===1;
    },
    async recordTradingProfile(profile:FomoTradingProfile):Promise<FomoTradingProfile> {
      if(!validFomoTradingProfile(profile)||Date.now()-profile.observedAt>60000)throw Error('Invalid trading profile evidence');
      const sql=db();
      const rows=await sql`INSERT INTO fomo_resolver_jobs(handle,state,trading_profile)
        VALUES(${profile.handle},'unresolved',${JSON.stringify(profile)}::jsonb)
        ON CONFLICT(handle) DO UPDATE SET trading_profile=CASE
          WHEN fomo_resolver_jobs.trading_profile->>'conflict'='true' THEN fomo_resolver_jobs.trading_profile
          WHEN (fomo_resolver_jobs.profile_id IS NOT NULL AND fomo_resolver_jobs.profile_id<>${profile.profileId}) OR (fomo_resolver_jobs.trading_profile IS NOT NULL AND (
            fomo_resolver_jobs.trading_profile->>'profileId' IS DISTINCT FROM ${profile.profileId} OR
            fomo_resolver_jobs.trading_profile->>'sourceWallet' IS DISTINCT FROM ${profile.sourceWallet} OR
            fomo_resolver_jobs.trading_profile->>'wallet' IS DISTINCT FROM ${profile.wallet}))
          THEN jsonb_build_object('conflict',true,'previous',fomo_resolver_jobs.trading_profile,'candidate',${JSON.stringify(profile)}::jsonb)
          ELSE ${JSON.stringify(profile)}::jsonb END RETURNING trading_profile`;
      const saved=rows[0]?.trading_profile;
      if(!validFomoTradingProfile(saved)||saved.sourceWallet!==profile.sourceWallet||saved.wallet!==profile.wallet)throw Error('Trading profile requires review');
      return saved;
    },
    async lookup(handle: string, enqueue = true): Promise<FomoRecipient | null> {
      if (fomoHandle(handle) !== handle) throw Error('Invalid handle');
      const sql = db();
      const read = async (): Promise<FomoRecipient | null> => {
        const rows = await sql`SELECT j.*,j.expires_at>clock_timestamp() AS fresh,
          c.pause_reason IS NULL AND c.heartbeat_at>clock_timestamp()-interval '90 seconds'
          AND (SELECT count(*) FROM fomo_resolver_attempts WHERE started_at>clock_timestamp()-interval '24 hours')<c.daily_cap AS healthy
          FROM fomo_resolver_jobs j CROSS JOIN fomo_resolver_control c WHERE j.handle=${handle} AND c.id=1`;
        const r = rows[0]; if (!r) return null;
        const now = Date.now();
        const profile = validFomoRecipient(r.profile, handle) ? r.profile : null;
        if (r.state === 'conflict') return profile ? { ...profile, address: null, state: 'conflict', fetchedAt: now } : null;
        if (r.fresh && profile && r.state === 'ready') return { ...profile, fetchedAt: now };
        // A failed refresh can retain an older matched profile for display. Its
        // wallet is no longer verified by this job and must not become a match.
        if (r.fresh && profile && r.state === 'unresolved') return {
          ...profile,address:null,state:'unresolved',retryAfter:60,fetchedAt:now,
        };
        // A missing/private profile is a short negative result, not an outage.
        // Do not return a previous wallet or stats after the profile disappears.
        if (r.fresh && r.state === 'missing') return {
          handle,source:'fomo-direct',address:null,state:'unresolved',observedAt:null,
          displayName:handle,avatarUrl:null,statsAvailable:false,retryAfter:60,fetchedAt:now,
        };
        if (['pending','working'].includes(r.state) && r.healthy) return {
          ...(profile || {handle,source:'fomo-direct' as const,observedAt:null,displayName:handle,avatarUrl:null,statsAvailable:false}),
          address:null,state:'pending',retryAfter:10,fetchedAt:now,
        };
        return null;
      };
      // Cache hits and already queued handles never contend for the global
      // admission lock. Expired mappings still require fresh worker evidence.
      const existing = await read();
      if (existing || !enqueue) return existing;
      await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended('fomo-resolver-enqueue',0))`,
        sql`INSERT INTO fomo_resolver_jobs(handle) SELECT ${handle} WHERE
          EXISTS(SELECT 1 FROM fomo_resolver_control WHERE id=1 AND pause_reason IS NULL AND heartbeat_at>clock_timestamp()-interval '90 seconds'
            AND (SELECT count(*) FROM fomo_resolver_attempts WHERE started_at>clock_timestamp()-interval '24 hours')<daily_cap)
          AND (SELECT count(*) FROM fomo_resolver_jobs WHERE state IN ('pending','working'))<25
          AND (SELECT count(*) FROM fomo_resolver_jobs WHERE created_at>clock_timestamp()-interval '24 hours')<250
          ON CONFLICT(handle) DO UPDATE SET state='pending',attempts=0,next_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE fomo_resolver_jobs.expires_at<clock_timestamp() AND fomo_resolver_jobs.state IN ('ready','unresolved','missing')`,
      ]);
      return read();
    },
    async profilesForWallet(wallet: string): Promise<FomoRecipient[]> {
      if (!isMint(wallet)) throw Error('Invalid wallet');
      const rows = await db()`SELECT handle,state,profile,expires_at>clock_timestamp() AS fresh
        FROM fomo_resolver_jobs WHERE matched_address=${wallet} ORDER BY handle LIMIT 21`;
      if (rows.length>20 || rows.some(row=>row.state==='conflict')) throw Error('Wallet profile requires review');
      const now=Date.now();
      return rows.filter(row=>row.state==='ready'&&row.fresh).map(row=>{
        if(!validFomoRecipient(row.profile,row.handle)||row.profile.source!=='fomo-direct'||row.profile.state!=='matched'||row.profile.address!==wallet)throw Error('Invalid wallet profile');
        return {...row.profile,fetchedAt:now};
      });
    },
    async claim(lease: string, dailyCap = 100): Promise<ResolverJob | null> {
      if (!Number.isInteger(dailyCap) || dailyCap < 1 || dailyCap > 500) throw Error('Invalid resolver cap');
      const sql = db();
      const results = await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended('fomo-resolver-worker',0))`,
        sql`UPDATE fomo_resolver_jobs SET state='unresolved',expires_at=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp()
          WHERE (state='working' AND lease_until<clock_timestamp() AND attempts>=3)
          OR (state='pending' AND updated_at<clock_timestamp()-interval '15 minutes')`,
        sql`UPDATE fomo_resolver_control SET lease_token=${lease}::uuid,lease_until=clock_timestamp()+interval '120 seconds',heartbeat_at=clock_timestamp(),daily_cap=${dailyCap}
          WHERE id=1 AND pause_reason IS NULL AND (lease_until IS NULL OR lease_until<clock_timestamp())`,
        sql`WITH candidate AS (
          SELECT handle FROM fomo_resolver_jobs WHERE next_at<=clock_timestamp() AND attempts<3
          AND (state='pending' OR (state='working' AND lease_until<clock_timestamp())) ORDER BY next_at,handle LIMIT 1 FOR UPDATE SKIP LOCKED
        ), claimed AS (
          UPDATE fomo_resolver_jobs j SET state='working',lease_token=${lease}::uuid,lease_until=clock_timestamp()+interval '120 seconds',attempts=attempts+1,updated_at=clock_timestamp()
          FROM candidate c WHERE j.handle=c.handle
          AND EXISTS(SELECT 1 FROM fomo_resolver_control WHERE id=1 AND lease_token=${lease}::uuid AND lease_until>clock_timestamp() AND pause_reason IS NULL)
          AND (SELECT count(*) FROM fomo_resolver_attempts WHERE started_at>clock_timestamp()-interval '24 hours')<${dailyCap}
          AND (SELECT count(*) FROM fomo_resolver_attempts WHERE started_at>clock_timestamp()-interval '1 minute')<5 RETURNING j.handle
        ), attempted AS (
          INSERT INTO fomo_resolver_attempts(id,handle) SELECT ${lease}::uuid,handle FROM claimed RETURNING handle
        ) SELECT handle FROM attempted`,
      ]);
      const row = results[3][0]; return row ? {handle:row.handle as string,lease} : null;
    },
    async release(lease: string) {
      await db()`UPDATE fomo_resolver_control SET lease_until=clock_timestamp() WHERE id=1 AND lease_token=${lease}::uuid`;
    },
    async offline(lease: string) {
      // A departing process must not mark its replacement unavailable.
      await db()`UPDATE fomo_resolver_control SET heartbeat_at=NULL,lease_until=clock_timestamp()
        WHERE id=1 AND lease_token=${lease}::uuid`;
    },
    // Called only after the worker reads an authenticated Fomo profile.
    // Reauthentication cannot clear another failure or steal an active lease.
    async resumeAuthenticatedSession() {
      const rows = await db()`UPDATE fomo_resolver_control SET pause_reason=NULL,heartbeat_at=clock_timestamp()
        WHERE id=1 AND pause_reason='login_required' AND (lease_until IS NULL OR lease_until<clock_timestamp()) RETURNING id`;
      return rows.length === 1;
    },
    async resume() {
      await db()`UPDATE fomo_resolver_control SET pause_reason=NULL,heartbeat_at=clock_timestamp() WHERE id=1 AND (lease_until IS NULL OR lease_until<clock_timestamp())`;
    },
    async complete(job: ResolverJob, profileId: string, profile: FomoRecipient, evidence: object | null) {
      if (!validFomoRecipient(profile,job.handle) || profile.source !== 'fomo-direct' || !profileId || profileId.length>100 || !['matched','unresolved'].includes(profile.state) || (profile.state==='matched'&&!evidence)) throw Error('Invalid discovery result');
      if(profile.state==='matched') {
        const proof=evidence as Record<string,unknown>;
        if(proof.address!==profile.address||typeof proof.destination!=='string'||!isMint(proof.destination)||!['unsigned-usdc-draft','unsigned-sol-draft'].includes(proof.method as string)||typeof proof.draftHash!=='string'||!/^[a-f0-9]{64}$/.test(proof.draftHash as string)||!Number.isSafeInteger(proof.contextSlot)||(proof.contextSlot as number)<1)throw Error('Invalid discovery evidence');
        if(['unsigned-sol-draft'].includes(proof.method as string)&&proof.destination!==proof.address)throw Error('Invalid SOL discovery evidence');
      }
      const sql = db();
      const rows = await sql`UPDATE fomo_resolver_jobs j SET
        state=CASE WHEN (j.profile_id IS NOT NULL AND j.profile_id<>${profileId}) OR (j.matched_address IS NOT NULL AND ${profile.address}::text IS NOT NULL AND j.matched_address<>${profile.address}::text) THEN 'conflict' ELSE ${profile.state==='matched'?'ready':'unresolved'} END,
        matched_address=COALESCE(j.matched_address,${profile.address}),
        profile_id=COALESCE(j.profile_id,${profileId}),profile=CASE
          WHEN j.profile_id=${profileId} AND jsonb_typeof(j.profile->'profileStats'->'details'->'positions')='array'
            AND ${profile.profileStats?.details?.positions==null}
            AND (j.profile->'profileStats'->>'observedAt')::bigint<=${profile.fetchedAt}
          THEN jsonb_set(${JSON.stringify(profile)}::jsonb,'{profileStats}',j.profile->'profileStats')
          ELSE ${JSON.stringify(profile)}::jsonb END,
        evidence=CASE WHEN (j.profile_id IS NOT NULL AND j.profile_id<>${profileId}) OR (j.matched_address IS NOT NULL AND ${profile.address}::text IS NOT NULL AND j.matched_address<>${profile.address}::text)
          THEN jsonb_build_object('previous',j.evidence,'candidate',${JSON.stringify(evidence)}::jsonb,'candidateProfileId',${profileId}::text) ELSE ${JSON.stringify(evidence)}::jsonb END,
        expires_at=clock_timestamp()+${profile.state==='matched'?300:60}*interval '1 second',updated_at=clock_timestamp(),lease_until=NULL
        WHERE handle=${job.handle} AND state='working' AND lease_token=${job.lease}::uuid AND lease_until>clock_timestamp()
        AND EXISTS(SELECT 1 FROM fomo_resolver_control WHERE id=1 AND lease_token=${job.lease}::uuid AND lease_until>clock_timestamp() AND pause_reason IS NULL) RETURNING handle`;
      if (rows.length!==1) throw Error('Discovery lease lost');
    },
    // Authenticated public-profile refresh only. Never renews wallet proof, its
    // expiry, or the discovery lease; no transfer draft is needed for display data.
    async refreshPublicProfile(profileId:string,profile:FomoRecipient):Promise<boolean> {
      const observed=profile.profileStats?.observedAt;
      if(!validFomoRecipient(profile,profile.handle)||profile.source!=='fomo-direct'||profile.state!=='unresolved'||profile.address!==null||
        !profileId||profileId.length>100||typeof observed!=='number'||observed>Date.now()||Date.now()-observed>60000)throw Error('Invalid public profile refresh');
      const fields={fetchedAt:profile.fetchedAt,displayName:profile.displayName,avatarUrl:profile.avatarUrl,profileStats:profile.profileStats};
      const rows=await db()`UPDATE fomo_resolver_jobs SET profile=profile || ${JSON.stringify(fields)}::jsonb
        WHERE handle=${profile.handle} AND profile_id=${profileId} AND state='ready'
        AND profile->>'source'='fomo-direct' AND profile->>'state'='matched'
        AND profile->>'address'=matched_address
        AND COALESCE((profile->'profileStats'->>'observedAt')::bigint,0)<=${observed}
        AND NOT (COALESCE(jsonb_typeof(profile->'profileStats'->'details'->'positions')='array',false) AND ${profile.profileStats?.details?.positions==null})
        RETURNING handle`;
      return rows.length===1;
    },
    async observe(job:ResolverJob,profileId:string,profile:FomoRecipient) {
      if(!validFomoRecipient(profile,job.handle)||profile.source!=='fomo-direct'||profile.address!==null||profile.state!=='unresolved'||!profileId||profileId.length>100)throw Error('Invalid profile observation');
      await db()`UPDATE fomo_resolver_jobs j SET state=CASE WHEN j.profile_id IS NOT NULL AND j.profile_id<>${profileId} THEN 'conflict' ELSE j.state END,
        profile_id=COALESCE(j.profile_id,${profileId}),profile=CASE
          WHEN j.profile_id=${profileId} AND jsonb_typeof(j.profile->'profileStats'->'details'->'positions')='array'
            AND ${profile.profileStats?.details?.positions==null}
            AND (j.profile->'profileStats'->>'observedAt')::bigint<=${profile.fetchedAt}
          THEN jsonb_set(${JSON.stringify(profile)}::jsonb,'{profileStats}',j.profile->'profileStats')
          ELSE ${JSON.stringify(profile)}::jsonb END,updated_at=clock_timestamp()
        WHERE handle=${job.handle} AND state='working' AND lease_token=${job.lease}::uuid AND lease_until>clock_timestamp()
        AND EXISTS(SELECT 1 FROM fomo_resolver_control WHERE id=1 AND lease_token=${job.lease}::uuid AND lease_until>clock_timestamp() AND pause_reason IS NULL)`;
    },
    async fail(job: ResolverJob, reason: ResolverPause | 'missing' | 'retry') {
      const sql = db();
      const pause = !['missing','retry'].includes(reason);
      await sql.transaction([
        sql`UPDATE fomo_resolver_jobs SET state=CASE WHEN ${reason}='missing' THEN 'missing' WHEN ${pause} OR attempts>=3 THEN 'unresolved' ELSE 'pending' END,
          next_at=clock_timestamp()+interval '60 seconds',expires_at=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp(),lease_until=NULL
          WHERE handle=${job.handle} AND state='working' AND lease_token=${job.lease}::uuid AND lease_until>clock_timestamp()`,
        sql`UPDATE fomo_resolver_control SET pause_reason=CASE WHEN ${pause} THEN ${pause?reason:null} ELSE pause_reason END
          WHERE id=1 AND lease_token=${job.lease}::uuid AND lease_until>clock_timestamp()`,
      ]);
    },
    async availability() {
      // Admission pressure is not evidence that a username does not exist.
      const rows=await db()`SELECT pause_reason,
        COALESCE(heartbeat_at>clock_timestamp()-interval '90 seconds',false) AS online,daily_cap,
        (SELECT count(*)::integer FROM fomo_resolver_attempts WHERE started_at>clock_timestamp()-interval '24 hours') AS attempts,
        (SELECT count(*)::integer FROM fomo_resolver_jobs WHERE state IN ('pending','working')) AS queued,
        (SELECT count(*)::integer FROM fomo_resolver_jobs WHERE created_at>clock_timestamp()-interval '24 hours') AS new_jobs,
        (SELECT ceil(extract(epoch FROM min(started_at)+interval '24 hours'-clock_timestamp()))::integer FROM fomo_resolver_attempts WHERE started_at>clock_timestamp()-interval '24 hours') AS attempt_retry,
        (SELECT ceil(extract(epoch FROM min(created_at)+interval '24 hours'-clock_timestamp()))::integer FROM fomo_resolver_jobs WHERE created_at>clock_timestamp()-interval '24 hours') AS jobs_retry
        FROM fomo_resolver_control WHERE id=1`;
      const row=rows[0];
      const retry=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?Math.max(1,Math.min(86400,Math.ceil(value))):60;
      if(!row||!row.online||row.pause_reason)return {code:'resolver_unavailable',retryAfter:60} as const;
      if(row.attempts>=row.daily_cap)return {code:'resolver_daily_limit',retryAfter:retry(row.attempt_retry)} as const;
      if(row.queued>=25)return {code:'resolver_queue_full',retryAfter:60} as const;
      if(row.new_jobs>=250)return {code:'resolver_daily_limit',retryAfter:retry(row.jobs_retry)} as const;
      return null;
    },
    async health() {
      const rows=await db()`SELECT heartbeat_at,pause_reason,lease_until,daily_cap,
        (SELECT count(*)::integer FROM fomo_resolver_attempts WHERE started_at>clock_timestamp()-interval '24 hours') AS attempts_last_24h,
        heartbeat_at>clock_timestamp()-interval '90 seconds' AND pause_reason IS NULL
        AND (SELECT count(*) FROM fomo_resolver_attempts WHERE started_at>clock_timestamp()-interval '24 hours')<daily_cap AS ready
        FROM fomo_resolver_control WHERE id=1`;
      return rows[0] || null;
    },
  };
}
export type FomoResolverStore = ReturnType<typeof fomoResolverStore>;
