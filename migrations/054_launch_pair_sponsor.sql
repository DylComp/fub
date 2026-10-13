-- A separate sponsor pays infrastructure rent, never a user's launch or trade.
-- Timestamp the first saved signature so concurrent setups share one UTC budget.
ALTER TABLE fomo_launch_pair_tables ADD COLUMN IF NOT EXISTS signed_at timestamptz;
UPDATE fomo_launch_pair_tables SET signed_at=created_at WHERE signature IS NOT NULL AND signed_at IS NULL;
CREATE INDEX IF NOT EXISTS fomo_launch_pair_sponsor_budget_idx
 ON fomo_launch_pair_tables ((plan->>'owner'),signed_at) WHERE signature IS NOT NULL;
