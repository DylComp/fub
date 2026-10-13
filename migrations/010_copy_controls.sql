CREATE TABLE IF NOT EXISTS fomo_copy_controls (
  wallet text PRIMARY KEY,
  stopped_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fomo_copy_control_events (
  wallet text NOT NULL,
  id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('pause','stop')),
  plan_id uuid,
  plan_name text,
  affected_plans integer NOT NULL CHECK(affected_plans >= 0),
  released_count integer NOT NULL CHECK(released_count >= 0),
  released_cents bigint NOT NULL CHECK(released_cents >= 0),
  pending_count integer NOT NULL CHECK(pending_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(wallet,id),
  CHECK((kind='pause' AND plan_id IS NOT NULL) OR (kind='stop' AND plan_id IS NULL))
);
CREATE INDEX IF NOT EXISTS fomo_copy_control_history ON fomo_copy_control_events(wallet,created_at DESC,id DESC);
ALTER TABLE fomo_copy_control_events ADD COLUMN IF NOT EXISTS plan_version integer;
ALTER TABLE fomo_copy_control_events DROP CONSTRAINT IF EXISTS fomo_copy_control_version;
ALTER TABLE fomo_copy_control_events ADD CONSTRAINT fomo_copy_control_version CHECK(
  (kind='pause' AND plan_version IS NOT NULL AND plan_version>0) OR (kind='stop' AND plan_version IS NULL)
);
