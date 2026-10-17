import test from "node:test";
import assert from "node:assert/strict";
import { handleSharedRequest } from "../cloudflare/worker.mjs";

class MemoryStatement {
  constructor(db, sql) { this.db = db; this.sql = sql.replace(/\s+/g, " ").trim(); this.values = []; }
  bind(...values) { this.values = values; return this; }
  async first() {
    if (this.sql.includes("SELECT 1 AS ok")) return { ok: 1 };
    if (this.sql.startsWith("SELECT i.workspace_id")) {
      const [hash, now1, now2] = this.values;
      const invite = this.db.invites.get(hash);
      const workspace = invite && this.db.workspaces.get(invite.workspace_id);
      if (!invite || !workspace || invite.expires_at <= now1 || workspace.expires_at <= now2) return null;
      return {
        workspace_id: invite.workspace_id,
        role: invite.role,
        invite_expires_at: invite.expires_at,
        state_json: workspace.state_json,
        revision: workspace.revision,
        workspace_expires_at: workspace.expires_at
      };
    }
    if (this.sql.startsWith("SELECT token_hash FROM shared_invites")) {
      const [workspaceId, now] = this.values;
      const invite = [...this.db.invites.values()].find((item) => item.workspace_id === workspaceId && item.role === "client" && item.expires_at > now);
      return invite ? { token_hash: invite.token_hash } : null;
    }
    throw new Error(`Unexpected first() SQL: ${this.sql}`);
  }
  async run() {
    if (this.sql.startsWith("DELETE FROM shared_invites")) {
      const [expiresAt] = this.values;
      for (const [hash, invite] of this.db.invites) if (invite.expires_at <= expiresAt) this.db.invites.delete(hash);
      return { meta: { changes: 0 } };
    }
    if (this.sql.startsWith("DELETE FROM shared_workspaces")) {
      const [expiresAt] = this.values;
      for (const [id, row] of this.db.workspaces) if (row.expires_at <= expiresAt) this.db.workspaces.delete(id);
      return { meta: { changes: 0 } };
    }
    if (this.sql.startsWith("INSERT INTO shared_workspaces")) {
      const [id, state_json, created_at, updated_at, expires_at, activeAt, limit] = this.values;
      if (this.sql.includes("SELECT COUNT(*)")) {
        const active = [...this.db.workspaces.values()].filter((row) => row.expires_at > activeAt).length;
        if (active >= limit) return { meta: { changes: 0 } };
      }
      this.db.workspaces.set(id, { id, state_json, revision: 1, created_at, updated_at, expires_at });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("INSERT INTO shared_invites")) {
      const [token_hash, workspace_id, created_at, expires_at, requiredWorkspace] = this.values;
      if (this.sql.includes("SELECT") && !this.db.workspaces.has(requiredWorkspace)) return { meta: { changes: 0 } };
      const role = this.sql.includes("'provider'") ? "provider" : "client";
      this.db.invites.set(token_hash, { token_hash, workspace_id, role, created_at, expires_at });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("UPDATE shared_invites")) {
      const [token_hash, priorHash, workspace_id, now] = this.values;
      const invite = this.db.invites.get(priorHash);
      if (!invite || invite.workspace_id !== workspace_id || invite.role !== "client" || invite.expires_at <= now) return { meta: { changes: 0 } };
      this.db.invites.delete(priorHash);
      this.db.invites.set(token_hash, { ...invite, token_hash });
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("UPDATE shared_workspaces")) {
      const [state_json, updated_at, id, revision, now] = this.values;
      const row = this.db.workspaces.get(id);
      if (!row || row.revision !== revision || row.expires_at <= now) return { meta: { changes: 0 } };
      row.state_json = state_json;
      row.revision += 1;
      row.updated_at = updated_at;
      return { meta: { changes: 1 } };
    }
    throw new Error(`Unexpected run() SQL: ${this.sql}`);
  }
}

class MemoryD1 {
  workspaces = new Map();
  invites = new Map();
  batchQueue = Promise.resolve();
  prepare(sql) { return new MemoryStatement(this, sql); }
  async batch(statements) {
    const previous = this.batchQueue;
    let release;
    this.batchQueue = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    } finally {
      release();
    }
  }
}

function createRequest(payload, ip = "192.0.2.10") {
  return new Request("https://pact-worker.invalid/", {
    method: "POST",
    headers: { "content-type": "application/json", "x-pact-client-ip": ip },
    body: JSON.stringify(payload)
  });
}

async function call(env, payload, options = {}) {
  const response = await handleSharedRequest(createRequest(payload, options.ip), env, {
    now: () => options.now ? new Date(options.now) : new Date("2026-10-17T00:00:00.000Z")
  });
  return { status: response.status, payload: await response.json() };
}

