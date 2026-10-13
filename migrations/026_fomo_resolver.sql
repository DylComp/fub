CREATE TABLE IF NOT EXISTS fomo_resolver_control (
  id smallint PRIMARY KEY CHECK(id=1),
  heartbeat_at timestamptz,
  pause_reason text CHECK(pause_reason IN ('login_required','operator_setup','upstream_changed','rate_limited','rpc_unavailable')),
  lease_token uuid,
  lease_until timestamptz
);
INSERT INTO fomo_resolver_control(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS fomo_resolver_jobs (
  handle text PRIMARY KEY CHECK(handle ~ '^[a-z0-9_][a-z0-9_.-]{0,39}$'),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','working','ready','unresolved','missing','conflict')),
  profile_id text,
  matched_address text,
  profile jsonb,
  evidence jsonb,
  lease_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS fomo_resolver_due ON fomo_resolver_jobs(next_at) WHERE state IN ('pending','working');
CREATE TABLE IF NOT EXISTS fomo_resolver_attempts (
  id uuid PRIMARY KEY,
  handle text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS fomo_resolver_attempt_time ON fomo_resolver_attempts(started_at);
