-- Private ledger only. Finalized outcomes, not application balances, credit sells.
ALTER TABLE signer_native_requests
 ADD COLUMN IF NOT EXISTS mint text GENERATED ALWAYS AS (evidence #>> '{request,review,accounts,mint}') STORED,
 ADD COLUMN IF NOT EXISTS side text GENERATED ALWAYS AS (evidence #>> '{request,review,accounts,direction}') STORED,
 ADD COLUMN IF NOT EXISTS decimals integer GENERATED ALWAYS AS ((evidence #>> '{request,review,accounts,decimals}')::integer) STORED,
 ADD COLUMN IF NOT EXISTS input_raw numeric(20,0) GENERATED ALWAYS AS ((evidence #>> '{request,review,accounts,inputRaw}')::numeric(20,0)) STORED,
 ADD COLUMN IF NOT EXISTS settlement text NOT NULL DEFAULT 'pending' CHECK(settlement IN('pending','succeeded','failed')),
 ADD COLUMN IF NOT EXISTS credited_raw numeric(20,0) NOT NULL DEFAULT 0 CHECK(credited_raw>=0),
 ADD COLUMN IF NOT EXISTS actual_lamports bigint CHECK(actual_lamports>=0 AND actual_lamports<=reserved_lamports),
 ADD COLUMN IF NOT EXISTS settled_slot bigint CHECK(settled_slot>0),
 ADD COLUMN IF NOT EXISTS receipt jsonb,
 ADD COLUMN IF NOT EXISTS next_check_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE signer_native_requests ADD CONSTRAINT native_inventory_identity
 CHECK(mint IS NOT NULL AND side IN('buy','sell') AND decimals BETWEEN 0 AND 18 AND input_raw>0);
ALTER TABLE signer_native_requests ADD CONSTRAINT native_inventory_outcome
 CHECK((settlement='pending' AND actual_lamports IS NULL AND settled_slot IS NULL AND receipt IS NULL AND credited_raw=0)
 OR (settlement<>'pending' AND state='signed' AND actual_lamports IS NOT NULL AND settled_slot IS NOT NULL AND receipt IS NOT NULL
 AND (credited_raw=0 OR (settlement='succeeded' AND side='buy'))));
CREATE INDEX IF NOT EXISTS signer_native_inventory ON signer_native_requests(wallet,mint,plan_id);
CREATE INDEX IF NOT EXISTS signer_native_recovery ON signer_native_requests(next_check_at) WHERE state='signed' AND settlement='pending';