async function newInvitePair(env, suffix = "a") {
  const created = await call(env, { action: "create", fictionalConfirmed: true, engagement: { title: "must be ignored" } }, { ip: `192.0.2.${suffix}` });
  assert.equal(created.status, 200);
  return created.payload;
}

test("shared invite creation seeds only the built-in fictional agreement and stores token hashes", async () => {
  const db = new MemoryD1();
  const env = { PACT_DB: db };
  const refused = await call(env, { action: "create" }, { ip: "192.0.2.1" });
  assert.equal(refused.status, 400);
  const links = await newInvitePair(env, "11");
  assert.match(links.providerToken, /^[a-f0-9]{64}$/);
  assert.match(links.clientToken, /^[a-f0-9]{64}$/);
  assert.notEqual(links.providerToken, links.clientToken);
  assert.equal(Date.parse(links.expiresAt) - Date.parse("2026-10-17T00:00:00.000Z"), 30 * 24 * 60 * 60 * 1000);
  assert.equal(db.workspaces.size, 1);
  assert.equal(db.invites.size, 2);
  assert.equal(db.invites.has(links.providerToken), false);
  const saved = JSON.parse([...db.workspaces.values()][0].state_json);
  assert.equal(saved.engagements.length, 1);
  assert.equal(saved.engagements[0].id, "demo-pact-01");
  assert.equal(saved.engagements[0].providerName, "Maya Okafor");
  assert.equal(saved.engagements[0].clientName, "Jordan Lee");
  assert.equal(saved.engagements[0].payment.status, "not_started");
  assert.equal(saved.engagements[0].payment.orderId, null);
});

test("invite tokens return a role-locked record and allow shared version updates without accepting a spoofed role", async () => {
  const db = new MemoryD1();
  const env = { PACT_DB: db };
  const links = await newInvitePair(env, "12");
  const loadedProvider = await call(env, { action: "request", token: links.providerToken, path: "/api/state", method: "GET" });
  assert.equal(loadedProvider.status, 200);
  assert.equal(loadedProvider.payload.config.storage, "shared_d1");
  assert.equal(loadedProvider.payload.config.sharedRole, "provider");
  assert.equal(loadedProvider.payload.config.paypal.configured, false);
  assert.equal(loadedProvider.payload.engagements.length, 1);
  assert.equal(loadedProvider.payload.engagements[0].payment.requestIds, undefined);

  const acceptSeedVersion = await call(env, {
    action: "request", token: links.clientToken, path: "/api/engagements/demo-pact-01/respond", method: "POST",
    body: { role: "client", versionId: "demo-v2", action: "accept" }
  });
  assert.equal(acceptSeedVersion.status, 200);
  const proposed = await call(env, {
    action: "request", token: links.providerToken, path: "/api/engagements/demo-pact-01/changes", method: "POST",
    body: { role: "client", baseVersionId: "demo-v2", changeSummary: "Fictional shared demo change", terms: { dueDate: "2026-11-24" } }
  });
  assert.equal(proposed.status, 200);
  const versionId = proposed.payload.version.id;
  const wrongActor = await call(env, {
    action: "request", token: links.providerToken, path: "/api/engagements/demo-pact-01/respond", method: "POST",
    body: { role: "client", versionId, action: "accept" }
  });
  assert.equal(wrongActor.status, 403);

  const clientResponse = await call(env, {
    action: "request", token: links.clientToken, path: "/api/engagements/demo-pact-01/respond", method: "POST",
    body: { role: "provider", versionId, action: "accept" }
  });
  assert.equal(clientResponse.status, 200);
  const loadedClient = await call(env, { action: "request", token: links.clientToken, path: "/api/state", method: "GET" });
  assert.equal(loadedClient.payload.config.sharedRole, "client");
  assert.equal(loadedClient.payload.engagements[0].currentVersionId, versionId);
  assert.equal(db.workspaces.values().next().value.revision, 4);
});

test("provider can replace the Client invite without extending expiry; old link stops working", async () => {
  const db = new MemoryD1();
  const env = { PACT_DB: db };
  const links = await newInvitePair(env, "31");
  const denied = await call(env, {
    action: "request", token: links.clientToken, path: "/api/shared-invites/client", method: "POST", body: {}
  });
  assert.equal(denied.status, 403);

  const rotated = await call(env, {
    action: "request", token: links.providerToken, path: "/api/shared-invites/client", method: "POST", body: {}
  });
  assert.equal(rotated.status, 200);
  assert.equal(rotated.payload.role, "client");
  assert.equal(rotated.payload.replaced, true);
  assert.match(rotated.payload.clientToken, /^[a-f0-9]{64}$/);
  assert.notEqual(rotated.payload.clientToken, links.clientToken);
  assert.equal(rotated.payload.expiresAt, links.expiresAt);
  assert.equal(db.invites.size, 2);

  const priorLink = await call(env, { action: "request", token: links.clientToken, path: "/api/state", method: "GET" });
  assert.equal(priorLink.status, 404);
  const replacementLink = await call(env, { action: "request", token: rotated.payload.clientToken, path: "/api/state", method: "GET" });
  assert.equal(replacementLink.status, 200);
  assert.equal(replacementLink.payload.config.sharedRole, "client");
  const providerLink = await call(env, { action: "request", token: links.providerToken, path: "/api/state", method: "GET" });
  assert.equal(providerLink.status, 200);
});

