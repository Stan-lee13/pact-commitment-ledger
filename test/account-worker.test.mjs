import test from "node:test";
import assert from "node:assert/strict";
import { handleSharedRequest } from "../cloudflare/worker.mjs";

const START = new Date("2026-10-17T10:00:00.000Z");
let requestNumber = 1;

class MemoryD1 {
  constructor() {
    this.accounts = new Map();
    this.sessions = new Map();
    this.workspaces = new Map();
    this.memberships = new Map();
    this.invites = new Map();
  }
  prepare(sql) { return new MemoryStatement(this, sql); }
  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

class MemoryStatement {
  constructor(db, sql) { this.db = db; this.sql = sql.replace(/\s+/g, " ").trim(); this.params = []; }
  bind(...params) { this.params = params; return this; }
  async first() {
    const { sql, params: p, db } = this;
    if (sql.startsWith("SELECT 1 AS ok")) return { ok: 1 };
    if (sql.includes("FROM demo_sessions s INNER JOIN demo_accounts a")) {
      const session = db.sessions.get(p[0]);
      const account = session && db.accounts.get(session.account_id);
      if (!session || !account || session.expires_at <= p[1] || account.expires_at <= p[2]) return null;
      return { id: account.id, handle: account.handle, account_expires_at: account.expires_at, session_hash: session.token_hash };
    }
    if (sql.startsWith("SELECT id, handle, account_key_hash")) {
      const account = [...db.accounts.values()].find((item) => item.handle === p[0] && item.expires_at > p[1]);
      return account ? { id: account.id, handle: account.handle, account_key_hash: account.account_key_hash, account_expires_at: account.expires_at } : null;
    }
    if (sql.includes("FROM demo_workspace_memberships m INNER JOIN shared_workspaces w")) {
      const membership = db.memberships.get(`${p[0]}:${p[1]}`);
      const workspace = membership && db.workspaces.get(membership.workspace_id);
      if (!membership || !workspace || workspace.expires_at <= p[2]) return null;
      return { workspace_id: workspace.id, role: membership.role, state_json: workspace.state_json, revision: workspace.revision, workspace_expires_at: workspace.expires_at };
    }
    if (sql.startsWith("SELECT i.workspace_id, i.role, i.expires_at AS invite_expires_at")) {
      const invite = db.invites.get(p[0]);
      const workspace = invite && db.workspaces.get(invite.workspace_id);
      if (!invite || !workspace || invite.expires_at <= p[1] || workspace.expires_at <= p[2]) return null;
      return { workspace_id: workspace.id, role: invite.role, invite_expires_at: invite.expires_at, state_json: workspace.state_json, revision: workspace.revision, workspace_expires_at: workspace.expires_at };
    }
    if (sql.startsWith("SELECT i.workspace_id, i.role, i.expires_at AS invite_expires_at") || sql.includes("FROM demo_workspace_invites i INNER JOIN shared_workspaces w")) {
      const invite = [...db.invites.values()].find((item) => item.token_hash === p[0]);
      const workspace = invite && db.workspaces.get(invite.workspace_id);
      if (!invite || !workspace || invite.expires_at <= p[1] || workspace.expires_at <= p[2]) return null;
      return { workspace_id: workspace.id, role: invite.role, invite_expires_at: invite.expires_at, state_json: workspace.state_json, revision: workspace.revision, workspace_expires_at: workspace.expires_at };
    }
    if (sql.startsWith("SELECT role FROM demo_workspace_memberships")) {
      const membership = db.memberships.get(`${p[1]}:${p[0]}`);
      return membership ? { role: membership.role } : null;
    }
    if (sql.includes("SELECT token_hash FROM shared_invites")) return null;
    throw new Error(`Unsupported first() SQL: ${sql}`);
  }
  async all() {
    const { sql, params: p, db } = this;
    if (sql.includes("SELECT m.workspace_id AS id, m.role, w.expires_at AS expiresAt")) {
      const results = [];
      for (const membership of db.memberships.values()) {
        const workspace = db.workspaces.get(membership.workspace_id);
        if (membership.account_id === p[0] && workspace && workspace.expires_at > p[1]) {
          results.push({ id: workspace.id, role: membership.role, expiresAt: workspace.expires_at, created_at: workspace.created_at });
        }
      }
      return { results: results.sort((a, b) => b.created_at.localeCompare(a.created_at)) };
    }
    throw new Error(`Unsupported all() SQL: ${sql}`);
  }
  async run() {
    const { sql, params: p, db } = this;
    const result = (count) => ({ meta: { changes: count } });
    if (sql.startsWith("DELETE FROM shared_invites") || sql.startsWith("DELETE FROM demo_workspace_invites WHERE expires_at")
      || sql.startsWith("DELETE FROM demo_workspace_memberships WHERE workspace_id IN")
      || sql.startsWith("DELETE FROM demo_sessions WHERE expires_at")
      || sql.startsWith("DELETE FROM shared_workspaces WHERE expires_at")
      || sql.startsWith("DELETE FROM demo_accounts WHERE expires_at")) return result(0);
    if (sql.startsWith("DELETE FROM demo_workspace_invites WHERE workspace_id = ? AND expires_at <= ?")) {
      const [workspaceId, nowText] = p;
      let removed = 0;
      for (const [hash, invite] of db.invites) if (invite.workspace_id === workspaceId && invite.expires_at <= nowText) { db.invites.delete(hash); removed += 1; }
      return result(removed);
    }
    if (sql.startsWith("INSERT INTO demo_accounts")) {
      const [id, handle, account_key_hash, created_at, expires_at, nowText, max] = p;
      if ([...db.accounts.values()].filter((item) => item.expires_at > nowText).length >= max) return result(0);
      db.accounts.set(id, { id, handle, account_key_hash, created_at, expires_at });
      return result(1);
    }
    if (sql.startsWith("INSERT INTO demo_sessions")) {
      let token_hash, account_id, created_at, expires_at;
      if (sql.includes("SELECT ?, ?, ?, ? WHERE EXISTS")) {
        [token_hash, account_id, created_at, expires_at] = p;
        if (!db.accounts.has(p[4])) return result(0);
      } else {
        [token_hash, account_id, created_at, expires_at] = p;
      }
      if (!db.accounts.has(account_id)) return result(0);
      db.sessions.set(token_hash, { token_hash, account_id, created_at, expires_at });
      return result(1);
    }
    if (sql.startsWith("INSERT INTO shared_workspaces")) {
      const [id, state_json, created_at, updated_at, expires_at, nowText, maxActive, accountId, , maxPerAccount] = p;
      const activeCount = [...db.workspaces.values()].filter((item) => item.expires_at > nowText).length;
      const accountWorkspaceCount = [...db.memberships.values()].filter((membership) => membership.account_id === accountId && db.workspaces.get(membership.workspace_id)?.expires_at > nowText).length;
      if (activeCount >= maxActive || accountWorkspaceCount >= maxPerAccount) return result(0);
      db.workspaces.set(id, { id, state_json, revision: 1, created_at, updated_at, expires_at });
      return result(1);
    }
    if (sql.startsWith("INSERT INTO demo_workspace_memberships") && sql.includes("'provider'")) {
      const [workspaceId, accountId, createdAt, , nowText, , accountExpiry] = p;
      const workspace = db.workspaces.get(workspaceId);
      const account = db.accounts.get(accountId);
      if (!workspace || workspace.expires_at <= nowText || !account || account.expires_at <= accountExpiry) return result(0);
      if ([...db.memberships.values()].some((item) => item.workspace_id === workspaceId && item.role === "provider")) return result(0);
      db.memberships.set(`${accountId}:${workspaceId}`, { workspace_id: workspaceId, account_id: accountId, role: "provider", created_at: createdAt });
      return result(1);
    }
    if (sql.startsWith("INSERT INTO demo_workspace_memberships") && sql.includes("SELECT i.workspace_id")) {
      const [accountId, createdAt, inviteHash, inviteExpiry, workspaceExpiry] = p;
      const invite = [...db.invites.values()].find((item) => item.token_hash === inviteHash);
      const workspace = invite && db.workspaces.get(invite.workspace_id);
      const occupied = invite && [...db.memberships.values()].some((item) => item.workspace_id === invite.workspace_id && item.role === invite.role);
      if (!invite || !workspace || invite.expires_at <= inviteExpiry || workspace.expires_at <= workspaceExpiry || occupied) return result(0);
      db.memberships.set(`${accountId}:${workspace.id}`, { workspace_id: workspace.id, account_id: accountId, role: invite.role, created_at: createdAt });
      return result(1);
    }
    if (sql.startsWith("INSERT INTO demo_workspace_invites")) {
      const [workspaceId, token_hash, created_by, created_at, expires_at] = p;
      if (!db.workspaces.has(workspaceId) || !db.accounts.has(created_by) || !db.memberships.has(`${created_by}:${workspaceId}`)) return result(0);
      if (sql.includes("AND NOT EXISTS") && [...db.invites.values()].some((item) => item.workspace_id === workspaceId)) return result(0);
      if (sql.includes("AND NOT EXISTS") && [...db.memberships.values()].some((item) => item.workspace_id === workspaceId && item.role === "client")) return result(0);
      db.invites.set(token_hash, { workspace_id: workspaceId, token_hash, role: "client", created_by, created_at, expires_at });
      return result(1);
    }
    if (sql.startsWith("DELETE FROM demo_workspace_invites WHERE token_hash = ? AND EXISTS")) {
      const [hash, workspaceId, accountId] = p;
      const invite = db.invites.get(hash);
      if (!invite || !db.memberships.has(`${accountId}:${workspaceId}`)) return result(0);
      db.invites.delete(hash);
      return result(1);
    }
    if (sql.startsWith("UPDATE demo_accounts SET account_key_hash")) {
      const [hash, accountId, nowText] = p;
      const account = db.accounts.get(accountId);
      if (!account || account.expires_at <= nowText) return result(0);
      account.account_key_hash = hash;
      return result(1);
    }
    if (sql.startsWith("DELETE FROM demo_sessions WHERE account_id = ? AND token_hash <> ?")) {
      const [accountId, except] = p;
      let removed = 0;
      for (const [hash, session] of db.sessions) if (session.account_id === accountId && hash !== except) { db.sessions.delete(hash); removed += 1; }
      return result(removed);
    }
    if (sql.startsWith("UPDATE demo_workspace_invites SET token_hash")) {
      const [hash, createdAt, workspaceId, accountId, nowText] = p;
      const invite = [...db.invites.values()].find((item) => item.workspace_id === workspaceId && item.created_by === accountId && item.role === "client" && item.expires_at > nowText);
      if (!invite) return result(0);
      db.invites.delete(invite.token_hash);
      invite.token_hash = hash;
      invite.created_at = createdAt;
      db.invites.set(hash, invite);
      return result(1);
    }
    if (sql.startsWith("UPDATE shared_workspaces SET state_json")) {
      const [state_json, updated_at, id, revision, nowText] = p;
      const workspace = db.workspaces.get(id);
      if (!workspace || workspace.revision !== revision || workspace.expires_at <= nowText) return result(0);
      workspace.state_json = state_json;
      workspace.revision += 1;
      workspace.updated_at = updated_at;
      return result(1);
    }
    if (sql.startsWith("DELETE FROM demo_sessions WHERE token_hash = ?")) return result(db.sessions.delete(p[0]) ? 1 : 0);
    throw new Error(`Unsupported run() SQL: ${sql}`);
  }
}

async function call(db, payload, now = START) {
  const ip = `198.51.100.${requestNumber++}`;
  const request = new Request("https://pact-demo-storage.workers.dev/", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(payload)
  });
  const response = await handleSharedRequest(request, { PACT_DB: db }, { now: () => new Date(now) });
  return { status: response.status, body: await response.json() };
}

