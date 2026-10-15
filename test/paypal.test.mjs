import test from "node:test";
import assert from "node:assert/strict";
import { PayPalSandbox, formatMinorAmount, verifyCaptureAgainstExpected } from "../src/paypal.mjs";

const requestId = "123e4567-e89b-12d3-a456-426655440010";

test("minor currency amounts are formatted without floating-point rounding", () => {
  assert.equal(formatMinorAmount(42500), "425.00");
  assert.equal(formatMinorAmount(99), "0.99");
  assert.throws(() => formatMinorAmount(-1), /Invalid payment amount/);
});

test("Sandbox client uses server-provided amount and a stable request ID", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/v1/oauth2/token")) return new Response(JSON.stringify({ access_token: "sandbox-access-token", expires_in: 3600 }), { status: 200 });
    if (url.endsWith("/v2/checkout/orders")) return new Response(JSON.stringify({ id: "SANDBOXORDER-123", status: "CREATED" }), { status: 201 });
    if (url.endsWith("/v2/checkout/orders/SANDBOXORDER-123/capture")) return new Response(JSON.stringify({
      id: "SANDBOXORDER-123", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAPTURE-123", status: "COMPLETED", amount: { currency_code: "USD", value: "425.00" } }] } }]
    }), { status: 201 });
    throw new Error(`Unexpected URL ${url}`);
  };
  const client = new PayPalSandbox({ clientId: "sandbox-client", clientSecret: "sandbox-secret", fetchImpl });
  const created = await client.createOrder({ engagementId: "demo-1", title: "Project deposit", amountMinor: 42500, currency: "USD", requestId });
  assert.equal(created.id, "SANDBOXORDER-123");
  const orderCall = calls.find((call) => call.url.endsWith("/v2/checkout/orders"));
  assert.equal(orderCall.options.headers["PayPal-Request-Id"], requestId);
  assert.equal(JSON.parse(orderCall.options.body).purchase_units[0].amount.value, "425.00");
  assert.equal(JSON.parse(orderCall.options.body).intent, "CAPTURE");
  const captured = await client.captureOrder("SANDBOXORDER-123", requestId);
  const captureCall = calls.find((call) => call.url.endsWith("/capture"));
  assert.equal(captureCall.options.headers["PayPal-Request-Id"], requestId);
  assert.equal(captureCall.options.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(captureCall.options.body), {});
  assert.equal(captured.status, "COMPLETED");
});

test("capture status is accepted only when PayPal returns matching completed amount and currency", () => {
  const order = { status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAP1", status: "COMPLETED", amount: { currency_code: "USD", value: "425.00" } }] } }] };
  assert.deepEqual(verifyCaptureAgainstExpected(order, { amountMinor: 42500, currency: "USD" }), {
    verified: true, status: "captured", captureId: "CAP1", amountMinor: 42500, currency: "USD"
  });
  assert.equal(verifyCaptureAgainstExpected(order, { amountMinor: 85000, currency: "USD" }).verified, false);
  assert.equal(verifyCaptureAgainstExpected({ status: "APPROVED" }, { amountMinor: 42500, currency: "USD" }).status, "approved");
});

test("live PayPal mode cannot be enabled in this prototype", () => {
  assert.throws(() => new PayPalSandbox({ clientId: "x", clientSecret: "y", env: "live" }), /only permits PayPal Sandbox/);
});