test("concurrent Client invite rotations return one link and one refresh conflict", async () => {
  const db = new MemoryD1();
  const env = { PACT_DB: db };
  const links = await newInvitePair(env, "32");
  const rotations = await Promise.all([
    call(env, { action: "request", token: links.providerToken, path: "/api/shared-invites/client", method: "POST", body: {} }),
    call(env, { action: "request", token: links.providerToken, path: "/api/shared-invites/client", method: "POST", body: {} })
  ]);
  assert.deepEqual(rotations.map((item) => item.status).sort(), [200, 409]);
  const winner = rotations.find((item) => item.status === 200);
  assert.match(winner.payload.clientToken, /^[a-f0-9]{64}$/);
  assert.equal(db.invites.size, 2);
  const replacement = await call(env, { action: "request", token: winner.payload.clientToken, path: "/api/state", method: "GET" });
  assert.equal(replacement.status, 200);
  assert.equal(replacement.payload.config.sharedRole, "client");
});

test("shared mode rejects create, delete, and every PayPal route", async () => {
  const db = new MemoryD1();
  const env = { PACT_DB: db };
  const links = await newInvitePair(env, "13");
  const denied = await Promise.all([
    call(env, { action: "request", token: links.providerToken, path: "/api/engagements", method: "POST", body: {} }),
    call(env, { action: "request", token: links.providerToken, path: "/api/engagements/demo-pact-01", method: "DELETE", body: { role: "provider" } }),
    call(env, { action: "request", token: links.clientToken, path: "/api/paypal/orders", method: "POST", body: { role: "client" } })
  ]);
  assert.deepEqual(denied.map((item) => item.status), [403, 405, 403]);
  assert.equal(db.workspaces.values().next().value.revision, 1);
});

test("shared invite tokens expire and invalid tokens reveal no record", async () => {
  const db = new MemoryD1();
  const env = { PACT_DB: db };
  const links = await newInvitePair(env, "14");
  const expired = await call(env, { action: "request", token: links.providerToken, path: "/api/state", method: "GET" }, { now: "2026-11-17T00:00:00.001Z" });
  assert.equal(expired.status, 404);
  const invalid = await call(env, { action: "request", token: "0".repeat(64), path: "/api/state", method: "GET" }, { ip: "192.0.2.15" });
  assert.equal(invalid.status, 404);
  assert.equal(invalid.payload.engagements, undefined);
});

test("active shared demo records are capped before another workspace can be created", async () => {
  const db = new MemoryD1();
  for (let i = 0; i < 128; i += 1) {
    const id = `active-${i}`;
    db.workspaces.set(id, { id, state_json: "{}", revision: 1, created_at: "2026-10-17T00:00:00.000Z", updated_at: "2026-10-17T00:00:00.000Z", expires_at: "2026-12-01T00:00:00.000Z" });
  }
  const result = await call({ PACT_DB: db }, { action: "create", fictionalConfirmed: true }, { ip: "192.0.2.16" });
  assert.equal(result.status, 429);
  assert.equal(db.workspaces.size, 128);
  assert.equal(db.invites.size, 0);
});

test("concurrent share creations cannot exceed the atomic active-record cap", async () => {
  const db = new MemoryD1();
  for (let i = 0; i < 127; i += 1) {
    const id = `active-${i}`;
    db.workspaces.set(id, { id, state_json: "{}", revision: 1, created_at: "2026-10-17T00:00:00.000Z", updated_at: "2026-10-17T00:00:00.000Z", expires_at: "2026-12-01T00:00:00.000Z" });
  }
  const env = { PACT_DB: db };
  const results = await Promise.all([
    call(env, { action: "create", fictionalConfirmed: true }, { ip: "192.0.2.21" }),
    call(env, { action: "create", fictionalConfirmed: true }, { ip: "192.0.2.22" })
  ]);
  assert.deepEqual(results.map((item) => item.status).sort(), [200, 429]);
  assert.equal(db.workspaces.size, 128);
  assert.equal(db.invites.size, 2);
});

test("Worker health check confirms the D1 binding without exposing data", async () => {
  const db = new MemoryD1();
  const response = await handleSharedRequest(new Request("https://pact-worker.invalid/health"), { PACT_DB: db });
  assert.deepEqual(await response.json(), { ok: true, storage: "d1", demoOnly: true });
});
