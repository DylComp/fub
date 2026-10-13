CREATE TABLE IF NOT EXISTS fomo_copy_monitors (
  plan_id uuid PRIMARY KEY REFERENCES fomo_copy_plans(id),
  revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
  enabled boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_until timestamptz,
  failures integer NOT NULL DEFAULT 0,
  last_run_at timestamptz,
  last_success_at timestamptz,
  outcome text NOT NULL DEFAULT 'idle' CHECK(outcome IN ('idle','ready','retry','gap','catching_up','busy')),
  CHECK(NOT enabled OR expires_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS fomo_copy_monitor_due ON fomo_copy_monitors(next_run_at,plan_id) WHERE enabled;
ALTER TABLE fomo_copy_feed ADD COLUMN IF NOT EXISTS monitor_revision integer;
CREATE TABLE IF NOT EXISTS fomo_copy_monitor_worker (
  name text PRIMARY KEY CHECK(name='leader-activity'),
  lease_id uuid,
  lease_until timestamptz,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  outcome text NOT NULL DEFAULT 'idle'
);
