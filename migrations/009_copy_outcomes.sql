ALTER TABLE fomo_copy_attempts DROP CONSTRAINT IF EXISTS fomo_copy_attempts_state_check;
ALTER TABLE fomo_copy_attempts ADD CONSTRAINT fomo_copy_attempts_state_check CHECK(state IN ('reserved','submitting','unknown','confirmed','released','skipped','failed'));
