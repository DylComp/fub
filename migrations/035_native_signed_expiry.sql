-- A verified expiry retains signed bytes and its unique transaction identity.
ALTER TABLE fomo_token22_executions ADD COLUMN IF NOT EXISTS signed_expiry jsonb
 CHECK(signed_expiry IS NULL OR (state='signed' AND signature IS NOT NULL
 AND signed_expiry->>'status'='signed-expired' AND signed_expiry->>'executionId'=id::text
 AND signed_expiry->>'wallet'=wallet AND signed_expiry->>'reviewHash'=review_hash
 AND signed_expiry->>'claimId'=signing_claim::text AND signed_expiry->>'signature'=signature) IS TRUE);

ALTER TABLE fomo_token22_executions ADD COLUMN IF NOT EXISTS handoff_next_check_at timestamptz NOT NULL DEFAULT clock_timestamp();
