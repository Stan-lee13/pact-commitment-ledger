import { DomainError } from "./domain.mjs";

const ACCOUNT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const WORKSPACE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ACTIVE_ACCOUNTS = 128;
const MAX_ACTIVE_WORKSPACES = 128;
const MAX_WORKSPACES_PER_ACCOUNT = 3;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const accountRateBuckets = new Map();
const encoder = new TextEncoder();

function fail(message, status = 400) {
  throw new DomainError(message, status);
}

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function newToken() {
  return hex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

async function hashToken(token) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(token));
  return hex(new Uint8Array(digest));
}

function changes(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

function accountRateLimit(request, operation, identity, nowMs) {
  const ip = request.headers.get("x-pact-client-ip") || request.headers.get("cf-connecting-ip") || "unknown";
  const keys = [`ip:${ip}:${operation}`];
  if (operation === "login" && identity) keys.push(`handle:${identity}`);
  const limit = (key) => key.startsWith("handle:") ? 5 : operation === "register" ? 4 : 20;
  const windowMs = operation === "register" ? 60 * 60 * 1000 : keyForWindow(keys[0]);
  for (const key of keys) {
    const current = accountRateBuckets.get(key);
    const bucketWindow = key.startsWith("handle:") ? 10 * 60 * 1000 : windowMs;
    if (current && nowMs - current.startedAt < bucketWindow && current.count >= limit(key)) return false;
  }
  for (const key of keys) {
    const bucketWindow = key.startsWith("handle:") ? 10 * 60 * 1000 : windowMs;
    const current = accountRateBuckets.get(key);
    if (!current || nowMs - current.startedAt >= bucketWindow) accountRateBuckets.set(key, { startedAt: nowMs, count: 1 });
    else current.count += 1;
  }
  while (accountRateBuckets.size > 2000) accountRateBuckets.delete(accountRateBuckets.keys().next().value);
  return true;
}

function keyForWindow() {
  return 60 * 1000;
}

async function findSessionAccount(env, sessionToken, nowText) {
  if (!TOKEN_PATTERN.test(String(sessionToken || ""))) return null;
  const hashed = await hashToken(sessionToken);
  return env.PACT_DB.prepare(`
    SELECT a.id, a.handle, a.expires_at AS account_expires_at, s.token_hash AS session_hash
    FROM demo_sessions s
    INNER JOIN demo_accounts a ON a.id = s.account_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND a.expires_at > ?
    LIMIT 1
  `).bind(hashed, nowText, nowText).first();
}

export async function findAccountWorkspace(env, accountId, workspaceId, nowText) {
  if (!accountId || !/^[a-f0-9-]{36}$/i.test(String(workspaceId || ""))) return null;
  return env.PACT_DB.prepare(`
    SELECT m.workspace_id, m.role, w.state_json, w.revision,
      w.expires_at AS workspace_expires_at
    FROM demo_workspace_memberships m
    INNER JOIN shared_workspaces w ON w.id = m.workspace_id
    WHERE m.account_id = ? AND m.workspace_id = ? AND w.expires_at > ?
    LIMIT 1
  `).bind(accountId, workspaceId, nowText).first();
}

async function listWorkspaces(env, accountId, nowText) {
  const result = await env.PACT_DB.prepare(`
    SELECT m.workspace_id AS id, m.role, w.expires_at AS expiresAt
    FROM demo_workspace_memberships m
    INNER JOIN shared_workspaces w ON w.id = m.workspace_id
    WHERE m.account_id = ? AND w.expires_at > ?
    ORDER BY w.created_at DESC
  `).bind(accountId, nowText).all();
  return (result?.results || []).map((item) => ({ id: item.id, role: item.role, expiresAt: item.expiresAt }));
}

async function issueSession(env, account, now) {
  const sessionToken = newToken();
  const createdAt = now.toISOString();
  const sessionExpiresAt = new Date(Math.min(now.getTime() + SESSION_TTL_MS, Date.parse(account.account_expires_at))).toISOString();
  await env.PACT_DB.prepare(`
    INSERT INTO demo_sessions (token_hash, account_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).bind(await hashToken(sessionToken), account.id, createdAt, sessionExpiresAt).run();
  return { sessionToken, account: { handle: account.handle, expiresAt: account.account_expires_at }, sessionExpiresAt };
}

function cleanupStatements(db, nowText) {
  return [
    db.prepare("DELETE FROM shared_invites WHERE expires_at <= ?").bind(nowText),
    db.prepare("DELETE FROM demo_workspace_invites WHERE expires_at <= ? OR workspace_id IN (SELECT id FROM shared_workspaces WHERE expires_at <= ?) OR created_by IN (SELECT id FROM demo_accounts WHERE expires_at <= ?)").bind(nowText, nowText, nowText),
    db.prepare("DELETE FROM demo_workspace_memberships WHERE workspace_id IN (SELECT id FROM shared_workspaces WHERE expires_at <= ?) OR account_id IN (SELECT id FROM demo_accounts WHERE expires_at <= ?)").bind(nowText, nowText),
    db.prepare("DELETE FROM demo_sessions WHERE expires_at <= ? OR account_id IN (SELECT id FROM demo_accounts WHERE expires_at <= ?)").bind(nowText, nowText),
    db.prepare("DELETE FROM shared_workspaces WHERE expires_at <= ?").bind(nowText),
    db.prepare("DELETE FROM demo_accounts WHERE expires_at <= ?").bind(nowText)
  ];
}

async function registerAccount(request, env, payload, now) {
  if (payload.fictionalConfirmed !== true) fail("Confirm that this account is only for fictional demo use.", 400);
  if (!accountRateLimit(request, "register", "", now.getTime())) fail("Too many demo account registrations from this network. Try again later.", 429);
  const id = globalThis.crypto.randomUUID();
  const handle = `pact-${id.replaceAll("-", "").slice(0, 12)}`;
  const accountKey = newToken();
  const sessionToken = newToken();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ACCOUNT_TTL_MS).toISOString();
  const sessionExpiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  const results = await env.PACT_DB.batch([
    ...cleanupStatements(env.PACT_DB, createdAt),
    env.PACT_DB.prepare(`
      INSERT INTO demo_accounts (id, handle, account_key_hash, created_at, expires_at)
      SELECT ?, ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM demo_accounts WHERE expires_at > ?) < ?
    `).bind(id, handle, await hashToken(accountKey), createdAt, expiresAt, createdAt, MAX_ACTIVE_ACCOUNTS),
    env.PACT_DB.prepare(`
      INSERT INTO demo_sessions (token_hash, account_id, created_at, expires_at)
      SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM demo_accounts WHERE id = ?)
    `).bind(await hashToken(sessionToken), id, createdAt, sessionExpiresAt, id)
  ]);
  if (changes(results[6]) !== 1) fail("The free demo account limit has been reached. Expired demo accounts are cleaned up during registration.", 429);
  if (changes(results[7]) !== 1) fail("The demo account could not start a session. Try again.", 503);
  return { account: { id, handle, expiresAt }, sessionToken, sessionExpiresAt, accountKey, demoOnly: true };
}

async function loginAccount(request, env, payload, now) {
  const handle = String(payload.handle || "").trim().toLowerCase();
  const accountKey = String(payload.accountKey || "");
  if (!accountRateLimit(request, "login", handle, now.getTime())) fail("Too many sign-in attempts. Wait a few minutes and try again.", 429);
  if (!/^pact-[a-f0-9]{12}$/.test(handle) || !TOKEN_PATTERN.test(accountKey)) fail("Account handle or key is not valid.", 401);
  const nowText = now.toISOString();
  const account = await env.PACT_DB.prepare(`
    SELECT id, handle, account_key_hash, expires_at AS account_expires_at
    FROM demo_accounts
    WHERE handle = ? AND expires_at > ?
    LIMIT 1
  `).bind(handle, nowText).first();
  const suppliedHash = await hashToken(accountKey);
  if (!account || account.account_key_hash !== suppliedHash) fail("Account handle or key is not valid.", 401);
  const session = await issueSession(env, account, now);
  return { ...session, demoOnly: true };
}

async function accountForSession(request, env, payload, now) {
  const account = await findSessionAccount(env, payload.sessionToken, now.toISOString());
  if (!account) return null;
  return account;
}

async function createWorkspace(env, account, now, demoSeed) {
  const id = globalThis.crypto.randomUUID();
  const clientInviteToken = newToken();
  const inviteHash = await hashToken(clientInviteToken);
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + WORKSPACE_TTL_MS).toISOString();
  const stateJson = JSON.stringify(demoSeed());
  const results = await env.PACT_DB.batch([
    ...cleanupStatements(env.PACT_DB, createdAt),
    env.PACT_DB.prepare(`
      INSERT INTO shared_workspaces (id, state_json, revision, created_at, updated_at, expires_at)
      SELECT ?, ?, 1, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM shared_workspaces WHERE expires_at > ?) < ?
        AND (SELECT COUNT(*) FROM demo_workspace_memberships m
          INNER JOIN shared_workspaces w ON w.id = m.workspace_id
          WHERE m.account_id = ? AND w.expires_at > ?) < ?
    `).bind(id, stateJson, createdAt, createdAt, expiresAt, createdAt, MAX_ACTIVE_WORKSPACES, account.id, createdAt, MAX_WORKSPACES_PER_ACCOUNT),
    env.PACT_DB.prepare(`
      INSERT INTO demo_workspace_memberships (workspace_id, account_id, role, created_at)
      SELECT ?, ?, 'provider', ? WHERE EXISTS (
        SELECT 1 FROM shared_workspaces WHERE id = ? AND expires_at > ?
      ) AND EXISTS (
        SELECT 1 FROM demo_accounts WHERE id = ? AND expires_at > ?
      )
    `).bind(id, account.id, createdAt, id, createdAt, account.id, createdAt),
    env.PACT_DB.prepare(`
      INSERT INTO demo_workspace_invites (workspace_id, token_hash, role, created_by, created_at, expires_at)
      SELECT ?, ?, 'client', ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM shared_workspaces WHERE id = ? AND expires_at > ?
      ) AND EXISTS (
        SELECT 1 FROM demo_workspace_memberships WHERE workspace_id = ? AND account_id = ? AND role = 'provider'
      )
    `).bind(id, inviteHash, account.id, createdAt, expiresAt, id, createdAt, id, account.id)
  ]);
  if (changes(results[6]) !== 1) fail("The free demo workspace limit has been reached. Use an existing workspace or try again after expired records are cleaned up.", 429);
  if (changes(results[7]) !== 1 || changes(results[8]) !== 1) fail("The fictional demo workspace could not be initialized.", 503);
  return { workspace: { id, role: "provider", expiresAt }, inviteToken: clientInviteToken, demoOnly: true };
}

async function joinWorkspace(env, account, inviteToken, now) {
  if (!TOKEN_PATTERN.test(String(inviteToken || ""))) fail("This workspace invite is missing or invalid.", 404);
  const nowText = now.toISOString();
  const inviteHash = await hashToken(inviteToken);
  const invite = await env.PACT_DB.prepare(`
    SELECT i.workspace_id, i.role, i.expires_at AS invite_expires_at,
      w.expires_at AS workspace_expires_at
    FROM demo_workspace_invites i
    INNER JOIN shared_workspaces w ON w.id = i.workspace_id
    WHERE i.token_hash = ? AND i.expires_at > ? AND w.expires_at > ?
    LIMIT 1
  `).bind(inviteHash, nowText, nowText).first();
  if (!invite || invite.role !== "client") fail("This workspace invite has expired, was already used, or is invalid.", 404);
  const existing = await env.PACT_DB.prepare(`
    SELECT role FROM demo_workspace_memberships WHERE workspace_id = ? AND account_id = ? LIMIT 1
  `).bind(invite.workspace_id, account.id).first();
  if (existing) return { workspace: { id: invite.workspace_id, role: existing.role, expiresAt: invite.workspace_expires_at }, demoOnly: true };
  try {
    const results = await env.PACT_DB.batch([
      env.PACT_DB.prepare(`
        INSERT INTO demo_workspace_memberships (workspace_id, account_id, role, created_at)
        SELECT i.workspace_id, ?, i.role, ?
        FROM demo_workspace_invites i
        INNER JOIN shared_workspaces w ON w.id = i.workspace_id
        WHERE i.token_hash = ? AND i.role = 'client' AND i.expires_at > ? AND w.expires_at > ?
          AND NOT EXISTS (
            SELECT 1 FROM demo_workspace_memberships m
            WHERE m.workspace_id = i.workspace_id AND m.role = i.role
          )
      `).bind(account.id, nowText, inviteHash, nowText, nowText),
      env.PACT_DB.prepare(`
        DELETE FROM demo_workspace_invites
        WHERE token_hash = ? AND EXISTS (
          SELECT 1 FROM demo_workspace_memberships
          WHERE workspace_id = ? AND account_id = ? AND role = 'client'
        )
      `).bind(inviteHash, invite.workspace_id, account.id)
    ]);
    if (changes(results[0]) !== 1 || changes(results[1]) !== 1) fail("This workspace already has a Client account, or the invite was claimed at the same time. Ask the Provider to create a new invite.", 409);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    if (/unique|constraint/i.test(String(error?.message || ""))) fail("This workspace already has a Client account. Ask the Provider to create a new invite.", 409);
    throw error;
  }
  return { workspace: { id: invite.workspace_id, role: "client", expiresAt: invite.workspace_expires_at }, demoOnly: true };
}

async function rotateAccountKey(env, account, now) {
  const accountKey = newToken();
  const results = await env.PACT_DB.batch([
    env.PACT_DB.prepare(`
      UPDATE demo_accounts SET account_key_hash = ? WHERE id = ? AND expires_at > ?
    `).bind(await hashToken(accountKey), account.id, now.toISOString()),
    env.PACT_DB.prepare(`
      DELETE FROM demo_sessions WHERE account_id = ? AND token_hash <> ?
    `).bind(account.id, account.session_hash)
  ]);
  if (changes(results[0]) !== 1) fail("This demo account has expired. Create a new one to continue.", 401);
  return { accountKey, rotated: true, demoOnly: true };
}

export async function handleAccountAction(request, env, payload, now, { json, demoSeed, runWorkspaceRequest }) {
  const operation = String(payload.operation || "");
  if (operation === "register") return json(await registerAccount(request, env, payload, now));
  if (operation === "login") return json(await loginAccount(request, env, payload, now));

  const account = await accountForSession(request, env, payload, now);
  if (operation === "session") {
    if (!account) return json({ authenticated: false, demoOnly: true });
    return json({
      authenticated: true,
      account: { handle: account.handle, expiresAt: account.account_expires_at },
      workspaces: await listWorkspaces(env, account.id, now.toISOString()),
      demoOnly: true
    });
  }
  if (operation === "logout") {
    if (TOKEN_PATTERN.test(String(payload.sessionToken || ""))) {
      await env.PACT_DB.prepare("DELETE FROM demo_sessions WHERE token_hash = ?").bind(await hashToken(payload.sessionToken)).run();
    }
    return json({ loggedOut: true });
  }
  if (!account) fail("Sign in to a pseudonymous demo account to continue.", 401);
  if (operation === "create_workspace") {
    if (payload.fictionalConfirmed !== true) fail("Confirm that this workspace is only for fictional demo use.", 400);
    return json(await createWorkspace(env, account, now, demoSeed));
  }
  if (operation === "join_workspace") return json(await joinWorkspace(env, account, payload.inviteToken, now));
  if (operation === "rotate_key") return json(await rotateAccountKey(env, account, now));
  if (operation === "request") {
    return runWorkspaceRequest({ accountId: account.id, handle: account.handle, sessionHash: account.session_hash }, payload);
  }
  fail("Unknown demo account operation.", 404);
}
