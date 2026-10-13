CREATE TABLE IF NOT EXISTS fomo_whop_events (
  environment text NOT NULL CHECK (environment IN ('production','sandbox')),
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 128),
  account_id text NOT NULL CHECK (length(account_id) BETWEEN 1 AND 128),
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 80),
  resource_id text NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 128),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (environment,event_id)
);
CREATE INDEX IF NOT EXISTS fomo_whop_events_account ON fomo_whop_events(environment,account_id,received_at DESC);
