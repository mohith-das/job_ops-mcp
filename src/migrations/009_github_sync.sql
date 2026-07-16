-- Public-only GitHub polling and candidate-reviewed career-packet proposals.

CREATE TABLE github_connection (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  github_username    TEXT NOT NULL,
  github_user_id     INTEGER,
  enabled            INTEGER NOT NULL DEFAULT 0,
  last_sync_at       TEXT,
  last_success_at    TEXT,
  last_error         TEXT,
  created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE github_repositories (
  github_repo_id       INTEGER PRIMARY KEY,
  full_name            TEXT NOT NULL,
  html_url             TEXT NOT NULL,
  description          TEXT,
  visibility           TEXT NOT NULL CHECK (visibility = 'public'),
  is_fork              INTEGER NOT NULL DEFAULT 0,
  is_archived          INTEGER NOT NULL DEFAULT 0,
  default_branch       TEXT NOT NULL,
  latest_sha           TEXT,
  latest_pushed_at     TEXT,
  content_hash         TEXT,
  included             INTEGER NOT NULL DEFAULT 1,
  last_checked_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE github_sync_runs (
  id                    TEXT PRIMARY KEY,
  trigger               TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('running','success','failed')),
  repositories_seen     INTEGER NOT NULL DEFAULT 0,
  repositories_changed  INTEGER NOT NULL DEFAULT 0,
  proposals_created     INTEGER NOT NULL DEFAULT 0,
  started_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at          TEXT,
  error                 TEXT
);

CREATE TABLE github_cv_proposals (
  id                     TEXT PRIMARY KEY,
  github_repo_id         INTEGER NOT NULL REFERENCES github_repositories(github_repo_id) ON DELETE CASCADE,
  source_commit_sha      TEXT NOT NULL,
  source_url             TEXT NOT NULL,
  evidence_json          TEXT NOT NULL,
  proposed_packet_content TEXT NOT NULL,
  packet_diff            TEXT NOT NULL,
  confidence             INTEGER NOT NULL DEFAULT 70 CHECK (confidence BETWEEN 0 AND 100),
  status                 TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','approved','edited','rejected','superseded','failed')),
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at            TEXT,
  applied_packet_version INTEGER,
  cv_sync_error          TEXT,
  livingcv_sync_error    TEXT,
  UNIQUE (github_repo_id, source_commit_sha)
);

CREATE INDEX idx_github_proposals_status ON github_cv_proposals(status, created_at DESC);
CREATE INDEX idx_github_runs_started ON github_sync_runs(started_at DESC);
