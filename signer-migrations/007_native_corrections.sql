-- Preserve finalized trade evidence while allowing owner-authorized reductions.
ALTER TABLE signer_native_requests ADD COLUMN IF NOT EXISTS corrected_raw numeric(20,0) NOT NULL DEFAULT 0
 CHECK(corrected_raw>=0 AND corrected_raw<=credited_raw AND (corrected_raw=0 OR side='buy'));
ALTER TABLE signer_inventory_reviews ADD COLUMN IF NOT EXISTS lane text NOT NULL DEFAULT 'standard'
 CHECK(lane IN('standard','native'));
CREATE INDEX IF NOT EXISTS signer_inventory_reviews_lane ON signer_inventory_reviews(wallet,mint,lane,state);
