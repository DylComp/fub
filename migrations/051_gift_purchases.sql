CREATE TABLE IF NOT EXISTS fub_gift_purchases (
 id uuid PRIMARY KEY,
 wallet text NOT NULL,
 request_hash text NOT NULL,
 revision bigint NOT NULL DEFAULT 0,
 encrypted text NOT NULL,
 state text NOT NULL CHECK(state IN('creating','uncertain','ready')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 next_check_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 closed_at timestamptz,
 CHECK(length(encrypted) BETWEEN 40 AND 100000)
);
CREATE UNIQUE INDEX IF NOT EXISTS fub_gift_one_active ON fub_gift_purchases(wallet) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS fub_gift_owner_history ON fub_gift_purchases(wallet,created_at DESC);
