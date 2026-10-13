-- Preserve only safe categories and numeric provider codes, never messages,
-- URLs, credentials, or signed transaction payloads. No execution activation.
ALTER TABLE fomo_token22_submissions
  ADD COLUMN IF NOT EXISTS rpc_diagnostic_kind text
    CHECK(rpc_diagnostic_kind IN ('http','rpc','transport','malformed')),
  ADD COLUMN IF NOT EXISTS rpc_diagnostic_code integer;
ALTER TABLE fomo_token22_submissions DROP CONSTRAINT IF EXISTS native_submission_diagnostic_code;
ALTER TABLE fomo_token22_submissions ADD CONSTRAINT native_submission_diagnostic_code
  CHECK(rpc_diagnostic_code IS NULL OR
    (rpc_diagnostic_kind IS NOT NULL AND
      ((rpc_diagnostic_kind='http' AND rpc_diagnostic_code BETWEEN 100 AND 599) OR
       (rpc_diagnostic_kind='rpc' AND rpc_diagnostic_code BETWEEN -32768 AND -32000))));
