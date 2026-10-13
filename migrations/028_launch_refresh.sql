-- Preserve expired unsigned attempts instead of deleting launch history.
ALTER TABLE fomo_launch_executions DROP CONSTRAINT IF EXISTS fomo_launch_executions_publication_id_key;
ALTER TABLE fomo_launch_executions DROP CONSTRAINT IF EXISTS fomo_launch_executions_mint_key;
ALTER TABLE fomo_launch_executions DROP CONSTRAINT IF EXISTS fomo_launch_executions_state_check;
ALTER TABLE fomo_launch_executions ADD CONSTRAINT fomo_launch_executions_state_check CHECK(state IN('prepared','pending','expired_unresolved','confirmed','failed','superseded'));
ALTER TABLE fomo_launch_executions DROP CONSTRAINT IF EXISTS fomo_launch_executions_check1;
ALTER TABLE fomo_launch_executions DROP CONSTRAINT IF EXISTS fomo_launch_execution_unsigned_state;
ALTER TABLE fomo_launch_executions ADD COLUMN IF NOT EXISTS nonlanding_proof jsonb;
ALTER TABLE fomo_launch_executions ADD CONSTRAINT fomo_launch_execution_unsigned_state CHECK((state='prepared' AND signature IS NULL) OR (state='superseded' AND (signature IS NULL OR nonlanding_proof IS NOT NULL)) OR (state NOT IN('prepared','superseded') AND signature IS NOT NULL));
ALTER TABLE fomo_launch_executions ADD COLUMN IF NOT EXISTS replaces_id text UNIQUE REFERENCES fomo_launch_executions(id);
ALTER TABLE fomo_launch_executions ADD COLUMN IF NOT EXISTS expiry_proof jsonb;
ALTER TABLE fomo_launch_executions DROP CONSTRAINT IF EXISTS fomo_launch_execution_refresh_proof;
ALTER TABLE fomo_launch_executions ADD CONSTRAINT fomo_launch_execution_refresh_proof CHECK((replaces_id IS NULL)=(expiry_proof IS NULL));
CREATE UNIQUE INDEX IF NOT EXISTS fomo_launch_execution_current_publication ON fomo_launch_executions(publication_id) WHERE state<>'superseded';
CREATE UNIQUE INDEX IF NOT EXISTS fomo_launch_execution_current_mint ON fomo_launch_executions(mint) WHERE state<>'superseded';
