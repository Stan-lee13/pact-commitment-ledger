import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSeedState } from "../src/demo-data.mjs";
import { createLocalDemoApi, PUBLIC_DEMO_STORAGE_KEY } from "../public/local-demo.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function createHarness({ publicConfig = {}, fetchImpl = globalThis.fetch } = {}) {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  return { api: createLocalDemoApi({ initialState: createSeedState(), storage, publicConfig, fetchImpl }), storage };
}

const post = (api, route, body) => api(route, { method: "POST", body: JSON.stringify(body) });
const remove = (api, route, body) => api(route, { method: "DELETE", body: JSON.stringify(body) });
const remoteResponse = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });

test("public demo is browser-local and uses safe disabled defaults when integrations are not configured", async () => {
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

test("enabled public AI calls the server route with the selected text and keeps suggestions separate", async () => {
  let calls = 0;
  const { api } = createHarness({
    publicConfig: { ai: { enabled: true, mode: "temporary_remote_ollama", model: "qwen3:4b-instruct" } },
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(url, "/api/ai/extract");
      assert.equal(JSON.parse(options.body).sourceText, "Two revisions are included in this fictional project.");
      return remoteResponse({ candidates: [{ field: "revisionLimit", value: "Two revisions", exactQuote: "Two revisions", quoteVerified: true }], clarifyingQuestions: [] });
    }
  });
  const result = await post(api, "/api/ai/extract", { sourceText: "Two revisions are included in this fictional project." });
  assert.equal(result.candidates[0].quoteVerified, true);
  assert.equal(calls, 1);
});

test("enabled public PayPal Sandbox order is idempotent locally and persists verified capture state", async () => {
  const calls = [];
  const { api } = createHarness({
    publicConfig: { paypal: { configured: true, environment: "sandbox" } },
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, body });
      if (url === "/api/paypal/orders") return remoteResponse({ orderId: "TEST-ORDER-123", quoteToken: "signed-demo-quote", approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=TEST-ORDER-123" }, 201);
      if (url === "/api/paypal/capture") return remoteResponse({ payment: { status: "captured", verified: true, captureId: "TEST-CAPTURE-456", amountMinor: 42500, currency: "USD" } });
      throw new Error("Unexpected route");
    }
  });
  const order1 = await post(api, "/api/paypal/orders", { role: "client", engagementId: "demo-pact-01" });
  const order2 = await post(api, "/api/paypal/orders", { role: "client", engagementId: "demo-pact-01" });
  assert.equal(order1.orderId, "TEST-ORDER-123");
  assert.equal(order2.orderId, "TEST-ORDER-123");
  assert.equal(calls.filter((item) => item.url === "/api/paypal/orders").length, 1);
  assert.equal(calls[0].body.acceptedVersion.id, "demo-v1");
  assert.equal(calls[0].body.acceptedVersion.terms.depositMinor, 42500);
  const capture = await post(api, "/api/paypal/capture", { role: "client", engagementId: "demo-pact-01", orderId: order1.orderId });
  assert.equal(capture.payment.verified, true);
  const state = await api("/api/state");
  const payment = state.engagements[0].payment;
  assert.equal(payment.status, "captured");
  assert.equal(payment.captureId, "TEST-CAPTURE-456");
  assert.equal(payment.approvalUrl, "https://www.sandbox.paypal.com/checkoutnow?token=TEST-ORDER-123");
  assert.equal(state.engagements[0].events.at(-1).type, "sandbox_payment_captured");
  assert.equal(calls[1].body.quoteToken, "signed-demo-quote");
});

test("provider can delete an unpaid browser-local agreement but not one with a PayPal order", async () => {
  const { api } = createHarness();
  const first = await post(api, "/api/engagements", {
    role: "provider", title: "Disposable synthetic project", providerName: "Ari", clientName: "Sam",
    terms: { deliverables: ["Prototype screen"] }
  });
  await remove(api, `/api/engagements/${first.engagement.id}`, { role: "provider" });
  assert.equal((await api("/api/state")).engagements.length, 1);

  const state = await api("/api/state");
  state.engagements[0].payment.orderId = "ORDER-123";
  const saved = JSON.stringify(state);
  const storage = new Map([[PUBLIC_DEMO_STORAGE_KEY, saved]]);
  const protectedApi = createLocalDemoApi({
    initialState: createSeedState(),
    storage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
  });
  await assert.rejects(remove(protectedApi, "/api/engagements/demo-pact-01", { role: "provider" }), /Keep its payment reference/);
});

test("the public demo rejects invalid roles and disabled integrations", async () => {
  const { api } = createHarness();
  await assert.rejects(post(api, "/api/engagements", {
    role: "client", title: "No", providerName: "Ari", clientName: "Sam", terms: { deliverables: ["x"] }
  }), /Only the provider/);
  await assert.rejects(post(api, "/api/engagements", {
    role: "provider", title: "No", providerName: "Ari", clientName: "Sam", terms: { deliverables: ["x"], depositMinor: 10, amountMinor: 5 }
  }), /Deposit cannot exceed/);
  await assert.rejects(post(api, "/api/paypal/orders", { role: "client", engagementId: "demo-pact-01" }), /not configured/);
  await assert.rejects(post(api, "/api/ai/extract", { sourceText: "synthetic source text" }), /temporarily unavailable/);
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
  assert.ok(!files.includes("api"));
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
  assert.match(app, /PayPal Sandbox/);
  assert.equal(app.includes("clientId"), false);
  assert.equal(app.includes("PAYPAL_CLIENT_ID"), false);
  assert.equal(app.includes("PAYPAL_CLIENT_SECRET"), false);
});
