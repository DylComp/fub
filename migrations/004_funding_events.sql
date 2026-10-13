CREATE TABLE IF NOT EXISTS fomo_funding_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES fomo_funding_operations(id) ON DELETE CASCADE,
  wallet text NOT NULL,
  state text NOT NULL CHECK (state IN ('preparing','prepared','submitting','submitted','unknown','confirmed','failed','abandoned')),
  details jsonb NOT NULL CHECK (jsonb_typeof(details) = 'object'),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fomo_funding_event_history ON fomo_funding_events(wallet,operation_id,id DESC);
