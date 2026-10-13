-- Private signer only. Leases survive restarts without resetting order state.
ALTER TABLE signer_direct_exits ADD COLUMN IF NOT EXISTS observation_claim uuid;
ALTER TABLE signer_direct_exits ADD COLUMN IF NOT EXISTS observation_until timestamptz;
ALTER TABLE signer_direct_exits DROP CONSTRAINT IF EXISTS direct_exit_observation_pair;
ALTER TABLE signer_direct_exits ADD CONSTRAINT direct_exit_observation_pair
  CHECK ((observation_claim IS NULL) = (observation_until IS NULL));
CREATE INDEX IF NOT EXISTS signer_direct_exit_observation_due
  ON signer_direct_exits(next_observe_at,id) WHERE state='watching';
