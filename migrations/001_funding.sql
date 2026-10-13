CREATE TABLE IF NOT EXISTS fomo_funding_operations (
  id uuid PRIMARY KEY,
  wallet text NOT NULL,
  state text NOT NULL CHECK (state IN ('preparing','prepared','submitting','submitted','unknown','confirmed','failed','abandoned')),
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fomo_funding_wallet_history ON fomo_funding_operations(wallet,updated_at DESC);
-- A lost deposit response must be resolved before that wallet can deposit again.
CREATE UNIQUE INDEX IF NOT EXISTS fomo_funding_one_pending ON fomo_funding_operations(wallet)
  WHERE state IN ('preparing','prepared','submitting','unknown');
