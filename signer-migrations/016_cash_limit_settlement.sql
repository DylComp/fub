-- Isolated limit execution journals only. No application wallet-binding tables.
-- Cash deposits are reserved before a signing review is returned. A signed
-- attempt is never replaced, even if an RPC acknowledgement is lost.
CREATE TABLE IF NOT EXISTS fub_cash_purchases (
 id uuid PRIMARY KEY,
 wallet text NOT NULL,
 request_id text NOT NULL UNIQUE,
 order_id text NOT NULL UNIQUE,
 review jsonb NOT NULL,
 binding jsonb NOT NULL,
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN('expired','prepared','submitted','settling','delayed','needs-attention','complete','refunded','reverted')),
 signed_transaction text,
 signature text UNIQUE,
 receipt jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(jsonb_typeof(review)='object' AND jsonb_typeof(binding)='object'),
 CHECK(review->'quote'->>'sourceWallet'=wallet),
 CHECK(review->'quote'->>'requestId'=request_id),
 CHECK(review->'quote'->>'orderId'=order_id),
 CHECK(binding->>'sourceWallet'=wallet),
 CHECK((signed_transaction IS NULL)=(signature IS NULL)),
 CHECK((state IN('complete','refunded'))=(receipt IS NOT NULL)),
 CHECK(state IN('prepared','expired') OR signature IS NOT NULL),
 CHECK(state NOT IN('prepared','expired') OR signature IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS fub_cash_one_pending_per_wallet ON fub_cash_purchases(wallet)
 WHERE state NOT IN('expired','complete','refunded','reverted');
CREATE INDEX IF NOT EXISTS fub_cash_recovery ON fub_cash_purchases(updated_at)
 WHERE state IN('prepared','submitted','settling','delayed','needs-attention');
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
CREATE INDEX IF NOT EXISTS fub_cash_sale_recovery ON fub_cash_sales(updated_at)
 WHERE state IN('submitted','settling','delayed','needs-attention');
-- EVM nonces are local to a chain. A pending return on one chain must not
-- reserve the same address on every other chain. Legacy rows were Base-only.
-- Build the replacement before dropping the stricter index, in one transaction.
CREATE UNIQUE INDEX IF NOT EXISTS fub_cash_sale_pending_network_evm
 ON fub_cash_sales(lower(evm_wallet), (COALESCE(simulation->'route'->'intent'->>'network', 'base')))
 WHERE state NOT IN('expired','complete','refunded','reverted');
DROP INDEX IF EXISTS fub_cash_sale_pending_evm;

REVOKE ALL ON fub_cash_purchases,fub_cash_sales FROM PUBLIC;
