import {
  addEvidence,
  DomainError,
  proposeChange,
  recordDeliveryReview,
  respondToVersion,
  updateDeliverableProgress
} from "./domain.mjs";
import { createSeedState } from "./demo-data.mjs";
import { findAccountWorkspace, handleAccountAction } from "./accounts.mjs";

const INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ACTIVE_SHARES = 128;
const MAX_REQUEST_BYTES = 1_700_000;
const MAX_STATE_BYTES = 1_600_000;
const createBuckets = new Map();
const requestBuckets = new Map();
const encoder = new TextEncoder();

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer"
    }
  });
}

function fail(message, status = 400) {
  throw new DomainError(message, status);
}

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function newToken() {
  return hex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

async function tokenHash(token) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(token));
  return hex(new Uint8Array(digest));
}

function createRateLimit(request, nowMs) {
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-pact-client-ip") || "unknown";
  const prior = createBuckets.get(ip);
  if (!prior || nowMs - prior.startedAt >= 60 * 60 * 1000) {
    createBuckets.set(ip, { startedAt: nowMs, count: 1 });
    while (createBuckets.size > 1000) createBuckets.delete(createBuckets.keys().next().value);
    return true;
  }
  if (prior.count >= 5) return false;
  prior.count += 1;
  return true;
}

function allowSharedRequest(request, payload, nowMs) {
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-pact-client-ip") || "unknown";
  const tokenKey = /^[a-f0-9]{64}$/.test(String(payload.token || "")) ? `invite:${payload.token.slice(0, 20)}` : null;
  const keys = [`ip:${ip}`, ...(tokenKey ? [tokenKey] : [])];
  for (const key of keys) {
    const current = requestBuckets.get(key);
    if (current && nowMs - current.startedAt < 60_000 && current.count >= (key.startsWith("invite:") ? 60 : 120)) return false;
  }
  for (const key of keys) {
    const current = requestBuckets.get(key);
    if (!current || nowMs - current.startedAt >= 60_000) requestBuckets.set(key, { startedAt: nowMs, count: 1 });
    else current.count += 1;
  }
  while (requestBuckets.size > 5000) requestBuckets.delete(requestBuckets.keys().next().value);
  return true;
}

function cleanState(state) {
  const copy = structuredClone(state);
  for (const engagement of copy.engagements || []) {
    if (engagement.payment?.requestIds) delete engagement.payment.requestIds;
    if (engagement.payment?.quoteToken) delete engagement.payment.quoteToken;
  }
  return copy;
}

function cleanResult(value) {
  if (Array.isArray(value)) return value.map(cleanResult);
  if (!value || typeof value !== "object") return value;
  const copy = structuredClone(value);
  if (copy.payment?.requestIds) delete copy.payment.requestIds;
  if (copy.payment?.quoteToken) delete copy.payment.quoteToken;
  if (copy.engagement?.payment?.requestIds) delete copy.engagement.payment.requestIds;
  if (copy.engagement?.payment?.quoteToken) delete copy.engagement.payment.quoteToken;
  return copy;
}

function demoSeed() {
  const state = createSeedState();
  if (state.engagements.length !== 1 || state.engagements[0]?.id !== "demo-pact-01") {
    throw new Error("The fictional demo seed no longer matches the shared-data boundary.");
  }
  const engagement = state.engagements[0];
  engagement.payment = {
    status: "not_started",
    provider: "paypal_sandbox",
    orderId: null,
    captureId: null,
    amountMinor: null,
    currency: "USD",
    updatedAt: null
  };
  return state;
}

