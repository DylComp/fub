-- Enrollment is private, owner-verified and provider-verified before insertion.
-- No public endpoint can write a binding or infer one from a username.
CREATE TABLE IF NOT EXISTS fub_pay_cards (
 account_id text NOT NULL,
 live boolean NOT NULL,
 card_id text NOT NULL,
 cardholder_id text NOT NULL,
 wallet text NOT NULL,
 bridge_customer_id text NOT NULL,
 enrolled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(account_id,live,card_id)
);
CREATE INDEX IF NOT EXISTS fub_pay_cards_owner ON fub_pay_cards(wallet,account_id,live);
CREATE TABLE IF NOT EXISTS fub_pay_events (
 account_id text NOT NULL,
 live boolean NOT NULL,
 event_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN('authorization','transaction')),
 resource_id text NOT NULL,
 occurred_at bigint NOT NULL CHECK(occurred_at>0),
 digest text NOT NULL CHECK(length(digest)=64),
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(account_id,live,event_id)
);
CREATE TABLE IF NOT EXISTS fub_pay_resources (
 account_id text NOT NULL,
 live boolean NOT NULL,
 kind text NOT NULL CHECK(kind IN('authorization','transaction')),
 resource_id text NOT NULL,
 generation bigint NOT NULL DEFAULT 1,
 applied_generation bigint NOT NULL DEFAULT 0,
 lease_id uuid,
 lease_until timestamptz,
 next_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 failures integer NOT NULL DEFAULT 0,
 last_error text CHECK(last_error IN('provider_unavailable','unsupported_record','unbound_card')),
 snapshot jsonb,
 fetched_at timestamptz,
 PRIMARY KEY(account_id,live,kind,resource_id),
 CHECK(generation>0 AND applied_generation>=0 AND applied_generation<=generation),
 CHECK(snapshot IS NULL OR jsonb_typeof(snapshot)='object')
);
CREATE INDEX IF NOT EXISTS fub_pay_resources_due ON fub_pay_resources(account_id,live,next_at);
-- Discovery walks each enrolled card's provider history, including events never delivered.
CREATE TABLE IF NOT EXISTS fub_pay_discovery (
 account_id text NOT NULL,
 live boolean NOT NULL,
 card_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN('authorization','transaction')),
 cursor text,
 lease_id uuid,
 lease_until timestamptz,
 next_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 failures integer NOT NULL DEFAULT 0,
 last_completed_at timestamptz,
 PRIMARY KEY(account_id,live,card_id,kind),
 FOREIGN KEY(account_id,live,card_id) REFERENCES fub_pay_cards(account_id,live,card_id)
);
