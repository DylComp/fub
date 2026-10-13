-- Private signer database only. Never apply to the public application database.
CREATE TABLE IF NOT EXISTS signer_direct_exits (
  id uuid PRIMARY KEY,
  wallet text NOT NULL,
  mint text NOT NULL,
  user_id text NOT NULL,
  terms jsonb NOT NULL,
  terms_hash text NOT NULL,
  signature text NOT NULL,
  state text NOT NULL DEFAULT 'watching' CHECK (state IN ('watching','signing','signed','submitted','confirmed','failed','cancelled','expired','uncertain')),
  revision integer NOT NULL DEFAULT 0,
  high_raw numeric(20,0),
  observed_slot bigint NOT NULL DEFAULT 0,
  observed_at bigint NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  attempt_id uuid UNIQUE,
  leg text CHECK (leg IN ('target','stop','trailing')),
  review jsonb,
  signed_transaction text,
  transaction_signature text UNIQUE,
  outcome jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX IF NOT EXISTS signer_direct_exit_position ON signer_direct_exits(wallet,mint)
  WHERE state IN ('watching','signing','signed','submitted','uncertain');
CREATE INDEX IF NOT EXISTS signer_direct_exit_pending ON signer_direct_exits(updated_at)
  WHERE state IN ('watching','signing','signed','submitted','uncertain');
