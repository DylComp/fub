CREATE TABLE IF NOT EXISTS fomo_buyback_setup_attempts (
  signature text PRIMARY KEY,
  review jsonb NOT NULL,
  signed_transaction text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','confirmed','failed','unlanded')),
  debit_lamports numeric(20,0) NOT NULL DEFAULT 0 CHECK (debit_lamports >= 0),
  receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finalized_at timestamptz
);
