-- Internal message/outcome journal, not a copy-plan grant or spending budget.
-- SOL inputs must not be charged to the existing USDC-denominated copy ledger.
CREATE TABLE IF NOT EXISTS fomo_token22_executions (
  id uuid PRIMARY KEY,
  wallet text NOT NULL,
  message_hash text NOT NULL UNIQUE CHECK(message_hash ~ '^[0-9a-f]{64}$'),
  review_hash text NOT NULL CHECK(review_hash ~ '^[0-9a-f]{64}$'),
  review jsonb NOT NULL,
  state text NOT NULL DEFAULT 'prepared' CHECK(state IN('prepared','signing','signed','confirmed','failed','canceled')),
  signing_claim uuid,
  signature text UNIQUE,
  signed_transaction text,
  signed_at timestamptz,
  expires_at timestamptz NOT NULL,
  lease_id uuid,
  lease_until timestamptz,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  checks integer NOT NULL DEFAULT 0 CHECK(checks >= 0),
  last_outcome text NOT NULL DEFAULT 'waiting' CHECK(last_outcome IN('waiting','busy','pending','unavailable','inconsistent','confirmed','failed')),
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,wallet),
  CHECK((review->>'version'='1' AND review->'accounts'->>'wallet'=wallet AND review->>'messageHash'=message_hash) IS TRUE),
  CHECK((state IN('prepared','canceled'))=(signing_claim IS NULL)),
  CHECK((state IN('signed','confirmed','failed'))=(signed_transaction IS NOT NULL AND signature IS NOT NULL)),
  CHECK((signature IS NULL)=(signed_transaction IS NULL)),
  CHECK((state IN('signed','confirmed','failed'))=(signed_at IS NOT NULL)),
  CHECK(signed_transaction IS NULL OR length(signed_transaction) BETWEEN 100 AND 1644),
  CHECK(signature IS NULL OR signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  CHECK((lease_id IS NULL)=(lease_until IS NULL)),
  CHECK(lease_id IS NULL OR state='signed')
);
CREATE INDEX IF NOT EXISTS fomo_token22_recovery_due ON fomo_token22_executions(next_check_at,id) WHERE state='signed';
CREATE INDEX IF NOT EXISTS fomo_token22_wallet_history ON fomo_token22_executions(wallet,created_at DESC);
CREATE TABLE IF NOT EXISTS fomo_token22_outcomes (
  execution_id uuid PRIMARY KEY,
  wallet text NOT NULL,
  outcome jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(execution_id,wallet) REFERENCES fomo_token22_executions(id,wallet),
  CHECK((outcome->>'kind' IN('succeeded','failed')) IS TRUE)
);
