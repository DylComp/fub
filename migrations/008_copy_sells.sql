ALTER TABLE fomo_copy_attempts ADD COLUMN IF NOT EXISTS side text NOT NULL DEFAULT 'buy' CHECK(side IN ('buy','sell'));
ALTER TABLE fomo_copy_attempts DROP CONSTRAINT IF EXISTS fomo_copy_attempts_reserved_cents_check;
ALTER TABLE fomo_copy_attempts DROP CONSTRAINT IF EXISTS fomo_copy_attempt_amount;
ALTER TABLE fomo_copy_attempts ADD CONSTRAINT fomo_copy_attempt_amount CHECK((side='buy' AND reserved_cents>0) OR (side='sell' AND reserved_cents=0));
CREATE TABLE IF NOT EXISTS fomo_copy_proceeds (
  plan_id uuid PRIMARY KEY REFERENCES fomo_copy_plans(id),
  usdc_raw numeric(30,0) NOT NULL DEFAULT 0 CHECK(usdc_raw>=0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fomo_copy_attempt_history ON fomo_copy_attempts(plan_id,(state IN ('reserved','submitting','unknown')) DESC,updated_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS fomo_copy_settled_inventory ON fomo_copy_attempts(wallet,mint) WHERE state='confirmed';
