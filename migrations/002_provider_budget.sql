CREATE TABLE IF NOT EXISTS fomo_provider_budget (
  name text PRIMARY KEY,
  next_at timestamptz NOT NULL
);
