-- Sign-only provider calls are journaled separately from network submission.
-- One attempt may request only one exact message. Uncertain calls are not retried.
CREATE TABLE IF NOT EXISTS fomo_copy_signing_requests (
  attempt_id uuid PRIMARY KEY REFERENCES fomo_copy_attempts(id) ON DELETE CASCADE,
  wallet text NOT NULL,
  message_hash text NOT NULL CHECK(message_hash ~ '^[0-9a-f]{64}$'),
  permission_hash text NOT NULL CHECK(permission_hash ~ '^[0-9a-f]{64}$'),
  request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  claim_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'requested' CHECK(state IN('requested','signed','uncertain','abandoned')),
  signed_transaction text,
  reason text CHECK(reason IN('canceled','provider_error','invalid_signature','storage_error')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((state='signed')=(signed_transaction IS NOT NULL)),
  CHECK(signed_transaction IS NULL OR (length(signed_transaction)>0 AND length(signed_transaction)<=1644)),
  CHECK((state IN('uncertain','abandoned'))=(reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS fomo_copy_signing_unresolved ON fomo_copy_signing_requests(created_at) WHERE state IN('requested','uncertain');
