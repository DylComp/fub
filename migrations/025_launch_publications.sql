CREATE TABLE IF NOT EXISTS fomo_launch_images (
  hash text PRIMARY KEY CHECK(hash ~ '^[a-f0-9]{64}$'),
  content_type text NOT NULL CHECK(content_type IN('image/png','image/jpeg','image/gif')),
  bytes bytea NOT NULL CHECK(octet_length(bytes) BETWEEN 1 AND 2097152),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fomo_launch_metadata (
  hash text PRIMARY KEY CHECK(hash ~ '^[a-f0-9]{64}$'),
  body text NOT NULL CHECK(octet_length(body)<=8192),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fomo_launch_publications (
  id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'),
  owner text NOT NULL,
  data jsonb NOT NULL,
  image_hash text NOT NULL REFERENCES fomo_launch_images(hash),
  metadata_hash text NOT NULL REFERENCES fomo_launch_metadata(hash),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fomo_launch_publications_owner ON fomo_launch_publications(owner,created_at DESC,id);
CREATE TABLE IF NOT EXISTS fomo_launch_publication_requests (
  owner text NOT NULL,
  nonce uuid NOT NULL,
  payload_hash text NOT NULL,
  authorization_record jsonb NOT NULL,
  signature text NOT NULL,
  manifest text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','complete','failed')),
  publication_id text REFERENCES fomo_launch_publications(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner,nonce),
  CHECK(state<>'complete' OR publication_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS fomo_launch_publication_quota ON fomo_launch_publication_requests(created_at,owner);
