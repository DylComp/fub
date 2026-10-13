-- Only newly opted-in sign-before-return requests may use this recovery proof.
-- Existing rows remain conservative. Late signatures are retained for audit.
ALTER TABLE signer_copy_requests ADD COLUMN IF NOT EXISTS unsigned_recovery boolean NOT NULL DEFAULT false,
 ADD COLUMN IF NOT EXISTS unsigned_expired_at timestamptz CHECK(unsigned_expired_at IS NULL OR (unsigned_recovery AND unsigned_expired_at>=expires_at));
ALTER TABLE signer_copy_inventory ADD COLUMN IF NOT EXISTS unsigned_recovery boolean NOT NULL DEFAULT false,
 ADD COLUMN IF NOT EXISTS unsigned_expired_at timestamptz CHECK(unsigned_expired_at IS NULL OR (unsigned_recovery AND unsigned_expired_at>=expires_at AND settlement='pending' AND credited_raw=0 AND corrected_raw=0));
ALTER TABLE signer_native_requests ADD COLUMN IF NOT EXISTS unsigned_recovery boolean NOT NULL DEFAULT false,
 ADD COLUMN IF NOT EXISTS unsigned_expired_at timestamptz CHECK(unsigned_expired_at IS NULL OR (unsigned_recovery AND unsigned_expired_at>=expires_at AND settlement='pending' AND credited_raw=0 AND corrected_raw=0 AND actual_lamports IS NULL));
CREATE INDEX IF NOT EXISTS signer_unsigned_copy_due ON signer_copy_requests(expires_at) WHERE unsigned_recovery AND unsigned_expired_at IS NULL AND signed_transaction IS NULL;
CREATE INDEX IF NOT EXISTS signer_unsigned_inventory_due ON signer_copy_inventory(expires_at) WHERE unsigned_recovery AND unsigned_expired_at IS NULL AND signed_transaction IS NULL;
CREATE INDEX IF NOT EXISTS signer_unsigned_native_due ON signer_native_requests(expires_at) WHERE unsigned_recovery AND unsigned_expired_at IS NULL AND signed_transaction IS NULL;
