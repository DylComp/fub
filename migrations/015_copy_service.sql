-- An observer lease suppresses the minute monitor only while it is renewed.
-- Recovery and public manual reads retain their own locks and provider budget.
CREATE TABLE IF NOT EXISTS fomo_copy_service (
  name text PRIMARY KEY CHECK(name='observer'),
  lease_id uuid,
  lease_until timestamptz,
  last_started_at timestamptz,
  last_heartbeat_at timestamptz,
  last_finished_at timestamptz,
  outcome text NOT NULL DEFAULT 'idle' CHECK(outcome IN('idle','ready','busy','retry','gap','catching_up','expired','unknown','confirmed','failed','stopped')),
  CHECK((lease_id IS NULL)=(lease_until IS NULL))
);
