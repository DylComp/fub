-- Cross-chain copy admission remains off until observer and delegated signer
-- acceptance. One CAS document serializes limits, positions and jobs per plan.
CREATE TABLE IF NOT EXISTS fub_cash_copy_journals (
 plan_id uuid PRIMARY KEY,
 wallet text NOT NULL,
 revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
 journal jsonb NOT NULL CHECK (jsonb_typeof(journal) = 'object'),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS fub_cash_copy_journals_wallet ON fub_cash_copy_journals(wallet);
