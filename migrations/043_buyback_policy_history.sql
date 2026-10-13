CREATE TABLE IF NOT EXISTS fomo_buyback_policy_history (
  id uuid PRIMARY KEY,
  treasury text NOT NULL REFERENCES fomo_buyback_treasuries(treasury),
  previous_policy_id text NOT NULL,
  previous_policy jsonb NOT NULL,
  next_policy_id text NOT NULL,
  next_policy jsonb NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reason text NOT NULL CHECK(reason='engineering_acceptance_to_official'),
  UNIQUE(treasury,previous_policy_id,next_policy_id)
);
