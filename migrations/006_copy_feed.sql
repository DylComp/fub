CREATE TABLE IF NOT EXISTS fomo_copy_feed (
  plan_id uuid PRIMARY KEY REFERENCES fomo_copy_plans(id),
  initialized boolean NOT NULL DEFAULT false,
  start_slot bigint,
  cursor_signature text,
  staged jsonb NOT NULL DEFAULT '[]'::jsonb,
  lease_id uuid,
  lease_until timestamptz,
  next_scan_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz,
  status text NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','ready','retry','gap','catching_up')),
  message text NOT NULL DEFAULT 'No activity check yet.'
);
CREATE TABLE IF NOT EXISTS fomo_copy_feed_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  plan_id uuid NOT NULL REFERENCES fomo_copy_plans(id),
  signature text NOT NULL,
  slot bigint NOT NULL CHECK(slot >= 0),
  block_time bigint,
  failed boolean NOT NULL,
  decision jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(plan_id,signature)
);
CREATE INDEX IF NOT EXISTS fomo_copy_feed_pending ON fomo_copy_feed_events(plan_id,sequence) WHERE decision IS NULL;
CREATE INDEX IF NOT EXISTS fomo_copy_feed_recent ON fomo_copy_feed_events(plan_id,sequence DESC);
