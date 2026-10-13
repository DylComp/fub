-- Isolated signing database only. The web application's journal is not a
-- signing authority. Both limits and resulting signatures survive restoration.
CREATE TABLE IF NOT EXISTS signer_cash_journals (
 plan_id uuid PRIMARY KEY,
 wallet text NOT NULL,
 revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
 journal jsonb NOT NULL CHECK (jsonb_typeof(journal) = 'object'),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS signer_cash_journals_wallet ON signer_cash_journals(wallet);
-- Serialize unsettled execution across all copy plans sharing a funding wallet.
-- An uncertain signature keeps this reservation until its result is reconciled.
CREATE UNIQUE INDEX IF NOT EXISTS signer_cash_wallet_active ON signer_cash_journals(wallet)
 WHERE jsonb_path_exists(journal,'$.jobs.* ? (@.state != "complete" && @.state != "stopped")');
-- A provider user may link more than one Solana wallet to the same EVM wallet.
-- Reserve its nonce stream across those funding addresses as well.
CREATE UNIQUE INDEX IF NOT EXISTS signer_cash_evm_active ON signer_cash_journals((journal->'grant'->'scope'->>'recipient'))
 WHERE jsonb_path_exists(journal,'$.jobs.* ? (@.state != "complete" && @.state != "stopped")');
CREATE TABLE IF NOT EXISTS signer_cash_parts (
 id text PRIMARY KEY,
 digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
 state text NOT NULL DEFAULT 'claimed' CHECK (state IN ('claimed','signed')),
 signed text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((state='signed') = (signed IS NOT NULL))
);
REVOKE ALL ON signer_cash_journals,signer_cash_parts FROM PUBLIC;
