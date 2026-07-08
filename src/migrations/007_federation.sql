-- 007: Federation infrastructure for the LivingCV + HireBridge integration.
--
-- Tables added:
--   career_packet_json  — compiled canonical career packet (JSON Resume superset)
--   federation_state    — sync state for LivingCV + HireBridge (last sync/broadcast times)
--   embeddings_cache    — cached vector embeddings keyed by packet_hash + section + model
--   broadcast_log       — history of signal broadcasts to HireBridge
--
-- These tables support the federation features: compile career-packet.json, sync to LivingCV,
-- generate local embeddings, and broadcast signed signal snapshots to HireBridge.

-- Compiled canonical career packet (JSON Resume superset with Lightcast Open Skills IDs)
CREATE TABLE career_packet_json (
  id              TEXT PRIMARY KEY,
  version         INTEGER NOT NULL,
  content         TEXT NOT NULL,          -- the JSON blob (stringified career-packet.json)
  content_hash    TEXT NOT NULL,          -- sha256 of content (for change detection)
  source_cv_hash  TEXT,                   -- links to the cv.md it was compiled from
  lightcast_mapped INTEGER NOT NULL DEFAULT 0,  -- 1 if Lightcast IDs were resolved via LLM
  is_active       INTEGER NOT NULL DEFAULT 0,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_career_packet_json_active ON career_packet_json(is_active);

-- Sync state: tracks when we last pushed to LivingCV / broadcast to HireBridge.
-- Single-row table (id=1) like scheduler_state and digest_state.
CREATE TABLE federation_state (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  livingcv_last_sync  TEXT,               -- ISO timestamp of last successful sync
  livingcv_last_error TEXT,               -- last error message (null if last sync succeeded)
  hirebridge_last_broadcast TEXT,         -- ISO timestamp of last successful broadcast
  hirebridge_last_error     TEXT,         -- last error message (null if last broadcast succeeded)
  hirebridge_email          TEXT,         -- email associated with HireBridge connection
  hirebridge_connected      INTEGER NOT NULL DEFAULT 0  -- 1 if connected, 0 if not
);

INSERT INTO federation_state (id) VALUES (1);

-- Cached embeddings (packet_hash → vector, so we only re-embed when content changes).
-- The UNIQUE constraint on (packet_hash, section, model) ensures one embedding per
-- section per model per packet version. Old embeddings are orphaned when the packet
-- hash changes (we don't delete — they're cheap and may be useful for diffing).
CREATE TABLE embeddings_cache (
  id              TEXT PRIMARY KEY,
  packet_hash     TEXT NOT NULL,
  section         TEXT NOT NULL,          -- 'full' | 'summary' | 'skills' | 'work_0' | 'evidence_0' | etc.
  embedding       TEXT NOT NULL,          -- JSON array of floats (e.g. "[0.12, -0.34, ...]")
  model           TEXT NOT NULL,          -- 'all-MiniLM-L6-v2' | 'text-embedding-3-small' | etc.
  dim             INTEGER NOT NULL,       -- embedding dimension (384 for MiniLM, 1536 for ada-002)
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (packet_hash, section, model)
);

CREATE INDEX idx_embeddings_packet_hash ON embeddings_cache(packet_hash);

-- Broadcast history: every signal broadcast to HireBridge is logged here.
-- Used for debugging and for the get_federation_status tool.
CREATE TABLE broadcast_log (
  id              TEXT PRIMARY KEY,
  snapshot_hash   TEXT NOT NULL,          -- sha256 of the broadcast snapshot
  hirebridge_response TEXT,               -- JSON: { matched: N, router_id: ... } or error details
  status          TEXT NOT NULL DEFAULT 'sent',  -- 'sent' | 'error'
  error           TEXT,                   -- error message if status='error'
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_broadcast_log_created_at ON broadcast_log(created_at DESC);
