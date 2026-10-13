-- Every sale signs a fixed nonce sequence. Keep both raw signatures durable
-- before the first send. An unresolved sale owns its EVM wallet reservation.
CREATE TABLE IF NOT EXISTS fub_cash_sales (
 id uuid PRIMARY KEY,
 wallet text NOT NULL,
 evm_wallet text NOT NULL,
 request_id text NOT NULL UNIQUE,
 simulation jsonb NOT NULL,
 gas jsonb NOT NULL,
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN('prepared','expired','submitted','settling','delayed','needs-attention','complete','refunded','reverted')),
 signed_transactions jsonb,
 hashes jsonb,
 receipt jsonb,
 fee_wei text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(simulation->'route'->'intent'->>'cashWallet'=wallet),
 CHECK(simulation->'route'->'intent'->>'wallet'=evm_wallet),
 CHECK(simulation->'route'->>'requestId'=request_id),
 CHECK(jsonb_typeof(simulation)='object' AND jsonb_typeof(gas)='object'),
 CHECK((signed_transactions IS NULL)=(hashes IS NULL)),
 CHECK(state IN('prepared','expired') OR signed_transactions IS NOT NULL),
 CHECK(state NOT IN('prepared','expired') OR signed_transactions IS NULL),
 CHECK((state IN('complete','refunded'))=(receipt IS NOT NULL)),
 CHECK(signed_transactions IS NULL OR (jsonb_typeof(signed_transactions)='array' AND jsonb_array_length(signed_transactions) BETWEEN 1 AND 2 AND jsonb_array_length(signed_transactions)=jsonb_array_length(hashes))),
 CHECK(fee_wei IS NULL OR fee_wei ~ '^(0|[1-9][0-9]{0,77})$')
);
CREATE UNIQUE INDEX IF NOT EXISTS fub_cash_sale_pending_evm ON fub_cash_sales(evm_wallet)
 WHERE state NOT IN('expired','complete','refunded','reverted');
CREATE INDEX IF NOT EXISTS fub_cash_sale_recovery ON fub_cash_sales(updated_at)
 WHERE state IN('submitted','settling','delayed','needs-attention');
