-- Private signer database only. Native SOL uses its own owner-signed limits.
CREATE TABLE IF NOT EXISTS signer_native_requests (
 execution_id uuid PRIMARY KEY,
 wallet text NOT NULL,
 plan_id uuid NOT NULL,
 leader_signature text NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 permission_hash text NOT NULL CHECK(permission_hash ~ '^[a-f0-9]{64}$'),
 day date NOT NULL,
 reserved_lamports bigint NOT NULL CHECK(reserved_lamports>0 AND reserved_lamports<=15050000),
 evidence jsonb NOT NULL,
 expires_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'requested' CHECK(state IN('requested','signed','uncertain')),
 signed_transaction text CHECK(length(signed_transaction) BETWEEN 1 AND 1644),
 signature text UNIQUE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(wallet,plan_id,leader_signature),
 CHECK((state='signed' AND signed_transaction IS NOT NULL AND signature IS NOT NULL) OR
       (state<>'signed' AND signed_transaction IS NULL AND signature IS NULL))
);
CREATE INDEX IF NOT EXISTS signer_native_daily ON signer_native_requests(wallet,plan_id,day);
