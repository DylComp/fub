CREATE TABLE IF NOT EXISTS signer_cash_limits (
 id uuid PRIMARY KEY,
 wallet text NOT NULL,
 user_id text NOT NULL,
 document jsonb NOT NULL,
 revision bigint NOT NULL DEFAULT 0,
 next_delivery_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 next_check_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (document->'terms'->>'id'=id::text),
 CHECK (document->'terms'->>'sourceWallet'=wallet),
 CHECK (document->'grant'->'solana'->>'userId'=user_id)
);
CREATE INDEX IF NOT EXISTS signer_cash_limits_owner ON signer_cash_limits(wallet,user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS signer_cash_limits_due ON signer_cash_limits(next_check_at) WHERE document->>'state' IN ('waiting','preparing','signing','submitted','needs-attention');

REVOKE ALL ON signer_cash_limits FROM PUBLIC;
CREATE INDEX IF NOT EXISTS signer_cash_limits_delivery ON signer_cash_limits(next_delivery_at) WHERE document ? 'signed';
