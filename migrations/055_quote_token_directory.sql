-- Keep legacy SOL fields in lamports. Quote receipts never enter SOL totals.
CREATE OR REPLACE VIEW fomo_public_launches AS
WITH quote_payouts AS (
 SELECT mint,sum((receipt->>'recipientRaw')::numeric)::text AS recipient_sent,
 sum((receipt->>'treasuryRaw')::numeric)::text AS buyback_sent,count(*)::integer AS payouts
 FROM fomo_quote_fee_attempts WHERE state='confirmed' GROUP BY mint
), routes AS (
 SELECT mint,recipient,buyback_wallet,false AS quoted FROM fomo_launch_payouts
 UNION ALL SELECT mint,recipient,buyback_wallet,true FROM fomo_quote_fee_routes
), payouts AS (
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
 j.profile,
 CASE WHEN r.quoted THEN q.quote_mint ELSE 'So11111111111111111111111111111111111111112' END AS fee_mint,
 CASE WHEN r.quoted THEN q.token_program ELSE 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' END AS fee_token_program,
 CASE WHEN r.quoted THEN q.decimals ELSE 9 END AS fee_decimals,
 CASE WHEN r.quoted THEN COALESCE(qp.recipient_sent,'0') ELSE COALESCE(p.recipient_sent,'0') END AS fee_recipient_sent,
 CASE WHEN r.quoted THEN COALESCE(qp.buyback_sent,'0') ELSE COALESCE(p.buyback_sent,'0') END AS fee_buyback_sent
FROM fomo_launch_executions e
JOIN routes r ON r.mint=e.mint AND r.recipient=e.plan->'publication'->>'recipient' AND r.buyback_wallet=e.plan->>'buybackWallet'
LEFT JOIN fomo_quote_fee_routes q ON q.mint=e.mint AND r.quoted
LEFT JOIN quote_payouts qp ON qp.mint=e.mint AND r.quoted
LEFT JOIN payouts p ON p.mint=e.mint
LEFT JOIN fomo_launch_fee_snapshots s ON s.mint=e.mint
LEFT JOIN fomo_resolver_jobs j ON j.handle=e.plan->'publication'->'draft'->>'handle'
 AND j.matched_address=r.recipient AND j.state='ready' AND j.profile->>'address'=r.recipient AND j.profile->>'handle'=j.handle
WHERE e.state='confirmed' AND e.receipt IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM fomo_launch_payouts n JOIN fomo_quote_fee_routes t USING(mint) WHERE n.mint=e.mint);
