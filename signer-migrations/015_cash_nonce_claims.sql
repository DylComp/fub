CREATE TABLE IF NOT EXISTS signer_cash_nonce_claims (
 wallet text NOT NULL CHECK(wallet ~ '^0x[0-9a-f]{40}$'),
 chain_id bigint NOT NULL CHECK(chain_id > 0),
 nonce bigint NOT NULL CHECK(nonce >= 0),
 digest text NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'),
 request_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(wallet,chain_id,nonce)
);
REVOKE ALL ON signer_cash_nonce_claims FROM PUBLIC;
