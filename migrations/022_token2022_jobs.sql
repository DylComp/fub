CREATE TABLE IF NOT EXISTS fomo_token22_jobs (
  id uuid PRIMARY KEY,
  execution_id uuid NOT NULL UNIQUE,
  wallet text NOT NULL,
  plan_id uuid NOT NULL,
  leader_signature text NOT NULL,
  permission_id uuid NOT NULL REFERENCES fomo_token22_permissions(id),
  plan_version integer NOT NULL CHECK(plan_version>0),
  epoch bigint NOT NULL,
  sequence bigint NOT NULL,
  leader_slot bigint NOT NULL CHECK(leader_slot>0),
  decision jsonb NOT NULL,
  deadline timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN('queued','building','prepared','skipped')),
  reason text CHECK(reason IN('expired','permission_changed','halted','retries_exhausted','ineligible')),
  runs integer NOT NULL DEFAULT 0 CHECK(runs BETWEEN 0 AND 3),
  lease_id uuid,
  lease_until timestamptz,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(plan_id,leader_signature),
  FOREIGN KEY(plan_id,leader_signature) REFERENCES fomo_copy_feed_events(plan_id,signature) ON DELETE CASCADE,
  CHECK((lease_id IS NULL)=(lease_until IS NULL))
);
ALTER TABLE fomo_token22_executions ADD COLUMN IF NOT EXISTS queue_job_id uuid REFERENCES fomo_token22_jobs(id);
CREATE INDEX IF NOT EXISTS fomo_token22_jobs_due ON fomo_token22_jobs(next_run_at,sequence) WHERE state IN('queued','building');
CREATE INDEX IF NOT EXISTS fomo_token22_jobs_wallet ON fomo_token22_jobs(wallet,lease_until) WHERE state IN('building','prepared');
CREATE OR REPLACE VIEW fomo_token22_current_jobs AS
SELECT j.* FROM fomo_token22_jobs j
JOIN fomo_token22_permissions g ON g.id=j.permission_id AND g.plan_id=j.plan_id AND g.wallet=j.wallet
JOIN fomo_copy_plans p ON p.id=j.plan_id AND p.wallet=j.wallet
JOIN fomo_copy_feed f ON f.plan_id=p.id
JOIN fomo_copy_feed_events e ON e.plan_id=p.id AND e.signature=j.leader_signature
JOIN fomo_copy_dispatch_control c ON c.name='execution'
WHERE c.enabled AND c.epoch=j.epoch AND j.deadline>statement_timestamp()
  AND p.enabled AND NOT p.archived AND p.version=j.plan_version AND p.version=(g.scope->>'planVersion')::integer
  AND p.leader=g.scope->>'leader' AND g.revoked_at IS NULL AND g.expires_at>=j.deadline
  AND (p.data->>'slippageBps')::integer>=(g.scope->>'slippageBps')::integer
  AND f.status='ready' AND NOT e.failed AND e.decision=j.decision AND e.slot=j.leader_slot
  AND e.sequence=j.sequence AND p.enabled_at<=to_timestamp(e.block_time)
  AND to_timestamp(e.block_time)>=statement_timestamp()-interval '60 seconds'
  AND to_timestamp(e.block_time)<=statement_timestamp()+interval '5 seconds'
  AND NOT EXISTS(SELECT 1 FROM fomo_copy_controls x WHERE x.wallet=j.wallet)
  AND NOT EXISTS(SELECT 1 FROM fomo_copy_feed_events pending WHERE pending.plan_id=p.id AND pending.decision IS NULL)
  AND (j.decision->>'side'='buy' OR ((g.scope->>'copySells')::boolean AND (p.data->>'copySells')::boolean));
CREATE OR REPLACE FUNCTION fomo_token22_job_allowed(execution uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM fomo_token22_executions e WHERE e.id=execution AND (
   (e.queue_job_id IS NULL AND NOT EXISTS(SELECT 1 FROM fomo_token22_jobs j WHERE j.execution_id=e.id))
   OR EXISTS(SELECT 1 FROM fomo_token22_current_jobs j WHERE j.id=e.queue_job_id AND j.execution_id=e.id AND j.state='prepared')
 ))
$$;
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
  AND (r.side='buy' OR ((g.scope->>'copySells')::boolean AND (p.data->>'copySells')::boolean))
  AND fomo_token22_job_allowed(e.id);
