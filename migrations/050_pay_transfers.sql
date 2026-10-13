-- One active signed payment per exact public share reference. No private notes,
-- card credentials or wallet keys are stored here.
CREATE TABLE IF NOT EXISTS fub_pay_transfers (
 reference text PRIMARY KEY,
 sender text NOT NULL,
 signature text NOT NULL UNIQUE,
 signed_transaction text NOT NULL,
 review jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','verified','failed','expired_unresolved')),
 receipt jsonb,
 previous_attempts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(previous_attempts)='array' AND jsonb_array_length(previous_attempts)<=10),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(jsonb_typeof(review)='object'),
 CHECK((state='verified')=(receipt IS NOT NULL)),
 CHECK(review->>'reference'=reference),
 CHECK(review->>'sender'=sender)
);
