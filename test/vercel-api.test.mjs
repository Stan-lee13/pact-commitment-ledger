import test from "node:test";
import assert from "node:assert/strict";
import { createAiExtractHandler } from "../api/ai/extract.js";
import { createPayPalCaptureHandler } from "../api/paypal/capture.js";
import { createPayPalOrderHandler } from "../api/paypal/orders.js";
import { createStateHandler } from "../api/state.js";
import { verifyPaymentQuoteToken } from "../src/payment-token.mjs";

const signingKey = "test-payment-signing-key-that-is-long-enough-000000000000";
function harness() {
  const headers = {};
  return {
    headers,
    res: {
      statusCode: 200,
      headersSent: false,
      setHeader(name, value) { headers[name.toLowerCase()] = value; },
      end(value = "") { this.body = String(value); this.headersSent = true; }
    }
  };
}
let requestCounter = 0;
function req(method, body = {}) {
  const address = `192.0.2.${++requestCounter}`;
  return { method, body, headers: { "x-forwarded-for": address }, socket: { remoteAddress: address } };
}

const goodVersion = {
  id: "version-accepted-1", status: "accepted", acceptedBy: ["provider", "client"],
  terms: { amountMinor: 85000, depositMinor: 42500, currency: "USD" }
};
const env = {
  PAYPAL_ENV: "sandbox", PAYPAL_CLIENT_ID: "sandbox-client-id-public",
  PAYPAL_CLIENT_SECRET: "sandbox-secret-not-returned", PACT_PAYMENT_SIGNING_KEY: signingKey,
  PACT_PUBLIC_URL: "https://pact-commitment-ledger.vercel.app"
};
const approvalLinks = (id) => [{ rel: "payer-action", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }];

test("public state exposes integration availability but never any PayPal credential", async () => {
  const { res } = harness();
  await createStateHandler(env)(req("GET"), res);
  const state = JSON.parse(res.body);
  assert.equal(state.config.publicDemo, true);
  assert.equal(state.config.paypal.configured, true);
  assert.equal(state.config.paypal.clientId, undefined);
  assert.equal(JSON.stringify(state).includes(env.PAYPAL_CLIENT_ID), false);
  assert.equal(JSON.stringify(state).includes(env.PAYPAL_CLIENT_SECRET), false);
});

test("public PayPal readiness stays disabled if the payment quote signing key is missing", async () => {
  const { res } = harness();
  await createStateHandler({ ...env, PACT_PAYMENT_SIGNING_KEY: "" })(req("GET"), res);
  const state = JSON.parse(res.body);
  assert.equal(state.config.paypal.configured, false);
});

test("hosted AI forwards only bounded user-selected text and independently verifies quotes", async () => {
  const sourceText = "The landing page includes two revisions and is due November 20, 2026.";
  let forwarded;
  const handler = createAiExtractHandler({
    environment: { PACT_AI_ENDPOINT: "https://ai.example.test/extract", PACT_AI_BRIDGE_TOKEN: "private-token", PACT_AI_MODEL: "qwen3:4b-instruct" },
    fetchImpl: async (url, options) => {
      forwarded = { url: String(url), options };
      return { ok: true, json: async () => ({ candidates: [
        { field: "revisionLimit", value: "two revisions", exactQuote: "two revisions", quoteVerified: true },
        { field: "amount", value: "USD 900", exactQuote: "two revisions", quoteVerified: true }
      ], clarifyingQuestions: [] }) };
    }
  });
  const { res } = harness();
  await handler(req("POST", { sourceText }), res);
  const result = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(forwarded.url, "https://ai.example.test/extract");
  assert.equal(forwarded.options.headers["x-pact-bridge-token"], "private-token");
  assert.equal(result.candidates[0].quoteVerified, true);
  assert.equal(result.candidates[1].quoteVerified, false);
  assert.equal(result.processing, "temporary_local_ollama");
  assert.equal(JSON.stringify(result).includes("private-token"), false);
});

