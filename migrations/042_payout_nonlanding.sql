-- Preserve expired signed packets whose complete finalized lifetime was audited.
-- A proven absent transaction spent nothing. Unknown transactions stay pending.
ALTER TABLE fomo_launch_payout_attempts ADD COLUMN IF NOT EXISTS nonlanding_proof jsonb;
ALTER TABLE fomo_launch_payout_attempts DROP CONSTRAINT IF EXISTS fomo_payout_nonlanding_state;
ALTER TABLE fomo_launch_payout_attempts ADD CONSTRAINT fomo_payout_nonlanding_state CHECK(
 nonlanding_proof IS NULL OR COALESCE((state='failed' AND network_fee_lamports=0 AND recipient_lamports IS NULL AND buyback_lamports IS NULL
 AND nonlanding_proof->>'signature'=signature AND nonlanding_proof->>'packetHash' ~ '^[a-f0-9]{64}$')
,false));