async function createSharedDemo(request, env, now, payload) {
  if (payload?.fictionalConfirmed !== true) fail("Confirm that this is fictional demo data before creating invite links.", 400);
  const nowMs = now.getTime();
  if (!createRateLimit(request, nowMs)) fail("Too many demo invite sets were created from this network. Try again later.", 429);
  const id = globalThis.crypto.randomUUID();
  const providerToken = newToken();
  const clientToken = newToken();
  const createdAt = now.toISOString();
  const expiresAt = new Date(nowMs + INVITE_TTL_MS).toISOString();
  const stateJson = JSON.stringify(demoSeed());
  const results = await env.PACT_DB.batch([
    env.PACT_DB.prepare("DELETE FROM shared_invites WHERE expires_at <= ?").bind(createdAt),
    env.PACT_DB.prepare("DELETE FROM shared_workspaces WHERE expires_at <= ?").bind(createdAt),
    env.PACT_DB.prepare("INSERT INTO shared_workspaces (id, state_json, revision, created_at, updated_at, expires_at) SELECT ?, ?, 1, ?, ?, ? WHERE (SELECT COUNT(*) FROM shared_workspaces WHERE expires_at > ?) < ?").bind(id, stateJson, createdAt, createdAt, expiresAt, createdAt, MAX_ACTIVE_SHARES),
    env.PACT_DB.prepare("INSERT INTO shared_invites (token_hash, workspace_id, role, created_at, expires_at) SELECT ?, ?, 'provider', ?, ? WHERE EXISTS (SELECT 1 FROM shared_workspaces WHERE id = ?)").bind(await tokenHash(providerToken), id, createdAt, expiresAt, id),
    env.PACT_DB.prepare("INSERT INTO shared_invites (token_hash, workspace_id, role, created_at, expires_at) SELECT ?, ?, 'client', ?, ? WHERE EXISTS (SELECT 1 FROM shared_workspaces WHERE id = ?)").bind(await tokenHash(clientToken), id, createdAt, expiresAt, id)
  ]);
  if (Number(results[2]?.meta?.changes ?? 0) !== 1) fail("The shared demo has reached its free-tier active-record cap. Expired shares will be cleaned up when a new share is created.", 429);
  return json({ providerToken, clientToken, expiresAt, demoOnly: true });
}

async function findInvite(env, token, nowText) {
  const hashed = await tokenHash(token);
  return env.PACT_DB.prepare(`
    SELECT i.workspace_id, i.role, i.expires_at AS invite_expires_at,
      w.state_json, w.revision, w.expires_at AS workspace_expires_at
    FROM shared_invites i
    INNER JOIN shared_workspaces w ON w.id = i.workspace_id
    WHERE i.token_hash = ? AND i.expires_at > ? AND w.expires_at > ?
    LIMIT 1
  `).bind(hashed, nowText, nowText).first();
}

function scopedState(row, storage = "shared_d1") {
  const state = cleanState(JSON.parse(row.state_json));
  return {
    ...state,
    demoOnly: true,
    config: {
      publicDemo: true,
      storage,
      sharedRole: row.role,
      inviteExpiresAt: row.invite_expires_at || row.workspace_expires_at,
      accountAuthenticated: storage === "account_d1",
      paypal: { configured: false, environment: "sandbox" }
    }
  };
}