async function register(db) {
  return call(db, { action: "account", operation: "register", fictionalConfirmed: true });
}

async function createWorkspace(db, sessionToken) {
  return call(db, { action: "account", operation: "create_workspace", sessionToken, fictionalConfirmed: true });
}

test("account creation requires fictional-only confirmation and stores only a hash of the random account key", async () => {
  const db = new MemoryD1();
  const denied = await call(db, { action: "account", operation: "register", fictionalConfirmed: false });
  assert.equal(denied.status, 400);
  const created = await register(db);
  assert.equal(created.status, 200);
  assert.match(created.body.account.handle, /^pact-[a-f0-9]{12}$/);
  assert.match(created.body.accountKey, /^[a-f0-9]{64}$/);
  assert.notEqual(db.accounts.get(created.body.account.id).account_key_hash, created.body.accountKey);
  assert.equal(JSON.stringify([...db.accounts.values()]).includes(created.body.accountKey), false);
  assert.equal(created.body.demoOnly, true);
});

test("account key login is pseudonymous, generic on failure, and sessions expire after seven days", async () => {
  const db = new MemoryD1();
  const created = await register(db);
  const bad = await call(db, { action: "account", operation: "login", handle: created.body.account.handle, accountKey: "f".repeat(64) });
  assert.equal(bad.status, 401);
  const login = await call(db, { action: "account", operation: "login", handle: created.body.account.handle, accountKey: created.body.accountKey });
  assert.equal(login.status, 200);
  assert.notEqual(login.body.sessionToken, created.body.accountKey);
  const session = await call(db, { action: "account", operation: "session", sessionToken: login.body.sessionToken });
  assert.equal(session.body.authenticated, true);
  assert.equal(session.body.account.handle, created.body.account.handle);
  const expired = await call(db, { action: "account", operation: "session", sessionToken: login.body.sessionToken }, new Date(START.getTime() + 8 * 24 * 60 * 60 * 1000));
  assert.deepEqual(expired.body, { authenticated: false, demoOnly: true });
});

