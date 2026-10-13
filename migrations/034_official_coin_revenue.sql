-- Existing launchpad destinations remain unchanged. Official coins use a separate
-- explicit policy: recipient=development (20%), buyback_wallet=treasury (80%).
ALTER TABLE fomo_launch_payouts ADD COLUMN IF NOT EXISTS route_kind text NOT NULL DEFAULT 'launchpad' CHECK(route_kind IN ('launchpad','official'));
CREATE UNIQUE INDEX IF NOT EXISTS fomo_single_official_payout ON fomo_launch_payouts(route_kind) WHERE route_kind='official';