async function runScopedRequest(request, env, payload, now, accountContext = null) {
  const nowText = now.toISOString();
  let row;
  if (accountContext) {
    row = await findAccountWorkspace(env, accountContext.accountId, payload.workspaceId, nowText);
    if (!row) fail("This account is not a member of the requested demo workspace, or it has expired.", 404);
  } else {
    const token = String(payload.token || "");
    if (!/^[a-f0-9]{64}$/.test(token)) fail("This shared demo invite link is missing or invalid.", 404);
    row = await findInvite(env, token, nowText);
    if (!row) fail("This shared demo invite has expired or is invalid.", 404);
  }

  const method = String(payload.method || "GET").toUpperCase();
  const pathname = new URL(String(payload.path || "/"), "https://pact.invalid").pathname;
  if (method === "GET" && pathname === "/api/state") return json(scopedState(row, accountContext ? "account_d1" : "shared_d1"));
  if (method !== "POST") fail("Only shared demo update requests are supported.", 405);

  const state = JSON.parse(row.state_json);
  if (!Array.isArray(state.engagements) || state.engagements.length !== 1 || state.engagements[0]?.id !== "demo-pact-01") {
    fail("This shared record is outside the fictional demo boundary.", 409);
  }
  const role = row.role;
  if (pathname === "/api/shared-invites/client") {
    if (role !== "provider") fail("Only the Provider invite can replace the Client invite.", 403);
    if (accountContext) {
      const replacementToken = newToken();
      const replacementHash = await tokenHash(replacementToken);
      const results = await env.PACT_DB.batch([
        env.PACT_DB.prepare(`
          DELETE FROM demo_workspace_invites WHERE workspace_id = ? AND expires_at <= ?
        `).bind(row.workspace_id, nowText),
        env.PACT_DB.prepare(`
        UPDATE demo_workspace_invites
        SET token_hash = ?, created_at = ?
        WHERE workspace_id = ? AND created_by = ? AND role = 'client' AND expires_at > ?
        `).bind(replacementHash, nowText, row.workspace_id, accountContext.accountId, nowText),
        env.PACT_DB.prepare(`
          INSERT INTO demo_workspace_invites (workspace_id, token_hash, role, created_by, created_at, expires_at)
          SELECT ?, ?, 'client', ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM shared_workspaces WHERE id = ? AND expires_at > ?)
            AND EXISTS (SELECT 1 FROM demo_workspace_memberships WHERE workspace_id = ? AND account_id = ? AND role = 'provider')
            AND NOT EXISTS (SELECT 1 FROM demo_workspace_memberships WHERE workspace_id = ? AND role = 'client')
            AND NOT EXISTS (SELECT 1 FROM demo_workspace_invites WHERE workspace_id = ?)
        `).bind(row.workspace_id, replacementHash, accountContext.accountId, nowText, row.workspace_expires_at, row.workspace_id, nowText, row.workspace_id, accountContext.accountId, row.workspace_id, row.workspace_id)
      ]);
      if (Number(results[1]?.meta?.changes ?? 0) + Number(results[2]?.meta?.changes ?? 0) !== 1) {
        fail("A Client is already a member, or the invitation changed at the same time. Create a new fictional demo workspace if needed.", 409);
      }
      return json({ role: "client", clientToken: replacementToken, expiresAt: row.workspace_expires_at, replaced: true });
    }
    const clientInvite = await env.PACT_DB.prepare(`
      SELECT token_hash FROM shared_invites
      WHERE workspace_id = ? AND role = 'client' AND expires_at > ?
      LIMIT 1
    `).bind(row.workspace_id, nowText).first();
    if (!clientInvite) fail("The Client invite is no longer active. Create a new fictional demo share instead.", 409);
    const replacementToken = newToken();
    const replacementHash = await tokenHash(replacementToken);
    const update = await env.PACT_DB.prepare(`
      UPDATE shared_invites
      SET token_hash = ?
      WHERE token_hash = ? AND workspace_id = ? AND role = 'client' AND expires_at > ?
    `).bind(replacementHash, clientInvite.token_hash, row.workspace_id, nowText).run();
    const changes = Number(update?.meta?.changes ?? update?.changes ?? 0);
    if (changes !== 1) fail("The Client invite changed at the same time. Refresh and retry.", 409);
    return json({ role: "client", clientToken: replacementToken, expiresAt: row.invite_expires_at, replaced: true });
  }
  const changeMatch = pathname.match(/^\/api\/engagements\/([^/]+)\/changes$/);
  const respondMatch = pathname.match(/^\/api\/engagements\/([^/]+)\/respond$/);
  const evidenceMatch = pathname.match(/^\/api\/engagements\/([^/]+)\/evidence$/);
  const progressMatch = pathname.match(/^\/api\/engagements\/([^/]+)\/progress$/);
  const reviewMatch = pathname.match(/^\/api\/engagements\/([^/]+)\/review$/);
  const idMatch = changeMatch || respondMatch || evidenceMatch || progressMatch || reviewMatch;
  if (!idMatch || decodeURIComponent(idMatch[1]) !== "demo-pact-01") {
    fail("This shared invite is limited to the built-in fictional sample agreement. Creation, deletion, and payment are disabled.", 403);
  }
  const input = payload.body && typeof payload.body === "object" && !Array.isArray(payload.body) ? payload.body : {};
  let result;
  if (changeMatch) {
    result = { version: proposeChange(state, "demo-pact-01", input, role) };
  } else if (respondMatch) {
    result = respondToVersion(state, "demo-pact-01", input.versionId, role, input.action, input.comment);
  } else if (evidenceMatch) {
    result = { evidence: addEvidence(state, "demo-pact-01", input, role) };
  } else if (progressMatch) {
    result = { event: updateDeliverableProgress(state, "demo-pact-01", input, role) };
  } else {
    result = { event: recordDeliveryReview(state, "demo-pact-01", input, role) };
  }

  const savedState = JSON.stringify(state);
  if (encoder.encode(savedState).byteLength > MAX_STATE_BYTES) fail("This fictional demo record has reached its storage limit. Export locally and reduce attachments before retrying.", 413);
  const update = await env.PACT_DB.prepare(`
    UPDATE shared_workspaces
    SET state_json = ?, revision = revision + 1, updated_at = ?
    WHERE id = ? AND revision = ? AND expires_at > ?
  `).bind(savedState, nowText, row.workspace_id, row.revision, nowText).run();
  const changes = Number(update?.meta?.changes ?? update?.changes ?? 0);
  if (changes !== 1) fail("Another participant updated this demo at the same time. Refresh the page and retry.", 409);
  return json(cleanResult(result));
}

