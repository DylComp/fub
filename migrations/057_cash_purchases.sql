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
CREATE TABLE IF NOT EXISTS fub_cash_wallet_challenges (
 nonce text PRIMARY KEY,
 wallet text NOT NULL,
 challenge jsonb NOT NULL,
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 CHECK(challenge->>'sourceWallet'=wallet),
 CHECK(challenge->>'nonce'=nonce)
);
CREATE INDEX IF NOT EXISTS fub_cash_wallet_challenge_expiry ON fub_cash_wallet_challenges(expires_at);
CREATE TABLE IF NOT EXISTS fub_cash_wallet_bindings (
 wallet text NOT NULL,
 network text NOT NULL,
 binding jsonb NOT NULL,
 PRIMARY KEY(wallet,network),
 CHECK(binding->>'sourceWallet'=wallet),
 CHECK(binding->>'network'=network)
);
