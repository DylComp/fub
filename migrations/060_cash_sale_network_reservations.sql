-- EVM nonces are local to a chain. A pending return on one chain must not
-- reserve the same address on every other chain. Legacy rows were Base-only.
-- Build the replacement before dropping the stricter index, in one transaction.
CREATE UNIQUE INDEX IF NOT EXISTS fub_cash_sale_pending_network_evm
 ON fub_cash_sales(lower(evm_wallet), (COALESCE(simulation->'route'->'intent'->>'network', 'base')))
 WHERE state NOT IN('expired','complete','refunded','reverted');
DROP INDEX IF EXISTS fub_cash_sale_pending_evm;
