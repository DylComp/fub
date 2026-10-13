CREATE TABLE IF NOT EXISTS fomo_copy_dispatch_control (
  name text PRIMARY KEY CHECK(name='execution'),
  enabled boolean NOT NULL DEFAULT false,
  epoch bigint NOT NULL DEFAULT 1 CHECK(epoch>0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fomo_copy_dispatch_control(name) VALUES('execution') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS fomo_copy_dispatch (
  id uuid PRIMARY KEY,
  plan_id uuid NOT NULL,
  leader_signature text NOT NULL,
  wallet text NOT NULL,
  plan_version integer NOT NULL CHECK(plan_version>0),
  permission_id uuid NOT NULL REFERENCES fomo_copy_permissions(id),
  epoch bigint NOT NULL,
  sequence bigint NOT NULL,
  deadline timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN('queued','running','submitted','skipped')),
  reason text CHECK(reason IN('expired','permission_changed','halted','attempt_finished','retries_exhausted','ineligible')),
  runs integer NOT NULL DEFAULT 0 CHECK(runs>=0 AND runs<=3),
  lease_id uuid,
  lease_until timestamptz,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(plan_id,leader_signature),
  FOREIGN KEY(plan_id,leader_signature) REFERENCES fomo_copy_feed_events(plan_id,signature) ON DELETE CASCADE,
  CHECK((lease_id IS NULL)=(lease_until IS NULL))
);
CREATE INDEX IF NOT EXISTS fomo_copy_dispatch_due ON fomo_copy_dispatch(next_run_at,sequence) WHERE state IN('queued','running');
CREATE INDEX IF NOT EXISTS fomo_copy_dispatch_wallet ON fomo_copy_dispatch(wallet,lease_until) WHERE state='running';

-- A missing dispatch means an independent wallet-signed path. A queued attempt
-- always carries dispatchId and cannot use that path to bypass a worker lease.
CREATE OR REPLACE FUNCTION fomo_copy_dispatch_allowed(w text,pid uuid,sig text,job text,ticket text)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN job IS NULL THEN ticket IS NULL ELSE EXISTS(
  SELECT 1 FROM fomo_copy_dispatch j JOIN fomo_copy_dispatch_control c ON c.name='execution'
  JOIN fomo_copy_authorized_plans p ON p.id=j.plan_id AND p.wallet=j.wallet AND p.permission_id=j.permission_id AND p.version=j.plan_version
  JOIN fomo_copy_feed f ON f.plan_id=j.plan_id
  WHERE j.id::text=job AND j.lease_id::text=ticket AND j.wallet=w AND j.plan_id=pid AND j.leader_signature=sig
    AND c.enabled AND c.epoch=j.epoch AND p.enabled AND j.state='running'
    AND j.lease_until>statement_timestamp() AND j.deadline>statement_timestamp() AND f.status='ready'
    AND NOT EXISTS(SELECT 1 FROM fomo_copy_feed_events pending WHERE pending.plan_id=pid AND pending.decision IS NULL)
 ) END
$$;
