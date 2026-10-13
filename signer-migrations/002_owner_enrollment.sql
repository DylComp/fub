-- Isolated signer database ONLY. Application/executor roles must have no access.
CREATE TABLE IF NOT EXISTS signer_wallet_epochs (
  wallet text PRIMARY KEY,
  epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0)
);
CREATE TABLE IF NOT EXISTS signer_enrollments (
  id uuid PRIMARY KEY,
  wallet text NOT NULL REFERENCES signer_wallet_epochs(wallet),
  user_id text NOT NULL,
  wallet_id text NOT NULL,
  epoch bigint NOT NULL,
  challenge jsonb NOT NULL,
  challenge_expires_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','active','revoked')),
  signature text,
  activated_at timestamptz,
  stopped_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (state <> 'active' OR (signature IS NOT NULL AND activated_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS signer_one_active_wallet ON signer_enrollments(wallet) WHERE state='active';
CREATE UNIQUE INDEX IF NOT EXISTS signer_one_active_provider_wallet ON signer_enrollments(wallet_id) WHERE state='active';
CREATE INDEX IF NOT EXISTS signer_enrollment_owner ON signer_enrollments(wallet,user_id);
