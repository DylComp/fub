CREATE TABLE IF NOT EXISTS fomo_copy_permissions (
  id uuid PRIMARY KEY,
  plan_id uuid NOT NULL REFERENCES fomo_copy_plans(id) ON DELETE CASCADE,
  wallet text NOT NULL,
  plan_version integer NOT NULL CHECK(plan_version > 0),
  scope jsonb NOT NULL,
  scope_hash text NOT NULL CHECK(scope_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz NOT NULL,
  accept_by timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  signature text,
  accepted_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text CHECK(revoke_reason IN ('replaced','edited','archived','paused','stopped')),
  CHECK(accept_by=issued_at+interval '5 minutes'),
  CHECK(expires_at>=issued_at+interval '10 minutes' AND expires_at<=issued_at+interval '1 day'),
  CHECK((signature IS NULL)=(accepted_at IS NULL)),
  CHECK(accepted_at IS NULL OR (accepted_at>=issued_at AND accepted_at<accept_by)),
  CHECK((revoked_at IS NULL)=(revoke_reason IS NULL)),
  CHECK(scope->>'id'=id::text AND scope->>'planId'=plan_id::text AND scope->>'wallet'=wallet),
  CHECK((scope->>'planVersion')::integer=plan_version),
  CHECK(round(extract(epoch FROM issued_at)*1000)::bigint=(scope->>'issuedAt')::bigint),
  CHECK(round(extract(epoch FROM accept_by)*1000)::bigint=(scope->>'acceptBy')::bigint),
  CHECK(round(extract(epoch FROM expires_at)*1000)::bigint=(scope->>'expiresAt')::bigint)
);
CREATE INDEX IF NOT EXISTS fomo_copy_permission_history ON fomo_copy_permissions(wallet,plan_id,issued_at DESC);

-- Every new reserve/prepare/claim reads this view in its wallet-locked statement.
-- This is application consent, not proof of delegated custody or signer access.
CREATE OR REPLACE VIEW fomo_copy_authorized_plans AS
SELECT p.*, g.id AS permission_id, g.expires_at AS permission_expires_at
FROM fomo_copy_plans p JOIN fomo_copy_permissions g ON g.plan_id=p.id AND g.wallet=p.wallet AND g.plan_version=p.version
WHERE NOT p.archived AND g.accepted_at IS NOT NULL AND g.revoked_at IS NULL
  AND g.issued_at<=statement_timestamp() AND g.expires_at>statement_timestamp()
  AND NOT EXISTS(SELECT 1 FROM fomo_copy_controls c WHERE c.wallet=p.wallet)
  AND g.scope->>'version'='1' AND g.scope->>'origin'='https://fomo-pay.vercel.app' AND g.scope->>'network'='solana:mainnet'
  AND g.scope->>'leader'=p.leader AND g.scope->>'leader'=p.data->>'address'
  AND g.scope->'buyCents'=p.data->'buyCents' AND g.scope->'dailyCents'=p.data->'dailyCents'
  AND g.scope->'slippageBps'=p.data->'slippageBps' AND g.scope->'copySells'=p.data->'copySells'
  AND g.scope->>'maxNetworkFeeLamports'='1000000' AND g.scope->>'maxRentLamports'='2500000';
