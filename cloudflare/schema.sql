-- Cloudflare D1 schema for the public fictional-data PACT demo.
-- Each workspace contains exactly one canonical sample agreement; invite tokens are stored as SHA-256 hashes.
CREATE TABLE IF NOT EXISTS shared_workspaces (
  id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shared_invites (
  token_hash TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES shared_workspaces(id),
  role TEXT NOT NULL CHECK (role IN ('provider', 'client')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS shared_invites_workspace_idx ON shared_invites(workspace_id);
CREATE INDEX IF NOT EXISTS shared_workspaces_expiry_idx ON shared_workspaces(expires_at);
CREATE INDEX IF NOT EXISTS shared_invites_expiry_idx ON shared_invites(expires_at);
