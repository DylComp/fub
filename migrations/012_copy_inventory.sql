ALTER TABLE fomo_copy_positions ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0);
CREATE OR REPLACE VIEW fomo_copy_inventory_state AS
SELECT p.wallet,x.mint,jsonb_agg(jsonb_build_object(
  'id',p.id,'name',COALESCE(p.data->>'name',''),'version',p.version,
  'revision',x.revision::text,'raw',x.raw_amount::text,'archived',p.archived,'enabled',p.enabled
) ORDER BY p.id) AS positions
FROM fomo_copy_positions x JOIN fomo_copy_plans p ON p.id=x.plan_id
GROUP BY p.wallet,x.mint;
CREATE TABLE IF NOT EXISTS fomo_copy_inventory_reviews (
  wallet text NOT NULL,
  mint text NOT NULL,
  id uuid NOT NULL UNIQUE,
  positions jsonb NOT NULL,
  balance_raw numeric(20,0) NOT NULL CHECK (balance_raw >= 0 AND balance_raw <= 18446744073709551615),
  decimals integer NOT NULL CHECK (decimals BETWEEN 0 AND 18),
  slot bigint NOT NULL CHECK (slot > 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(wallet,mint)
);
CREATE TABLE IF NOT EXISTS fomo_copy_inventory_events (
  wallet text NOT NULL,
  id uuid NOT NULL,
  mint text NOT NULL,
  positions jsonb NOT NULL,
  allocations jsonb NOT NULL,
  balance_raw numeric(20,0) NOT NULL,
  decimals integer NOT NULL,
  slot bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(wallet,id)
);
CREATE INDEX IF NOT EXISTS fomo_copy_inventory_history ON fomo_copy_inventory_events(wallet,created_at DESC,id);
