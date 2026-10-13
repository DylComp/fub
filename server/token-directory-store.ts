import { neon } from "@neondatabase/serverless";
import { HIDDEN_PUBLIC_LAUNCH_MINT } from "./public-launch-visibility.js";
import { createHash } from "node:crypto";
import { isMint } from "../src/assets.js";
import { fomoAvatar } from "../src/fomo-recipient.js";
import type {
  DirectoryView,
  DirectoryResult,
  DirectoryProfile,
  DirectoryFees,
  DirectoryAssetFees,
} from "../src/token-directory-model.js";
export type DirectoryQuery = {
  token?: string;
  view: DirectoryView;
  q: string;
  recipient: string | null;
  cursor: string | null;
};
const stamp = (s: unknown) => (s ? new Date(String(s)).getTime() : null);
const fingerprint = (q: DirectoryQuery) =>
  createHash("sha256")
    .update(JSON.stringify([q.view, q.q, q.recipient, q.token || null]))
    .digest("hex");
export function directoryCursor(q: DirectoryQuery) {
  if (!q.cursor) return null;
  if (q.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(q.cursor))
    throw Error("Invalid cursor");
  const c = JSON.parse(Buffer.from(q.cursor, "base64url").toString("utf8"));
  if (
    c.scope !== fingerprint(q) ||
    Object.keys(c).sort().join() !==
      (q.view === "tokens" ? "at,key,scope" : "key,scope") ||
    !isMint(c.key) ||
    (q.view === "tokens" &&
      (!Number.isFinite(Date.parse(c.at)) ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(c.at)))
  )
    throw Error("Invalid cursor");
  return c as { key: string; at?: string };
}
function preview(row: any): DirectoryProfile {
  const p =
    row.profile?.handle === row.handle && row.profile?.address === row.recipient
      ? row.profile
      : null;
  return {
    wallet: row.recipient,
    handle: row.handle,
    name:
      p?.handle === row.handle &&
      p?.address === row.recipient &&
      typeof p.displayName === "string" && p.displayName.trim().length > 0
        ? p.displayName.trim().slice(0, 100)
        : row.handle,
    avatarUrl: fomoAvatar(p?.avatarUrl),
    observedAt:
      Number.isSafeInteger(p?.observedAt) && p.observedAt > 0
        ? p.observedAt
        : null,
  };
}
function assetAmounts(rows: any[]): DirectoryAssetFees[] {
 return rows.map(r=>({mint:r.fee_mint,tokenProgram:r.fee_token_program,decimals:r.fee_decimals,
  recipientSent:r.fee_recipient_sent,buybackSent:r.fee_buyback_sent,
  paid:(BigInt(r.fee_recipient_sent)+BigInt(r.fee_buyback_sent)).toString(),
  pending:r.pending_fees===null?null:String(r.pending_fees),checkedAt:stamp(r.fee_checked_at)}));
}
function amounts(row: any): DirectoryFees {
  const recipientSent = String(row.recipient_sent),
    buybackSent = String(row.buyback_sent);
  return {
    recipientSent,
    buybackSent,
    paid: (BigInt(recipientSent) + BigInt(buybackSent)).toString(),
    pending: row.pending_fees === null ? null : String(row.pending_fees),
    checkedAt: stamp(row.fee_checked_at),
    assets:assetAmounts(row.assets || [row]),
  };
}
export function tokenDirectoryStore(url: string) {
  return {
    async list(query: DirectoryQuery): Promise<DirectoryResult> {
      const sql = neon(url, {
          fetchOptions: { signal: AbortSignal.timeout(8000) },
        }),
        cursor = directoryCursor(query),
        pattern = "%" + query.q.replace(/[\\%_]/g, "\\$&") + "%";
      // One statement provides a consistent total/page snapshot. Wallet grouping
      // happens across ALL matching launches, before pagination.
      const rows = await sql`WITH visible AS MATERIALIZED (
    SELECT * FROM fomo_public_launches WHERE mint <> ${HIDDEN_PUBLIC_LAUNCH_MINT}
   ), matching AS MATERIALIZED (
    SELECT * FROM visible WHERE (${query.token ?? null}::text IS NULL OR mint=${query.token ?? null} OR mint IN(SELECT mint FROM fomo_launch_executions WHERE publication_id=${query.token ?? null} AND state='confirmed')) AND (${query.recipient}::text IS NULL OR recipient=${query.recipient}) AND
     (${query.q}='' OR (${query.view}='tokens' AND (name ILIKE ${pattern} OR ticker ILIKE ${pattern} OR mint ILIKE ${pattern})) OR handle ILIKE ${pattern} OR recipient ILIKE ${pattern} OR profile->>'displayName' ILIKE ${pattern})
   ), filtered AS MATERIALIZED (
    SELECT f.* FROM visible f WHERE ${query.view}='profiles' AND f.recipient IN (SELECT recipient FROM matching)
    UNION ALL SELECT * FROM matching WHERE ${query.view}='tokens'
   ), asset_groups AS (
    SELECT recipient,fee_mint,fee_token_program,fee_decimals,
     sum(fee_recipient_sent::numeric)::text AS fee_recipient_sent,sum(fee_buyback_sent::numeric)::text AS fee_buyback_sent,
     CASE WHEN count(pending_fees)=count(*) THEN sum(pending_fees::numeric)::text ELSE NULL END AS pending_fees,
     min(fee_checked_at) AS fee_checked_at FROM filtered GROUP BY recipient,fee_mint,fee_token_program,fee_decimals
   ), asset_totals AS (
    SELECT fee_mint,fee_token_program,fee_decimals,sum(fee_recipient_sent::numeric)::text AS fee_recipient_sent,
     sum(fee_buyback_sent::numeric)::text AS fee_buyback_sent,NULL::text AS pending_fees,NULL::timestamptz AS fee_checked_at
    FROM asset_groups GROUP BY fee_mint,fee_token_program,fee_decimals
   ), grouped AS (
    SELECT recipient,count(*)::integer AS token_count,sum(recipient_sent::numeric)::text AS recipient_sent,sum(buyback_sent::numeric)::text AS buyback_sent,
     CASE WHEN count(pending_fees)=count(*) THEN sum(pending_fees::numeric)::text ELSE NULL END AS pending_fees,
     min(fee_checked_at) AS fee_checked_at FROM filtered GROUP BY recipient
   ), token_page AS (
    SELECT *, (SELECT jsonb_build_object('publicationId',e.publication_id,'description',COALESCE(e.plan->'publication'->'draft'->>'description',''),'twitter',COALESCE(e.plan->'publication'->'draft'->>'twitter',''),'telegram',COALESCE(e.plan->'publication'->'draft'->>'telegram',''),'projectWebsite',COALESCE(e.plan->'publication'->'draft'->>'website','')) FROM fomo_launch_executions e WHERE e.mint=filtered.mint AND e.state='confirmed') AS details,to_char(confirmed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM filtered WHERE ${query.view}='tokens' AND (${cursor?.key ?? null}::text IS NULL OR (confirmed_at,mint)<(${cursor?.at ?? null}::timestamptz,${cursor?.key ?? null}::text)) ORDER BY confirmed_at DESC,mint DESC LIMIT 25
   ), profile_page AS (
    SELECT g.*,latest.handle,latest.profile,(SELECT jsonb_agg(a ORDER BY a.fee_mint) FROM asset_groups a WHERE a.recipient=g.recipient) AS assets FROM grouped g JOIN LATERAL (SELECT handle,profile FROM filtered f WHERE f.recipient=g.recipient ORDER BY confirmed_at DESC,mint DESC LIMIT 1) latest ON true
    WHERE ${query.view}='profiles' AND (${cursor?.key ?? null}::text IS NULL OR g.recipient>${cursor?.key ?? null}) ORDER BY g.recipient LIMIT 25
   ) SELECT (SELECT COALESCE(jsonb_agg(t ORDER BY t.confirmed_at DESC,t.mint DESC),'[]') FROM token_page t) AS tokens,
    (SELECT COALESCE(jsonb_agg(p ORDER BY p.recipient),'[]') FROM profile_page p) AS profiles,
    (SELECT count(*)::integer FROM filtered) AS tokens_count,(SELECT count(*)::integer FROM grouped) AS profiles_count,
    (SELECT COALESCE(sum(recipient_sent::numeric),0)::text FROM filtered) AS recipient_sent,
    (SELECT COALESCE(sum(buyback_sent::numeric),0)::text FROM filtered) AS buyback_sent,
    (SELECT COALESCE(jsonb_agg(a ORDER BY a.fee_mint),'[]') FROM asset_totals a) AS assets,
    clock_timestamp() AS as_of`;
      const r = rows[0],
        tokens = r.tokens as any[],
        profiles = r.profiles as any[],
        page = query.view === "tokens" ? tokens : profiles,
        hasMore = page.length > 24;
      page.splice(24);
      const last = page.at(-1);
      const nextCursor = hasMore
        ? Buffer.from(
            JSON.stringify({
              scope: fingerprint(query),
              key: query.view === "tokens" ? last.mint : last.recipient,
              ...(query.view === "tokens" ? { at: last.cursor_at } : {}),
            }),
          ).toString("base64url")
        : null;
      return {
        view: query.view,
        tokens: tokens.map((t) => ({
          mint: t.mint,
          ...t.details,
          name: t.name,
          ticker: t.ticker,
          imageUrl: t.image_url,
          confirmedAt: stamp(t.confirmed_at)!,
          signature: t.launch_signature,
          profile: preview(t),
          fees: amounts(t),
        })),
        profiles: profiles.map((p) => ({
          profile: preview(p),
          tokenCount: p.token_count,
          fees: amounts(p),
        })),
        nextCursor,
        totals: {
          assets:assetAmounts(r.assets),
          tokens: r.tokens_count,
          profiles: r.profiles_count,
          recipientSent: r.recipient_sent,
          buybackSent: r.buyback_sent,
          paid: (BigInt(r.recipient_sent) + BigInt(r.buyback_sent)).toString(),
        },
        asOf: stamp(r.as_of)!,
        coverage: "confirmed-fub-payouts",
      };
    },
  };
}
