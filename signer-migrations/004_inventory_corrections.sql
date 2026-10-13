-- Private signer database only. Original finalized credits and receipts stay intact.
ALTER TABLE signer_copy_inventory ADD COLUMN IF NOT EXISTS corrected_raw numeric(20,0) NOT NULL DEFAULT 0 CHECK (corrected_raw>=0 AND corrected_raw<=credited_raw);
CREATE TABLE IF NOT EXISTS signer_inventory_reviews (
  id uuid PRIMARY KEY,
  wallet text NOT NULL,
  user_id text NOT NULL,
  wallet_id text NOT NULL,
  mint text NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='array'),
  positions jsonb NOT NULL CHECK (jsonb_typeof(positions)='array'),
  balance_raw numeric(20,0) NOT NULL CHECK (balance_raw>=0 AND balance_raw<=18446744073709551615),
  decimals smallint NOT NULL CHECK (decimals BETWEEN 0 AND 18),
  slot bigint NOT NULL CHECK (slot>0),
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','applied')),
  allocations jsonb,
  changes jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_at timestamptz,
  CHECK ((state='pending' AND allocations IS NULL AND changes IS NULL AND applied_at IS NULL) OR
    (state='applied' AND jsonb_typeof(allocations)='array' AND jsonb_typeof(changes)='array' AND applied_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS signer_inventory_reviews_owner ON signer_inventory_reviews(wallet,user_id,created_at);
