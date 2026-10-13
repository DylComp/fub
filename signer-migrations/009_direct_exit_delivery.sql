ALTER TABLE signer_direct_exits ADD COLUMN IF NOT EXISTS trigger_observation jsonb;
ALTER TABLE signer_direct_exits ADD COLUMN IF NOT EXISTS delivery_id uuid;
ALTER TABLE signer_direct_exits ADD COLUMN IF NOT EXISTS delivery_until timestamptz;
ALTER TABLE signer_direct_exits ADD COLUMN IF NOT EXISTS next_check_at timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE INDEX IF NOT EXISTS signer_direct_exit_recovery ON signer_direct_exits(next_check_at,id)
  WHERE state IN ('signing','signed','submitted','uncertain');

ALTER TABLE signer_direct_exits ADD COLUMN IF NOT EXISTS next_observe_at timestamptz NOT NULL DEFAULT clock_timestamp();
