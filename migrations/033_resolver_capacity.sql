-- Persist the active worker budget so every API instance uses the same limit.
ALTER TABLE fomo_resolver_control ADD COLUMN IF NOT EXISTS daily_cap smallint NOT NULL DEFAULT 100 CHECK(daily_cap BETWEEN 1 AND 500);
