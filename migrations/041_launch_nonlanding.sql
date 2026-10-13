-- Preserve signed expired attempts and the complete-chain nonlanding proof.
ALTER TABLE fomo_launch_executions ADD COLUMN IF NOT EXISTS nonlanding_proof jsonb;
ALTER TABLE fomo_launch_executions DROP CONSTRAINT IF EXISTS fomo_launch_execution_unsigned_state;
ALTER TABLE fomo_launch_executions ADD CONSTRAINT fomo_launch_execution_unsigned_state CHECK(
 (state='prepared' AND signature IS NULL) OR
 (state='superseded' AND (signature IS NULL OR nonlanding_proof IS NOT NULL)) OR
 (state NOT IN('prepared','superseded') AND signature IS NOT NULL)
);
ALTER TABLE fomo_launch_executions DROP CONSTRAINT IF EXISTS fomo_launch_execution_nonlanding;
ALTER TABLE fomo_launch_executions ADD CONSTRAINT fomo_launch_execution_nonlanding CHECK(
 nonlanding_proof IS NULL OR (state IN('expired_unresolved','superseded') AND signature IS NOT NULL AND receipt IS NULL AND nonlanding_proof->>'signature'=signature)
);
