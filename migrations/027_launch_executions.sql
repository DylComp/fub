CREATE TABLE IF NOT EXISTS fomo_launch_executions (
 id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'),
 publication_id text NOT NULL UNIQUE REFERENCES fomo_launch_publications(id),
 owner text NOT NULL,
 mint text NOT NULL UNIQUE,
 plan jsonb NOT NULL,
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','pending','expired_unresolved','confirmed','failed')),
 signed_transaction text,
 signature text UNIQUE,
 receipt jsonb,
 lease_token uuid,
 lease_until timestamptz,
 submitted_at timestamptz,
 checked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((signed_transaction IS NULL)=(signature IS NULL)),
 CHECK(state='prepared' OR signature IS NOT NULL),
 CHECK((state='confirmed')=(receipt IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS fomo_launch_execution_recovery ON fomo_launch_executions(checked_at) WHERE state IN('pending','expired_unresolved');
