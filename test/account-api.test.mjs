import test from "node:test";
import assert from "node:assert/strict";
import { createAccountHandler } from "../api/account.js";

function harness() {
  const headers = {};
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    end(body = "") { this.body = String(body); this.headersSent = true; }
  };
  res.headers = headers;
  return { headers, res };
}
function req(body, { origin = "https://pact-commitment-ledger.vercel.app", cookie = "", method = "POST", ip = Math.random().toString(16).slice(2) } = {}) {
  return { method, body, headers: { origin, cookie, "x-forwarded-for": `192.0.2.${ip}` }, socket: { remoteAddress: "192.0.2.1" } };
}
const environment = {
  PACT_SHARED_STORAGE_URL: "https://pact-demo-storage.stanleyvic13.workers.dev",
  PACT_PUBLIC_URL: "https://pact-commitment-ledger.vercel.app"
};

test("registration stores the session only in an HttpOnly Secure SameSite cookie and returns a one-time account key", async () => {
  const sessionToken = "a".repeat(64);
  const accountKey = "b".repeat(64);
  let forwarded;
  const handler = createAccountHandler(environment, async (_url, options) => {
    forwarded = JSON.parse(options.body);
    return new Response(JSON.stringify({ sessionToken, accountKey, account: { handle: "pact-012345abcdef" }, demoOnly: true }), { status: 200 });
  });
  const { res } = harness();
  await handler(req({ operation: "register", fictionalConfirmed: true }), res);
  const result = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(forwarded.action, "account");
  assert.equal(forwarded.operation, "register");
  assert.equal(forwarded.fictionalConfirmed, true);
  assert.equal("sessionToken" in result, false);
  assert.equal(result.accountKey, accountKey);
  assert.match(res.headers["set-cookie"], /^pact_demo_session=a{64};/);
  assert.match(res.headers["set-cookie"], /HttpOnly/);
  assert.match(res.headers["set-cookie"], /Secure/);
  assert.match(res.headers["set-cookie"], /SameSite=Strict/);
  assert.equal(JSON.stringify(result).includes(sessionToken), false);
});

test("workspace creation forwards the explicit fictional-only attestation", async () => {
  let forwarded;
  const handler = createAccountHandler(environment, async (_url, options) => {
    forwarded = JSON.parse(options.body);
    return new Response(JSON.stringify({ workspace: { id: "12345678-1234-4234-8234-123456789abc", role: "provider" }, inviteToken: "f".repeat(64) }), { status: 200 });
  });
  const { res } = harness();
  await handler(req({ operation: "create_workspace", fictionalConfirmed: true }, { cookie: `pact_demo_session=${"c".repeat(64)}` }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(forwarded.operation, "create_workspace");
  assert.equal(forwarded.fictionalConfirmed, true);
});

test("foreign origins and cross-site fetches are rejected before reaching the Worker", async () => {
  let calls = 0;
  const handler = createAccountHandler(environment, async () => { calls += 1; return new Response("{}", { status: 200 }); });
  const { res: foreign } = harness();
  await handler(req({ operation: "login" }, { origin: "https://attacker.example" }), foreign);
  assert.equal(foreign.statusCode, 403);
  const crossSite = req({ operation: "login" });
  crossSite.headers["sec-fetch-site"] = "cross-site";
  const { res } = harness();
  await handler(crossSite, res);
  assert.equal(res.statusCode, 403);
  assert.equal(calls, 0);
});

test("session token comes only from the cookie, not an untrusted request body", async () => {
  const sessionToken = "c".repeat(64);
  let forwarded;
  const handler = createAccountHandler(environment, async (_url, options) => {
    forwarded = JSON.parse(options.body);
    return new Response(JSON.stringify({ authenticated: true, account: { handle: "pact-012345abcdef" }, workspaces: [] }), { status: 200 });
  });
  const { res } = harness();
  await handler(req({ operation: "session", sessionToken: "d".repeat(64) }, { cookie: `other=x; pact_demo_session=${sessionToken}` }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(forwarded.sessionToken, sessionToken);
  assert.equal(JSON.parse(res.body).authenticated, true);
  assert.equal(res.headers["set-cookie"], undefined);
});

test("logout clears the browser cookie and never returns the session token", async () => {
  let forwarded;
  const handler = createAccountHandler(environment, async (_url, options) => {
    forwarded = JSON.parse(options.body);
    return new Response(JSON.stringify({ loggedOut: true }), { status: 200 });
  });
  const token = "e".repeat(64);
  const { res } = harness();
  await handler(req({ operation: "logout" }, { cookie: `pact_demo_session=${token}` }), res);
  assert.equal(forwarded.sessionToken, token);
  assert.match(res.headers["set-cookie"], /Max-Age=0/);
  assert.equal(JSON.stringify(JSON.parse(res.body)).includes(token), false);
});

test("authenticated workspace API blocks PayPal and validates workspace paths", async () => {
  let calls = 0;
  const handler = createAccountHandler(environment, async () => { calls += 1; return new Response("{}", { status: 200 }); });
  const { res: payment } = harness();
  await handler(req({ operation: "request", workspaceId: "1".repeat(36), path: "/api/paypal/orders", method: "POST" }), payment);
  assert.equal(payment.statusCode, 403);
  const { res: invalid } = harness();
  await handler(req({ operation: "request", workspaceId: "not-a-workspace", path: "/api/state" }), invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(calls, 0);
});

test("account API rejects methods other than POST", async () => {
  const handler = createAccountHandler(environment, async () => new Response("{}"));
  const { res } = harness();
  await handler(req({}, { method: "GET" }), res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, "POST");
});
