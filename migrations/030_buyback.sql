CREATE TABLE IF NOT EXISTS fomo_buyback_treasuries (
 treasury text PRIMARY KEY,
 policy_id text NOT NULL CHECK(policy_id ~ '^[a-f0-9]{64}$'),
 policy jsonb NOT NULL,
 enabled boolean NOT NULL DEFAULT false,
 lease_id uuid,
 lease_until timestamptz,
 next_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_checked_at timestamptz,
 outcome text NOT NULL DEFAULT 'paused'
);
CREATE TABLE IF NOT EXISTS fomo_buyback_attempts (
 id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'),
 treasury text NOT NULL REFERENCES fomo_buyback_treasuries(treasury),
 plan jsonb NOT NULL,
 signature text NOT NULL UNIQUE,
 signed_transaction text NOT NULL CHECK(length(signed_transaction)<=1644),
 reserved_lamports numeric(20,0) NOT NULL CHECK(reserved_lamports>0),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','confirmed','failed')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finalized_at timestamptz,
 receipt jsonb,
 debit_lamports numeric(20,0),
 burned_tokens numeric(20,0),
 CHECK((state='pending' AND receipt IS NULL AND debit_lamports IS NULL AND burned_tokens IS NULL AND finalized_at IS NULL) OR
  (state<>'pending' AND receipt IS NOT NULL AND debit_lamports IS NOT NULL AND burned_tokens IS NOT NULL AND finalized_at IS NOT NULL AND debit_lamports>=0 AND debit_lamports<=reserved_lamports AND burned_tokens>=0)),
 CHECK(state<>'failed' OR burned_tokens=0)
);
CREATE UNIQUE INDEX IF NOT EXISTS fomo_buyback_one_pending ON fomo_buyback_attempts(treasury) WHERE state='pending';
CREATE INDEX IF NOT EXISTS fomo_buyback_accounting ON fomo_buyback_attempts(treasury,created_at,finalized_at);
CREATE INDEX IF NOT EXISTS fomo_payout_treasury ON fomo_launch_payouts(buyback_wallet);
