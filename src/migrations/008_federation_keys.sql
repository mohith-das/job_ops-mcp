-- 008: Federation keypair + node_id + requested embedding dim.
--
-- The Canonical Federation Contract v1 across jobops / hirebridge / LivingCV
-- requires jobops to sign every snapshot with an ed25519 keypair. The keypair
-- is generated once on first connection to HireBridge and reused thereafter.
-- public_key is registered with HireBridge at /auth/device time and reused
-- on every /ingest/snapshot call so HireBridge can verify the signature.
--
-- We also persist the node_id HireBridge returns on successful auth so we
-- can correlate (and so it survives a restart). And we surface the dim
-- HireBridge expects (default 384, set via HB_EMBED_DIM) — broadcast refuses
-- to send a snapshot whose first-row dim disagrees, instead of feeding
-- garbage to a vector index.

ALTER TABLE federation_state ADD COLUMN hirebridge_public_key      TEXT;  -- 64-char hex (raw ed25519 pubkey bytes)
ALTER TABLE federation_state ADD COLUMN hirebridge_private_key     TEXT;  -- 64-char hex (raw ed25519 privkey seed, generated once)
ALTER TABLE federation_state ADD COLUMN hirebridge_node_id         TEXT;  -- server-issued node id from /auth/token success body
ALTER TABLE federation_state ADD COLUMN hirebridge_expected_dim    INTEGER NOT NULL DEFAULT 384;  -- mirrors HB_EMBED_DIM; broadcast gates on this
