-- One durable send claim per exact journaled transaction. No execution activation.
CREATE TABLE IF NOT EXISTS fomo_token22_submissions (
  execution_id uuid PRIMARY KEY,
  wallet text NOT NULL,
  claim_id uuid NOT NULL UNIQUE,
  signature text NOT NULL UNIQUE,
  review_hash text NOT NULL CHECK(review_hash ~ '^[a-f0-9]{64}$'),
  preflight_slot bigint NOT NULL CHECK(preflight_slot>0),
  block_height bigint NOT NULL CHECK(block_height>0),
  checked_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'claimed' CHECK(state IN('claimed','accepted','uncertain')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  FOREIGN KEY(execution_id,wallet) REFERENCES fomo_token22_executions(id,wallet),
  CHECK((state='claimed')=(finished_at IS NULL))
);
CREATE INDEX IF NOT EXISTS fomo_token22_plan_history ON fomo_token22_reservations(plan_id,created_at DESC,execution_id DESC);
