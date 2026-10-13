ALTER TABLE signer_native_requests DROP CONSTRAINT IF EXISTS signer_native_requests_settlement_check;
ALTER TABLE signer_native_requests ADD CONSTRAINT signer_native_requests_settlement_check CHECK(settlement IN('pending','succeeded','failed','expired'));
ALTER TABLE signer_native_requests ADD COLUMN IF NOT EXISTS expiry_next_check_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE signer_native_requests DROP CONSTRAINT IF EXISTS native_signed_expiry_outcome;
ALTER TABLE signer_native_requests ADD CONSTRAINT native_signed_expiry_outcome CHECK(settlement<>'expired' OR
 (actual_lamports=0 AND credited_raw=0 AND corrected_raw=0 AND receipt->>'kind'='expired'
 AND receipt->>'signature'=signature AND (receipt->>'lastSlot')::bigint=settled_slot
 AND (receipt->>'lastBlockHeight')::bigint>(evidence#>>'{request,review,lastValidBlockHeight}')::bigint) IS TRUE);
