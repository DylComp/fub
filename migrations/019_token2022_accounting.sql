-- Explicit SOL-denominated limits. Existing USDC permissions are unchanged.
CREATE TABLE IF NOT EXISTS fomo_token22_permissions (
  id uuid PRIMARY KEY, plan_id uuid NOT NULL REFERENCES fomo_copy_plans(id), wallet text NOT NULL,
  scope jsonb NOT NULL, signature text NOT NULL, scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((scope->>'policy'='raydium-token22-sol-v1' AND scope->>'wallet'=wallet AND scope->>'planId'=plan_id::text AND scope->>'id'=id::text) IS TRUE)
);
CREATE UNIQUE INDEX IF NOT EXISTS fomo_token22_one_permission ON fomo_token22_permissions(plan_id) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS fomo_token22_budgets (
  plan_id uuid NOT NULL REFERENCES fomo_copy_plans(id), day date NOT NULL,
  reserved_lamports bigint NOT NULL DEFAULT 0 CHECK(reserved_lamports>=0),
  spent_lamports bigint NOT NULL DEFAULT 0 CHECK(spent_lamports>=0), PRIMARY KEY(plan_id,day)
);
CREATE TABLE IF NOT EXISTS fomo_token22_positions (
  plan_id uuid NOT NULL REFERENCES fomo_copy_plans(id), mint text NOT NULL,
  decimals integer NOT NULL CHECK(decimals BETWEEN 0 AND 18),
  raw_amount numeric(20,0) NOT NULL CHECK(raw_amount>=0 AND raw_amount<=18446744073709551615),
  proceeds_lamports numeric(38,0) NOT NULL DEFAULT 0 CHECK(proceeds_lamports>=0),
  last_slot bigint NOT NULL CHECK(last_slot>0), PRIMARY KEY(plan_id,mint)
);
CREATE TABLE IF NOT EXISTS fomo_token22_reservations (
  execution_id uuid PRIMARY KEY, wallet text NOT NULL,
  plan_id uuid NOT NULL REFERENCES fomo_copy_plans(id), permission_id uuid NOT NULL REFERENCES fomo_token22_permissions(id),
  leader_signature text NOT NULL, review_hash text NOT NULL, budget_day date NOT NULL,
  mint text NOT NULL, side text NOT NULL CHECK(side IN('buy','sell')), decimals integer NOT NULL CHECK(decimals BETWEEN 0 AND 18),
  input_raw numeric(20,0) NOT NULL CHECK(input_raw>0 AND input_raw<=18446744073709551615),
  reserved_lamports bigint NOT NULL CHECK(reserved_lamports>0),
  state text NOT NULL DEFAULT 'reserved' CHECK(state IN('reserved','applied','released')),
  next_check_at timestamptz NOT NULL DEFAULT now(), issue text CHECK(issue='inconsistent'),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(execution_id,wallet) REFERENCES fomo_token22_executions(id,wallet),
  FOREIGN KEY(plan_id,budget_day) REFERENCES fomo_token22_budgets(plan_id,day),
  UNIQUE(plan_id,leader_signature)
);
CREATE UNIQUE INDEX IF NOT EXISTS fomo_token22_one_reservation ON fomo_token22_reservations(wallet) WHERE state='reserved';
CREATE INDEX IF NOT EXISTS fomo_token22_accounting_due ON fomo_token22_reservations(next_check_at,execution_id) WHERE state='reserved';
CREATE OR REPLACE VIEW fomo_token22_authorized_reservations AS
SELECT r.*,g.scope_hash FROM fomo_token22_reservations r
JOIN fomo_token22_permissions g ON g.id=r.permission_id AND g.plan_id=r.plan_id AND g.wallet=r.wallet
JOIN fomo_copy_plans p ON p.id=r.plan_id AND p.wallet=r.wallet
JOIN fomo_token22_executions e ON e.id=r.execution_id AND e.wallet=r.wallet
WHERE r.state='reserved' AND g.revoked_at IS NULL AND p.enabled AND NOT p.archived
  AND p.version=(g.scope->>'planVersion')::integer AND p.leader=g.scope->>'leader'
  AND g.expires_at>statement_timestamp() AND e.expires_at<=g.expires_at AND e.review_hash=r.review_hash
  AND r.budget_day=(statement_timestamp() AT TIME ZONE 'UTC')::date
  AND NOT EXISTS(SELECT 1 FROM fomo_copy_controls c WHERE c.wallet=r.wallet)
  AND (r.side='buy' OR ((g.scope->>'copySells')::boolean AND (p.data->>'copySells')::boolean));
