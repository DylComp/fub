-- Separate trading-wallet attribution from the transfer destination established
-- by the existing unsigned draft decoder. Never overwrite matched_address.
ALTER TABLE fomo_resolver_jobs ADD COLUMN IF NOT EXISTS trading_profile jsonb;
