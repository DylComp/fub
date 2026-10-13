-- Record the default already enabled in production by the owner-approved
-- recurring-payout rollout. Existing routes and execution gates are unchanged.
ALTER TABLE fomo_launch_payouts ALTER COLUMN enabled SET DEFAULT true;