export async function handleSharedRequest(request, env, { now: nowSource = () => new Date() } = {}) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    try {
      const value = await env.PACT_DB.prepare("SELECT 1 AS ok").first();
      return json({ ok: value?.ok === 1, storage: "d1", demoOnly: true }, value?.ok === 1 ? 200 : 503);
    } catch {
      return json({ error: "Shared demo storage is temporarily unavailable." }, 503);
    }
  }
  if (request.method !== "POST" || url.pathname !== "/") return json({ error: "Use POST on the shared demo API." }, 405);
  let raw;
  try { raw = await request.text(); }
  catch { return json({ error: "Request body could not be read." }, 400); }
  if (encoder.encode(raw).byteLength > MAX_REQUEST_BYTES) return json({ error: "Request body is too large." }, 413);
  let payload;
  try { payload = JSON.parse(raw || "{}"); }
  catch { return json({ error: "Request body must be valid JSON." }, 400); }
  if (!payload || Array.isArray(payload) || typeof payload !== "object") return json({ error: "Request body must be a JSON object." }, 400);
  if (!env?.PACT_DB) return json({ error: "Shared demo storage is not configured." }, 503);
  const now = nowSource();
  if (!allowSharedRequest(request, payload, now.getTime())) return json({ error: "Shared demo request limit reached. Wait a minute and retry." }, 429);
  try {
    if (payload.action === "create") return await createSharedDemo(request, env, now, payload);
    if (payload.action === "request") return await runScopedRequest(request, env, payload, now);
    if (payload.action === "account") {
      return await handleAccountAction(request, env, payload, now, {
        json,
        demoSeed,
        runWorkspaceRequest: (accountContext, accountPayload) => runScopedRequest(request, env, accountPayload, now, accountContext)
      });
    }
    return json({ error: "Unknown shared demo operation." }, 404);
  } catch (error) {
    if (error instanceof DomainError) return json({ error: error.message }, error.status || 400);
    return json({ error: "Shared D1 storage is temporarily unavailable. If the free-tier daily limit was reached, retry after 00:00 UTC; no paid service is enabled." }, 503);
  }
}

export default { fetch: handleSharedRequest };
