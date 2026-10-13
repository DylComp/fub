CREATE TABLE IF NOT EXISTS fomo_launch_fee_snapshots (
 mint text PRIMARY KEY REFERENCES fomo_launch_payouts(mint),
 available_lamports numeric(20,0) NOT NULL CHECK(available_lamports>=0),
 slot bigint NOT NULL CHECK(slot>0),
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS fomo_launch_fee_checks (
 mint text PRIMARY KEY REFERENCES fomo_launch_payouts(mint),
 lease_id uuid,
 lease_until timestamptz,
 next_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_error_at timestamptz
);
CREATE INDEX IF NOT EXISTS fomo_launch_fee_checks_due ON fomo_launch_fee_checks(next_at);
CREATE INDEX IF NOT EXISTS fomo_launch_directory_confirmed ON fomo_launch_executions(updated_at DESC,mint DESC) WHERE state='confirmed';
CREATE INDEX IF NOT EXISTS fomo_launch_payout_confirmed_totals ON fomo_launch_payout_attempts(mint,slot) WHERE state='confirmed';
-- Aggregate payouts before joining tokens, preventing join fan-out from multiplying money.
CREATE OR REPLACE VIEW fomo_public_launches AS
WITH payouts AS (
 SELECT mint,sum(recipient_lamports)::text AS recipient_sent,sum(buyback_lamports)::text AS buyback_sent,
   max(slot) AS last_paid_slot,count(*)::integer AS payouts
 FROM fomo_launch_payout_attempts WHERE state='confirmed' GROUP BY mint
)
SELECT e.mint,e.plan->'publication'->'draft'->>'name' AS name,
 e.plan->'publication'->'draft'->>'ticker' AS ticker,
 e.plan->'publication'->'draft'->>'handle' AS handle,
 e.plan->'publication'->>'imageUrl' AS image_url,
 e.signature AS launch_signature,e.updated_at AS confirmed_at,
 r.recipient,r.buyback_wallet,
 COALESCE(p.recipient_sent,'0') AS recipient_sent,COALESCE(p.buyback_sent,'0') AS buyback_sent,
 COALESCE(p.payouts,0) AS payout_count,
 CASE WHEN s.slot>=COALESCE(p.last_paid_slot,0) AND s.observed_at>clock_timestamp()-interval '120 seconds'
  THEN s.available_lamports::text ELSE NULL END AS pending_fees,
 s.observed_at AS fee_checked_at,
 j.profile
FROM fomo_launch_executions e
JOIN fomo_launch_payouts r ON r.mint=e.mint AND r.recipient=e.plan->'publication'->>'recipient' AND r.buyback_wallet=e.plan->>'buybackWallet'
LEFT JOIN payouts p ON p.mint=e.mint
LEFT JOIN fomo_launch_fee_snapshots s ON s.mint=e.mint
LEFT JOIN fomo_resolver_jobs j ON j.handle=e.plan->'publication'->'draft'->>'handle'
 AND j.matched_address=r.recipient AND j.state='ready' AND j.profile->>'address'=r.recipient AND j.profile->>'handle'=j.handle
WHERE e.state='confirmed' AND e.receipt IS NOT NULL;