test("PayPal order uses the accepted version deposit and returns a signed capture quote", async () => {
  let orderInput;
  const handler = createPayPalOrderHandler({
    environment: env,
    paypalFactory: () => ({ createOrder: async (input) => { orderInput = input; return { id: "TEST-ORDER-123", status: "CREATED", links: approvalLinks("TEST-ORDER-123") }; } }),
    now: () => 1_800_000_000_000
  });
  const { res } = harness();
  await handler(req("POST", {
    role: "client", engagementId: "demo-pact-01", title: "Synthetic website project",
    versionId: goodVersion.id, acceptedVersion: goodVersion, requestId: "create-test-request-1"
  }), res);
  const payload = JSON.parse(res.body);
  assert.equal(res.statusCode, 201);
  assert.equal(orderInput.amountMinor, 42500);
  assert.equal(orderInput.currency, "USD");
  assert.equal(orderInput.requestId, "create-test-request-1");
  const quote = verifyPaymentQuoteToken(payload.quoteToken, signingKey, "TEST-ORDER-123", { now: 1_800_000_000_000 });
  assert.equal(quote.amountMinor, 42500);
  assert.equal(quote.engagementId, "demo-pact-01");
  assert.equal(payload.approvalUrl, "https://www.sandbox.paypal.com/checkoutnow?token=TEST-ORDER-123");
  assert.equal(payload.clientId, undefined);
  assert.match(orderInput.returnUrl, /paypal=return/);
  assert.match(orderInput.cancelUrl, /paypal=cancel/);
  assert.equal(JSON.stringify(payload).includes(env.PAYPAL_CLIENT_ID), false);
  assert.equal(JSON.stringify(payload).includes(env.PAYPAL_CLIENT_SECRET), false);
});

test("PayPal order refuses a draft, provider role, or non-USD amount", async () => {
  const handler = createPayPalOrderHandler({ environment: env, paypalFactory: () => ({ createOrder: async () => { throw new Error("must not call"); } }) });
  const draft = structuredClone(goodVersion); draft.status = "proposed";
  const { res: draftRes } = harness();
  await handler(req("POST", { role: "client", engagementId: "demo", versionId: draft.id, acceptedVersion: draft, requestId: "draft-request" }), draftRes);
  assert.equal(draftRes.statusCode, 409);
  const { res: roleRes } = harness();
  await handler(req("POST", { role: "provider", engagementId: "demo", versionId: goodVersion.id, acceptedVersion: goodVersion, requestId: "provider-request" }), roleRes);
  assert.equal(roleRes.statusCode, 403);
  const wrongCurrency = structuredClone(goodVersion); wrongCurrency.terms.currency = "EUR";
  const { res: currencyRes } = harness();
  await handler(req("POST", { role: "client", engagementId: "demo", versionId: wrongCurrency.id, acceptedVersion: wrongCurrency, requestId: "currency-request" }), currencyRes);
  assert.equal(currencyRes.statusCode, 400);
});

test("PayPal capture verifies the signed amount and is idempotent after completion", async () => {
  let captureCalls = 0;
  const quoteToken = (await (async () => {
    const { res } = harness();
    await createPayPalOrderHandler({ environment: env, paypalFactory: () => ({ createOrder: async () => ({ id: "CAPTURE-ORDER-456", links: approvalLinks("CAPTURE-ORDER-456") }) }) })(req("POST", {
      role: "client", engagementId: "demo-pact-01", versionId: goodVersion.id, acceptedVersion: goodVersion, requestId: "capture-create-request"
    }), res);
    return JSON.parse(res.body).quoteToken;
  })());
  const completed = {
    id: "CAPTURE-ORDER-456", status: "COMPLETED",
    purchase_units: [{ payments: { captures: [{ id: "CAPTURE-789", status: "COMPLETED", amount: { currency_code: "USD", value: "425.00" } }] } }]
  };
  const handler = createPayPalCaptureHandler({
    environment: env,
    paypalFactory: () => ({ getOrder: async () => completed, captureOrder: async () => { captureCalls += 1; return completed; } })
  });
  const { res } = harness();
  await handler(req("POST", { role: "client", engagementId: "demo-pact-01", orderId: "CAPTURE-ORDER-456", quoteToken }), res);
  const result = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(result.payment.verified, true);
  assert.equal(result.payment.amountMinor, 42500);
  assert.equal(captureCalls, 0);
});

test("PayPal capture preserves unresolved status on amount mismatch", async () => {
  const order = {
    id: "MISMATCH-ORDER-456", status: "COMPLETED",
    purchase_units: [{ payments: { captures: [{ id: "CAPTURE-999", status: "COMPLETED", amount: { currency_code: "USD", value: "1.00" } }] } }]
  };
  let quoteToken;
  const create = createPayPalOrderHandler({ environment: env, paypalFactory: () => ({ createOrder: async () => ({ id: order.id, links: approvalLinks(order.id) }) }) });
  const { res: created } = harness();
  await create(req("POST", { role: "client", engagementId: "demo-pact-01", versionId: goodVersion.id, acceptedVersion: goodVersion, requestId: "mismatch-create" }), created);
  quoteToken = JSON.parse(created.body).quoteToken;
  const capture = createPayPalCaptureHandler({ environment: env, paypalFactory: () => ({ getOrder: async () => order, captureOrder: async () => order }) });
  const { res } = harness();
  await capture(req("POST", { role: "client", engagementId: "demo-pact-01", orderId: order.id, quoteToken }), res);
  assert.equal(res.statusCode, 202);
  assert.equal(JSON.parse(res.body).payment.status, "unknown");
  assert.equal(JSON.parse(res.body).payment.verified, false);
});
