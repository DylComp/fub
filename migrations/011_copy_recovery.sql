CREATE TABLE IF NOT EXISTS fomo_copy_recovery_jobs (
  attempt_id uuid PRIMARY KEY REFERENCES fomo_copy_attempts(id) ON DELETE CASCADE,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_until timestamptz,
  checked_count integer NOT NULL DEFAULT 0 CHECK(checked_count >= 0),
  failures integer NOT NULL DEFAULT 0 CHECK(failures >= 0 AND failures <= 5),
  last_checked_at timestamptz,
  outcome text NOT NULL DEFAULT 'waiting' CHECK(outcome IN('waiting','busy','unknown','retry','confirmed','failed'))
);
CREATE INDEX IF NOT EXISTS fomo_copy_recovery_due ON fomo_copy_recovery_jobs(next_run_at,attempt_id);
CREATE INDEX IF NOT EXISTS fomo_copy_attempt_expiry ON fomo_copy_attempts(expires_at,id) WHERE state='reserved';
CREATE TABLE IF NOT EXISTS fomo_copy_recovery_worker (
  name text PRIMARY KEY CHECK(name='copy-recovery'),
  lease_id uuid,
  lease_until timestamptz,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  outcome text NOT NULL DEFAULT 'idle'
);
