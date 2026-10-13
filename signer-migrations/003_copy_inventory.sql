-- Isolated signer database only. No application role may write this ledger.
CREATE TABLE IF NOT EXISTS signer_copy_inventory (
  attempt_id uuid PRIMARY KEY,
  wallet text NOT NULL,
  plan_id uuid NOT NULL,
  mint text NOT NULL,
  side text NOT NULL CHECK (side IN ('buy','sell')),
  leader_signature text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  evidence jsonb NOT NULL,
  decimals smallint NOT NULL CHECK (decimals BETWEEN 0 AND 18),
  input_raw numeric(20,0) NOT NULL CHECK (input_raw > 0 AND input_raw <= 18446744073709551615),
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','signed','uncertain')),
  signed_transaction text CHECK (length(signed_transaction) BETWEEN 1 AND 1644),
  signature text UNIQUE,
  settlement text NOT NULL DEFAULT 'pending' CHECK (settlement IN ('pending','succeeded','failed')),
  credited_raw numeric(20,0) NOT NULL DEFAULT 0 CHECK (credited_raw >= 0 AND credited_raw <= 18446744073709551615),
  settled_slot bigint CHECK (settled_slot > 0),
  receipt jsonb,
  next_check_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(wallet,plan_id,leader_signature),
  CHECK ((state='signed' AND signed_transaction IS NOT NULL AND signature IS NOT NULL) OR (state<>'signed' AND signed_transaction IS NULL AND signature IS NULL)),
  CHECK (credited_raw=0 OR (side='buy' AND settlement='succeeded')),
  CHECK ((settlement='pending' AND receipt IS NULL AND settled_slot IS NULL) OR (settlement<>'pending' AND state='signed' AND receipt IS NOT NULL AND settled_slot IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS signer_inventory_position ON signer_copy_inventory(wallet,mint,plan_id);
CREATE INDEX IF NOT EXISTS signer_inventory_recovery ON signer_copy_inventory(next_check_at) WHERE state='signed' AND settlement='pending';
