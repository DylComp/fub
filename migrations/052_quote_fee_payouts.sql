-- Quote tokens remain separate from all SOL budgets and revenue columns.
CREATE TABLE IF NOT EXISTS fomo_quote_fee_routes (
 mint text PRIMARY KEY,
 recipient text NOT NULL,
 buyback_wallet text NOT NULL,
 quote_mint text NOT NULL,
 token_program text NOT NULL,
 decimals integer NOT NULL CHECK(decimals BETWEEN 0 AND 18),
 enabled boolean NOT NULL DEFAULT false,
 next_run_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 lease_id uuid,
 lease_until timestamptz,
 last_checked_at timestamptz,
 last_paid_at timestamptz,
 outcome text,
 failures integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(mint<>quote_mint AND recipient<>buyback_wallet)
);
CREATE TABLE IF NOT EXISTS fomo_quote_fee_attempts (
 id uuid PRIMARY KEY,
 mint text NOT NULL REFERENCES fomo_quote_fee_routes(mint),
 payer text NOT NULL,
 signature text NOT NULL UNIQUE,
 plan jsonb NOT NULL,
 signed_transaction text NOT NULL,
 reserved_fee_lamports bigint NOT NULL CHECK(reserved_fee_lamports>0),
 budget_day date NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC')::date,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','confirmed','failed')),
 receipt jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finalized_at timestamptz,
 CHECK((state='confirmed')=(receipt IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS fomo_quote_fee_one_pending ON fomo_quote_fee_attempts(mint) WHERE state='pending';
CREATE INDEX IF NOT EXISTS fomo_quote_fee_due ON fomo_quote_fee_routes(next_run_at);
CREATE INDEX IF NOT EXISTS fomo_quote_fee_budget ON fomo_quote_fee_attempts(payer,budget_day);
-- One credit per finalized distribution, denominated in the actual quote asset.
-- Only this 20% credit is eligible for later conversion, never the wallet balance.
CREATE TABLE IF NOT EXISTS fomo_quote_treasury_credits (
 attempt_id uuid PRIMARY KEY REFERENCES fomo_quote_fee_attempts(id),
 source_mint text NOT NULL REFERENCES fomo_quote_fee_routes(mint),
 treasury text NOT NULL,
 quote_mint text NOT NULL,
 token_program text NOT NULL,
 decimals integer NOT NULL CHECK(decimals BETWEEN 0 AND 18),
 raw_amount numeric(20,0) NOT NULL CHECK(raw_amount>0 AND raw_amount<=18446744073709551615),
 signature text NOT NULL UNIQUE,
 slot bigint NOT NULL CHECK(slot>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
