-- Receipt-backed quote conversion. No public activation and no wallet-balance credits.
CREATE TABLE IF NOT EXISTS fomo_quote_conversion_policies (
 treasury text PRIMARY KEY,
 policy_id text NOT NULL CHECK(policy_id ~ '^[a-f0-9]{64}$'),
 policy jsonb NOT NULL,
 enabled boolean NOT NULL DEFAULT false,
 lease_id uuid,
 lease_until timestamptz,
 next_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_checked_at timestamptz,
 last_asset text,
 outcome text NOT NULL DEFAULT 'paused'
);
CREATE TABLE IF NOT EXISTS fomo_quote_conversion_attempts (
 id uuid PRIMARY KEY,
 treasury text NOT NULL REFERENCES fomo_quote_conversion_policies(treasury),
 quote_mint text NOT NULL,
 token_program text NOT NULL,
 decimals integer NOT NULL CHECK(decimals BETWEEN 0 AND 18),
 input_raw numeric(20,0) NOT NULL CHECK(input_raw>0 AND input_raw<=18446744073709551615),
 plan jsonb NOT NULL,
 signed_transaction text NOT NULL CHECK(length(signed_transaction)<=1644),
 signature text NOT NULL UNIQUE,
 reserved_lamports numeric(20,0) NOT NULL CHECK(reserved_lamports>0),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','confirmed','failed')),
 receipt jsonb,
 fee_lamports numeric(20,0),
 rent_lamports numeric(20,0),
 net_sol_lamports numeric(20,0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finalized_at timestamptz,
 CHECK((state='pending' AND receipt IS NULL AND fee_lamports IS NULL AND rent_lamports IS NULL AND net_sol_lamports IS NULL AND finalized_at IS NULL)
  OR(state<>'pending' AND receipt IS NOT NULL AND fee_lamports>0 AND rent_lamports>=0 AND fee_lamports+rent_lamports<=reserved_lamports AND net_sol_lamports>=0 AND finalized_at IS NOT NULL)),
 CHECK(state<>'confirmed' OR net_sol_lamports>0),
 CHECK(state<>'failed' OR(net_sol_lamports=0 AND rent_lamports=0))
);
CREATE UNIQUE INDEX IF NOT EXISTS fomo_quote_conversion_one_pending ON fomo_quote_conversion_attempts(treasury) WHERE state='pending';
CREATE INDEX IF NOT EXISTS fomo_quote_conversion_inventory ON fomo_quote_conversion_attempts(treasury,quote_mint,token_program,decimals);
CREATE TABLE IF NOT EXISTS fomo_quote_conversion_credits (
 attempt_id uuid PRIMARY KEY REFERENCES fomo_quote_conversion_attempts(id),
 treasury text NOT NULL REFERENCES fomo_quote_conversion_policies(treasury),
 lamports numeric(20,0) NOT NULL CHECK(lamports>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Successful conversion credits are NET of gas and persistent rent. Only failed
-- gas and unresolved reservations are debits here. Never charge successful gas twice.
CREATE OR REPLACE VIEW fomo_quote_conversion_sol_accounting AS
 SELECT p.treasury,
  COALESCE((SELECT sum(c.lamports) FROM fomo_quote_conversion_credits c JOIN fomo_quote_conversion_attempts a ON a.id=c.attempt_id
   WHERE c.treasury=p.treasury AND a.treasury=c.treasury AND a.state='confirmed' AND a.net_sol_lamports=c.lamports),0) AS credits,
  COALESCE((SELECT sum(CASE WHEN a.state='pending' THEN a.reserved_lamports ELSE a.fee_lamports END)
   FROM fomo_quote_conversion_attempts a WHERE a.treasury=p.treasury AND a.state IN('pending','failed')),0) AS debits
 FROM fomo_quote_conversion_policies p;
