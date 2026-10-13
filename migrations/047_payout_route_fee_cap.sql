-- Optional operator ceiling, independent of UTC rollover and other routes.
ALTER TABLE fomo_launch_payouts ADD COLUMN IF NOT EXISTS fee_budget_lamports numeric(20,0)
  CHECK(fee_budget_lamports IS NULL OR fee_budget_lamports >= 0);
