CREATE TABLE IF NOT EXISTS fomo_copy_plans (
  id uuid PRIMARY KEY,
  wallet text NOT NULL,
  leader text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  archived boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT false,
  enabled_at timestamptz,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(wallet,leader),
  CHECK (wallet <> leader),
  CHECK (NOT enabled OR (NOT archived AND enabled_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS fomo_copy_wallet_plans ON fomo_copy_plans(wallet,updated_at DESC);
CREATE TABLE IF NOT EXISTS fomo_copy_budgets (
  plan_id uuid NOT NULL REFERENCES fomo_copy_plans(id),
  day date NOT NULL,
  reserved_cents bigint NOT NULL DEFAULT 0 CHECK (reserved_cents >= 0),
  spent_cents bigint NOT NULL DEFAULT 0 CHECK (spent_cents >= 0),
  PRIMARY KEY(plan_id,day)
);
CREATE TABLE IF NOT EXISTS fomo_copy_attempts (
  id uuid PRIMARY KEY,
  plan_id uuid NOT NULL REFERENCES fomo_copy_plans(id),
  wallet text NOT NULL,
  leader_signature text NOT NULL,
  mint text NOT NULL,
  budget_day date NOT NULL,
  reserved_cents bigint NOT NULL CHECK (reserved_cents > 0),
  plan_version integer NOT NULL,
  slippage_bps integer NOT NULL,
  state text NOT NULL CHECK (state IN ('reserved','submitting','unknown','confirmed','released','skipped')),
  signature text,
  expires_at timestamptz NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(plan_id,leader_signature)
);
CREATE UNIQUE INDEX IF NOT EXISTS fomo_copy_one_pending ON fomo_copy_attempts(wallet) WHERE state IN ('reserved','submitting','unknown');
CREATE TABLE IF NOT EXISTS fomo_copy_positions (
  plan_id uuid NOT NULL REFERENCES fomo_copy_plans(id),
  mint text NOT NULL,
  raw_amount numeric(20,0) NOT NULL CHECK (raw_amount >= 0 AND raw_amount <= 18446744073709551615),
  PRIMARY KEY(plan_id,mint)
);

CREATE UNIQUE INDEX IF NOT EXISTS fomo_copy_one_signature ON fomo_copy_attempts(signature) WHERE signature IS NOT NULL;

ALTER TABLE fomo_copy_attempts DROP CONSTRAINT IF EXISTS fomo_copy_attempt_budget;
ALTER TABLE fomo_copy_attempts ADD CONSTRAINT fomo_copy_attempt_budget FOREIGN KEY(plan_id,budget_day) REFERENCES fomo_copy_budgets(plan_id,day);
