import test from "node:test";
import assert from "node:assert/strict";
import { createSharedHandler } from "../api/shared.js";
import { createStateHandler } from "../api/state.js";

function harness() {
  const headers = {};
  return { headers, res: {
    statusCode: 200,
    headersSent: false,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    end(body = "") { this.body = String(body); this.headersSent = true; }
  } };
}
function req(body, origin = "https://pact-commitment-ledger.vercel.app") {
  return { method: "POST", body, headers: { origin, "x-forwarded-for": `192.0.2.${Math.floor(Math.random() * 200) + 1}` }, socket: { remoteAddress: "192.0.2.1" } };
}

test("public state reports shared D1 availability without revealing the Worker endpoint", async () => {
  const { res } = harness();
  await createStateHandler({
    PACT_SHARED_STORAGE_URL: "https://pact-demo-storage.stanleyvic13.workers.dev",
    PACT_PUBLIC_URL: "https://pact-commitment-ledger.vercel.app"
  })({ method: "GET" }, res);
  const payload = JSON.parse(res.body);
  assert.equal(payload.config.sharedStorageAvailable, true);
  assert.equal(payload.config.accountDemoAvailable, true);
  assert.equal(payload.config.storage, "browser_local");
  assert.equal(JSON.stringify(payload).includes("workers.dev"), false);
  const { res: incomplete } = harness();
  await createStateHandler({ PACT_SHARED_STORAGE_URL: "https://pact-demo-storage.stanleyvic13.workers.dev" })({ method: "GET" }, incomplete);
  assert.equal(JSON.parse(incomplete.body).config.accountDemoAvailable, false);
});

test("shared API proxy forwards only to HTTPS workers.dev and merges AI config while disabling shared-mode PayPal", async () => {
  let forwarded;
  const handler = createSharedHandler({
    PACT_SHARED_STORAGE_URL: "https://pact-demo-storage.stanleyvic13.workers.dev",
    PACT_PUBLIC_URL: "https://pact-commitment-ledger.vercel.app",
    PACT_AI_ENDPOINT: "https://temporary.example.test/extract",
    PACT_AI_BRIDGE_TOKEN: "present-for-test",
    PACT_AI_MODEL: "qwen3:4b-instruct"
  }, async (url, options) => {
    forwarded = { url: String(url), options };
    return new Response(JSON.stringify({ demoOnly: true, engagements: [], config: { storage: "shared_d1", sharedRole: "client" } }), { status: 200 });
  });
  const { res } = harness({ action: "request", token: "f".repeat(64), path: "/api/state", method: "GET" });
  await handler(req({ action: "request", token: "f".repeat(64), path: "/api/state", method: "GET" }), res);
  const payload = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(forwarded.url, "https://pact-demo-storage.stanleyvic13.workers.dev/");
  assert.equal(forwarded.options.headers["x-pact-client-ip"].startsWith("192.0.2."), true);
  assert.equal(payload.config.ai.enabled, true);
  assert.equal(payload.config.ai.model, "qwen3:4b-instruct");
  assert.equal(payload.config.paypal.configured, false);
  assert.equal(JSON.stringify(payload).includes("present-for-test"), false);
});

test("shared API proxy refuses foreign origins and non-Worker endpoints", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response("{}", { status: 200 }); };
  const env = { PACT_SHARED_STORAGE_URL: "https://pact-demo-storage.stanleyvic13.workers.dev", PACT_PUBLIC_URL: "https://pact-commitment-ledger.vercel.app" };
  const handler = createSharedHandler(env, fetchImpl);
  const { res: foreign } = harness();
  await handler(req({ action: "create", fictionalConfirmed: true }, "https://attacker.example"), foreign);
  assert.equal(foreign.statusCode, 403);
  const { res: missingOrigin } = harness();
  await handler({ method: "POST", body: { action: "create", fictionalConfirmed: true }, headers: { "x-forwarded-for": "192.0.2.18" }, socket: { remoteAddress: "192.0.2.18" } }, missingOrigin);
  assert.equal(missingOrigin.statusCode, 403);
  const invalidHandler = createSharedHandler({ ...env, PACT_SHARED_STORAGE_URL: "https://attacker.example/api" }, fetchImpl);
  const { res: invalid } = harness();
  await invalidHandler(req({ action: "create", fictionalConfirmed: true }), invalid);
  assert.equal(invalid.statusCode, 503);
  assert.equal(calls, 0);
});

test("shared API proxy handles disabled configuration without a remote request", async () => {
  let calls = 0;
  const handler = createSharedHandler({}, async () => { calls += 1; });
  const { res } = harness();
  await handler(req({ action: "create", fictionalConfirmed: true }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.parse(res.body).error.includes("not configured"), true);
  assert.equal(calls, 0);
});
