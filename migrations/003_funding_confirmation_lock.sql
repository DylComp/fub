-- Provider acknowledgement is not proof that a deposit/withdrawal completed.
CREATE UNIQUE INDEX IF NOT EXISTS fomo_funding_one_unconfirmed ON fomo_funding_operations(wallet)
  WHERE state IN ('preparing','prepared','submitting','submitted','unknown');
