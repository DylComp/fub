-- Apply ONLY to the isolated signer's database, never the application database.
-- The website and executor roles must not have access to this database.
CREATE TABLE IF NOT EXISTS signer_copy_requests (
  attempt_id uuid PRIMARY KEY,
  wallet text NOT NULL,
  plan_id uuid NOT NULL,
  leader_signature text NOT NULL,
  permission_hash text NOT NULL CHECK (permission_hash ~ '^[0-9a-f]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  day date NOT NULL,
  reserved_cents bigint NOT NULL CHECK (reserved_cents > 0),
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','signed','uncertain')),
  signed_transaction text CHECK (length(signed_transaction) BETWEEN 1 AND 1644),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state = 'signed') = (signed_transaction IS NOT NULL)),
  UNIQUE(wallet, plan_id, leader_signature)
);
CREATE INDEX IF NOT EXISTS signer_copy_daily ON signer_copy_requests(wallet,plan_id,day);
