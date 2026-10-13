-- Retain the exact private-service recovery proof when canceling an unsigned claim.
ALTER TABLE fomo_token22_executions ADD COLUMN IF NOT EXISTS unsigned_expiry jsonb
 CHECK(unsigned_expiry IS NULL OR (state='canceled' AND signature IS NULL AND signed_transaction IS NULL
 AND unsigned_expiry->>'status'='unsigned-expired' AND unsigned_expiry->>'executionId'=id::text
 AND unsigned_expiry->>'wallet'=wallet AND unsigned_expiry->>'reviewHash'=review_hash));
