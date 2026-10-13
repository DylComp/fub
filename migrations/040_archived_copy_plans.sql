-- Preserve archived plans and receipts while allowing a separately authorized
-- replacement. At most one non-archived plan may follow a leader per wallet.
CREATE UNIQUE INDEX IF NOT EXISTS fomo_copy_one_current_leader
  ON fomo_copy_plans(wallet,leader) WHERE NOT archived;
ALTER TABLE fomo_copy_plans DROP CONSTRAINT IF EXISTS fomo_copy_plans_wallet_leader_key;