test("workspace membership fixes the role, consumes the invite once, and denies unrelated accounts", async () => {
  const db = new MemoryD1();
  const provider = await register(db);
  const unconfirmed = await call(db, { action: "account", operation: "create_workspace", sessionToken: provider.body.sessionToken });
  assert.equal(unconfirmed.status, 400);
  const workspace = await createWorkspace(db, provider.body.sessionToken);
  assert.equal(workspace.status, 200);
  const workspaceId = workspace.body.workspace.id;
  const initialInvite = workspace.body.inviteToken;
  const providerState = await call(db, { action: "account", operation: "request", sessionToken: provider.body.sessionToken, workspaceId, path: "/api/state", method: "GET" });
  assert.equal(providerState.status, 200);
  assert.equal(providerState.body.config.storage, "account_d1");
  assert.equal(providerState.body.config.accountAuthenticated, true);
  assert.equal(providerState.body.config.sharedRole, "provider");
  assert.equal(providerState.body.config.paypal.configured, false);

  const client = await register(db);
  const joined = await call(db, { action: "account", operation: "join_workspace", sessionToken: client.body.sessionToken, inviteToken: initialInvite });
  assert.equal(joined.status, 200);
  assert.equal(joined.body.workspace.role, "client");
  const clientState = await call(db, { action: "account", operation: "request", sessionToken: client.body.sessionToken, workspaceId, path: "/api/state", method: "GET" });
  assert.equal(clientState.status, 200);
  assert.equal(clientState.body.config.sharedRole, "client");

  const spoofed = await call(db, {
    action: "account", operation: "request", sessionToken: client.body.sessionToken, workspaceId,
    path: "/api/engagements/demo-pact-01/evidence", method: "POST",
    body: { role: "provider", description: "Fictional test note" }
  });
  assert.equal(spoofed.status, 200);
  assert.equal(spoofed.body.evidence.actor, "client");
  const secondUse = await call(db, { action: "account", operation: "join_workspace", sessionToken: (await register(db)).body.sessionToken, inviteToken: initialInvite });
  assert.equal(secondUse.status, 404);

  const outsider = await register(db);
  const denied = await call(db, { action: "account", operation: "request", sessionToken: outsider.body.sessionToken, workspaceId, path: "/api/state", method: "GET" });
  assert.equal(denied.status, 404);
  const blockedPayment = await call(db, { action: "account", operation: "request", sessionToken: provider.body.sessionToken, workspaceId, path: "/api/paypal/orders", method: "POST" });
  assert.equal(blockedPayment.status, 403);
});

