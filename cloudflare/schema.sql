-- Cloudflare D1 schema for the public fictional-data PACT demo.
-- Workspace rows contain only the built-in fictional sample; bearer and account keys are stored as SHA-256 hashes.
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

-- Pseudonymous demo accounts contain no email, name, or password. Each account key is random high-entropy material; only its hash is stored.
CREATE TABLE IF NOT EXISTS demo_accounts (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  account_key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS demo_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES demo_accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS demo_workspace_memberships (
  workspace_id TEXT NOT NULL REFERENCES shared_workspaces(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES demo_accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('provider', 'client')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, account_id),
  UNIQUE (workspace_id, role)
);
CREATE TABLE IF NOT EXISTS demo_workspace_invites (
  workspace_id TEXT PRIMARY KEY REFERENCES shared_workspaces(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role = 'client'),
  created_by TEXT NOT NULL REFERENCES demo_accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS demo_accounts_expiry_idx ON demo_accounts(expires_at);
CREATE INDEX IF NOT EXISTS demo_sessions_account_idx ON demo_sessions(account_id);
CREATE INDEX IF NOT EXISTS demo_sessions_expiry_idx ON demo_sessions(expires_at);
CREATE INDEX IF NOT EXISTS demo_memberships_account_idx ON demo_workspace_memberships(account_id);
CREATE INDEX IF NOT EXISTS demo_workspace_invites_expiry_idx ON demo_workspace_invites(expires_at);
