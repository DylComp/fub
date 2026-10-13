CREATE TABLE IF NOT EXISTS fomo_launch_payouts (
  mint text PRIMARY KEY,
  recipient text NOT NULL,
  buyback_wallet text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_until timestamptz,
  last_checked_at timestamptz,
  last_paid_at timestamptz,
  outcome text NOT NULL DEFAULT 'waiting',
  failures integer NOT NULL DEFAULT 0 CHECK(failures BETWEEN 0 AND 6),
  CHECK(recipient<>buyback_wallet AND mint<>recipient AND mint<>buyback_wallet)
);
CREATE TABLE IF NOT EXISTS fomo_launch_payout_attempts (
  id uuid PRIMARY KEY,
  mint text NOT NULL REFERENCES fomo_launch_payouts(mint),
  payer text NOT NULL,
  signature text NOT NULL UNIQUE,
  signed_transaction text NOT NULL CHECK(length(signed_transaction)<=1644),
  unsigned_transaction text NOT NULL CHECK(length(unsigned_transaction)<=1644),
  last_valid_block_height bigint NOT NULL CHECK(last_valid_block_height>0),
  reserved_fee_lamports bigint NOT NULL CHECK(reserved_fee_lamports>0),
  budget_day date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','confirmed','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  slot bigint,
  recipient_lamports numeric(20,0),
  buyback_lamports numeric(20,0),
  network_fee_lamports bigint,
  CHECK(state<>'confirmed' OR (slot>=0 AND recipient_lamports>=0 AND buyback_lamports>=0 AND network_fee_lamports>=0 AND finalized_at IS NOT NULL)),
  CHECK(state='confirmed' OR (recipient_lamports IS NULL AND buyback_lamports IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS fomo_launch_payout_one_pending ON fomo_launch_payout_attempts(mint) WHERE state='pending';
CREATE INDEX IF NOT EXISTS fomo_launch_payout_due ON fomo_launch_payouts(next_run_at,mint);
CREATE INDEX IF NOT EXISTS fomo_launch_payout_budget ON fomo_launch_payout_attempts(payer,budget_day);