test("a participant cannot access a workspace they do not belong to, even with its ID", async () => {
  const db = new MemoryD1();
  const first = await register(db);
  const firstWorkspace = await createWorkspace(db, first.body.sessionToken);
  const second = await register(db);
  const secondWorkspace = await createWorkspace(db, second.body.sessionToken);
  assert.notEqual(firstWorkspace.body.workspace.id, secondWorkspace.body.workspace.id);
  const denied = await call(db, {
    action: "account", operation: "request", sessionToken: first.body.sessionToken,
    workspaceId: secondWorkspace.body.workspace.id, path: "/api/state", method: "GET"
  });
  assert.equal(denied.status, 404);
});

test("only the authenticated Provider can replace an unused Client invite; old key and sessions can be rotated safely", async () => {
  const db = new MemoryD1();
  const provider = await register(db);
  const login = await call(db, { action: "account", operation: "login", handle: provider.body.account.handle, accountKey: provider.body.accountKey });
  const workspace = await createWorkspace(db, provider.body.sessionToken);
  const workspaceId = workspace.body.workspace.id;
  const client = await register(db);
  const forbidden = await call(db, {
    action: "account", operation: "request", sessionToken: client.body.sessionToken, workspaceId,
    path: "/api/shared-invites/client", method: "POST", body: {}
  });
  assert.equal(forbidden.status, 404);

  const replacement = await call(db, {
    action: "account", operation: "request", sessionToken: provider.body.sessionToken, workspaceId,
    path: "/api/shared-invites/client", method: "POST", body: {}
  });
  assert.equal(replacement.status, 200);
  assert.notEqual(replacement.body.clientToken, workspace.body.inviteToken);
  const oldInvite = await call(db, { action: "account", operation: "join_workspace", sessionToken: client.body.sessionToken, inviteToken: workspace.body.inviteToken });
  assert.equal(oldInvite.status, 404);
  const newInvite = await call(db, { action: "account", operation: "join_workspace", sessionToken: client.body.sessionToken, inviteToken: replacement.body.clientToken });
  assert.equal(newInvite.status, 200);

  const rotated = await call(db, { action: "account", operation: "rotate_key", sessionToken: provider.body.sessionToken });
  assert.equal(rotated.status, 200);
  assert.match(rotated.body.accountKey, /^[a-f0-9]{64}$/);
  const oldKey = await call(db, { action: "account", operation: "login", handle: provider.body.account.handle, accountKey: provider.body.accountKey });
  assert.equal(oldKey.status, 401);
  const newKey = await call(db, { action: "account", operation: "login", handle: provider.body.account.handle, accountKey: rotated.body.accountKey });
  assert.equal(newKey.status, 200);
  const revokedOtherSession = await call(db, { action: "account", operation: "session", sessionToken: login.body.sessionToken });
  assert.equal(revokedOtherSession.body.authenticated, false);
  const currentSession = await call(db, { action: "account", operation: "session", sessionToken: provider.body.sessionToken });
  assert.equal(currentSession.body.authenticated, true);
});
