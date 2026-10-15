import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSeedState } from "../src/demo-data.mjs";
import { createLocalDemoApi, PUBLIC_DEMO_STORAGE_KEY } from "../public/local-demo.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function createHarness() {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  return { api: createLocalDemoApi({ initialState: createSeedState(), storage }), storage };
}

const post = (api, route, body) => api(route, { method: "POST", body: JSON.stringify(body) });

test("public demo is explicitly isolated and disables AI and PayPal", async () => {
  const { api } = createHarness();
  const state = await api("/api/state");
  assert.equal(state.config.publicDemo, true);
  assert.equal(state.config.storage, "browser_local");
  assert.equal(state.config.ai.enabled, false);
  assert.equal(state.config.paypal.configured, false);
  assert.equal(state.engagements[0].id, "demo-pact-01");
});

test("browser demo persists versioned agreement changes without altering its seed copy", async () => {
  const { api, storage } = createHarness();
  const initial = await api("/api/state");
  const result = await post(api, "/api/engagements", {
    role: "provider", title: "Synthetic test", providerName: "Ari", clientName: "Sam",
    terms: { deliverables: ["Prototype screen"], amountMinor: 85000, depositMinor: 42500, currency: "USD" }
  });
  const agreement = result.engagement;
  assert.equal(agreement.currentVersionId, null);
  assert.ok(storage.getItem(PUBLIC_DEMO_STORAGE_KEY));

  await post(api, `/api/engagements/${agreement.id}/respond`, {
    role: "client", versionId: agreement.versions[0].id, action: "accept"
  });
  const after = await api("/api/state");
  assert.equal(after.engagements.find((item) => item.id === agreement.id).status, "accepted");
  assert.equal(initial.engagements.length, 1);
  assert.equal(after.engagements.length, 2);
});

test("browser demo records partial completion, bounded attachments, and multiple agreements", async () => {
  const { api } = createHarness();
  const first = (await api("/api/state")).engagements[0];
  await post(api, `/api/engagements/${first.id}/progress`, {
    role: "provider", versionId: "demo-v1", deliverableIndex: 0, status: "in_progress"
  });
  await post(api, `/api/engagements/${first.id}/evidence`, {
    role: "client", description: "Synthetic review note", attachment: {
      name: "note.txt", type: "text/plain", size: 5, dataUrl: "data:text/plain;base64,SGVsbG8="
    }
  });
  const second = await post(api, "/api/engagements", {
    role: "provider", title: "Second synthetic project", providerName: "Ari", clientName: "Sam",
    terms: { deliverables: ["One prototype screen"] }
  });
  const state = await api("/api/state");
  const saved = state.engagements.find((item) => item.id === first.id);
  assert.equal(saved.events.find((item) => item.type === "deliverable_progress_updated")?.status, "in_progress");
  assert.equal(saved.evidence[0].attachment.dataUrl, "data:text/plain;base64,SGVsbG8=");
  assert.equal(state.engagements.length, 2);
  assert.ok(state.engagements.some((item) => item.id === second.engagement.id));
});

test("browser demo reports local storage quota errors without losing state silently", async () => {
  const storage = {
    getItem: () => null,
    setItem: () => { throw Object.assign(new Error("full"), { name: "QuotaExceededError" }); }
  };
  const api = createLocalDemoApi({ initialState: createSeedState(), storage });
  await assert.rejects(post(api, "/api/engagements", {
    role: "provider", title: "Quota test", providerName: "Ari", clientName: "Sam", terms: { deliverables: ["Prototype"] }
  }), /Browser demo storage is full/);
});

test("concurrent browser-local writes are serialized without dropping an agreement", async () => {
  const { api } = createHarness();
  const create = (title) => post(api, "/api/engagements", {
    role: "provider", title, providerName: "Ari", clientName: "Sam",
    terms: { deliverables: ["Synthetic deliverable"] }
  });
  const [first, second] = await Promise.all([create("Concurrent A"), create("Concurrent B")]);
  const state = await api("/api/state");
  assert.equal(state.engagements.length, 3);
  assert.ok(state.engagements.some((item) => item.id === first.engagement.id));
  assert.ok(state.engagements.some((item) => item.id === second.engagement.id));
});

test("the public demo rejects invalid role changes, malformed values, and payment attempts", async () => {
  const { api } = createHarness();
  await assert.rejects(post(api, "/api/engagements", {
    role: "client", title: "No", providerName: "Ari", clientName: "Sam", terms: { deliverables: ["x"] }
  }), /Only the provider/);
  await assert.rejects(post(api, "/api/engagements", {
    role: "provider", title: "No", providerName: "Ari", clientName: "Sam", terms: { deliverables: ["x"], depositMinor: 10, amountMinor: 5 }
  }), /Deposit cannot exceed/);
  await assert.rejects(post(api, "/api/paypal/orders", { role: "client", engagementId: "demo-pact-01" }), /disabled in the public demo/);
  await assert.rejects(post(api, "/api/ai/extract", { sourceText: "synthetic source text" }), /disabled in the public demo/);
});

test("static build is reproducible and excludes server, store, and environment files", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)(process.execPath, [path.join(root, "scripts", "build.mjs")], { cwd: root });
  const files = await readdir(path.join(root, "dist"), { recursive: true });
  assert.ok(files.includes("index.html"));
  assert.ok(files.includes("app.js"));
  assert.ok(files.includes("domain.mjs"));
  assert.ok(files.includes("demo-state.json"));
  assert.ok(!files.includes("server.mjs"));
  assert.ok(!files.includes("store.json"));
  const state = JSON.parse(await readFile(path.join(root, "dist", "demo-state.json"), "utf8"));
  assert.equal(state.engagements[0].providerName, "Maya Okafor");
  const html = await readFile(path.join(root, "dist", "index.html"), "utf8");
  assert.match(html, /name="pact-public-demo" content="true"/);
  assert.match(html, /id="obligationsPanel"/);
  assert.match(html, /id="agreementSearch"/);
  const app = await readFile(path.join(root, "dist", "app.js"), "utf8");
  assert.match(app, /Export JSON backup/);
  assert.match(app, /sendBrowserReminders/);
  assert.match(app, /data-progress/);
});
