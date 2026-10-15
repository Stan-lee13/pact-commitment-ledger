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
});
