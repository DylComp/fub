import { neon } from "@neondatabase/serverless";
import { HIDDEN_PUBLIC_LAUNCH_MINT } from "./public-launch-visibility.js";
import { fomoAvatar } from "../src/fomo-recipient.js";
import { isMint } from "../src/assets.js";
import { validActivity, activityKinds } from "../src/activity-model.js";
import type { ActivityReport, ActivityRecord } from "../src/activity-model.js";
export async function readActivity(
  url: string,
  wallet: string | null = null,
): Promise<ActivityReport> {
  if (wallet !== null && !isMint(wallet))
    throw Error("Invalid activity wallet");
  const sql = neon(url, {
    fetchOptions: { signal: AbortSignal.timeout(8000) },
  });
  // Never select plans, signed bytes, authorization messages or provider credentials.
  // Public launches/fees are confirmed only. Private attempts are owner-scoped.
  const rows = await sql`WITH launches AS (
  SELECT 'launch:'||e.id AS id,'launch' AS kind,p.data->'draft'->>'name' AS title,p.data->'draft'->>'handle' AS handle,e.mint,e.updated_at AS at,e.state,e.signature,NULL::text AS recipient,NULL::text AS treasury,NULL::text AS burned,NULL::integer AS decimals
  FROM fomo_launch_executions e JOIN fomo_launch_publications p ON p.id=e.publication_id AND p.owner=e.owner
  WHERE (${wallet}::text IS NULL AND e.state='confirmed' AND e.mint<>${HIDDEN_PUBLIC_LAUNCH_MINT}) OR (${wallet}::text IS NOT NULL AND e.owner=${wallet}) ORDER BY e.updated_at DESC,e.id DESC LIMIT 26
 ), fees AS (
  SELECT 'fee:'||a.id AS id,'fee' AS kind,l.name AS title,l.handle,a.mint,a.finalized_at AS at,'confirmed' AS state,a.signature,a.recipient_lamports::text AS recipient,a.buyback_lamports::text AS treasury,NULL::text AS burned,NULL::integer AS decimals
  FROM fomo_launch_payout_attempts a JOIN fomo_public_launches l ON l.mint=a.mint JOIN fomo_launch_executions e ON e.mint=l.mint AND e.state='confirmed'
  WHERE (${wallet}::text IS NOT NULL OR a.mint<>${HIDDEN_PUBLIC_LAUNCH_MINT}) AND a.state='confirmed' AND NOT EXISTS(SELECT 1 FROM fomo_launch_payouts p WHERE p.mint=a.mint AND p.route_kind='official') AND (${wallet}::text IS NULL OR e.owner=${wallet} OR l.recipient=${wallet}) ORDER BY a.finalized_at DESC,a.id DESC LIMIT 26
 ), official_fees AS (
  SELECT 'fee:'||a.id AS id,'fee' AS kind,'Official Fub creator fees' AS title,NULL::text AS handle,a.mint,a.finalized_at AS at,'confirmed' AS state,a.signature,a.recipient_lamports::text AS recipient,a.buyback_lamports::text AS treasury,NULL::text AS burned,NULL::integer AS decimals
  FROM fomo_launch_payout_attempts a JOIN fomo_launch_payouts p ON p.mint=a.mint
  JOIN fomo_buyback_treasuries t ON t.treasury=p.buyback_wallet AND t.policy->>'mint'=p.mint
  WHERE (${wallet}::text IS NOT NULL OR a.mint<>${HIDDEN_PUBLIC_LAUNCH_MINT}) AND p.route_kind='official' AND a.state='confirmed' AND (${wallet}::text IS NULL OR p.recipient=${wallet})
  ORDER BY a.finalized_at DESC,a.id DESC LIMIT 26
 ), burns AS (
  SELECT 'burn:'||a.id AS id,'burn' AS kind,'Fub token buy and burn' AS title,NULL::text AS handle,t.policy->>'mint' AS mint,a.finalized_at AS at,'confirmed' AS state,a.signature,NULL::text AS recipient,a.debit_lamports::text AS treasury,a.burned_tokens::text AS burned,(a.plan->>'decimals')::integer AS decimals
  FROM fomo_buyback_attempts a JOIN fomo_buyback_treasuries t ON t.treasury=a.treasury
  WHERE ${wallet}::text IS NULL AND t.policy->>'mint'<>${HIDDEN_PUBLIC_LAUNCH_MINT} AND COALESCE(a.plan->'policy'->>'purpose','')<>'engineering' AND a.state='confirmed' AND a.receipt->>'success'='true' AND a.burned_tokens>0 AND a.burned_tokens::text=a.plan->>'tokens' AND a.plan->'policy'->>'mint'=t.policy->>'mint'
  ORDER BY a.finalized_at DESC,a.id DESC LIMIT 26
 ), copies AS (
  SELECT * FROM (
   SELECT 'copy:'||a.id AS id,'copy' AS kind,CASE WHEN a.side='sell' THEN 'Copied sell' ELSE 'Copied buy' END AS title,NULL::text AS handle,a.mint,a.updated_at AS at,a.state,a.signature,NULL::text AS recipient,NULL::text AS treasury,NULL::text AS burned,NULL::integer AS decimals
   FROM fomo_copy_attempts a JOIN fomo_copy_plans p ON p.id=a.plan_id AND p.wallet=a.wallet WHERE a.wallet=${wallet}
   UNION ALL
   SELECT 'native:'||e.id,'copy',CASE WHEN r.side='sell' THEN 'Copied sell' ELSE 'Copied buy' END,NULL::text,r.mint,e.updated_at,e.state,e.signature,NULL::text,NULL::text,NULL::text,NULL::integer
   FROM fomo_token22_executions e JOIN fomo_token22_reservations r ON r.execution_id=e.id AND r.wallet=e.wallet JOIN fomo_copy_plans p ON p.id=r.plan_id AND p.wallet=e.wallet
   WHERE e.wallet=${wallet}
  ) c ORDER BY at DESC,id DESC LIMIT 26
 ) SELECT events.*, l.image_url AS "imageUrl",
 CASE WHEN l.profile->>'handle'=l.handle AND l.profile->>'address'=l.recipient THEN l.profile->>'avatarUrl' END AS "recipientAvatarUrl"
 FROM (SELECT *,NULL::text AS "feeSource" FROM launches UNION ALL SELECT *,'launchpad'::text FROM fees UNION ALL SELECT *,'official'::text FROM official_fees UNION ALL SELECT *,NULL::text FROM burns UNION ALL SELECT *,NULL::text FROM copies) events LEFT JOIN fomo_public_launches l ON events.kind='launch' AND l.mint=events.mint`;
  const more = activityKinds.filter(
      (k) => rows.filter((r) => r.kind === k).length > 25,
    ),
    records = activityKinds.flatMap((k) =>
      rows
        .filter((r) => r.kind === k)
        .sort((a,b)=>new Date(b.at).getTime()-new Date(a.at).getTime()||b.id.localeCompare(a.id))
        .slice(0, 25)
        .map((r) => ({ ...r, recipientAvatarUrl: fomoAvatar(r.recipientAvatarUrl), at: new Date(r.at).toISOString() })),
    ) as ActivityRecord[];
  const report = { wallet, records, more, checkedAt: Date.now() };
  if (!validActivity(report, wallet))
    throw Error("Activity record validation failed");
  return report;
}
