import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileStore } from "../src/store.mjs";
import { createAppServer } from "../server.mjs";

const jsonPost = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("API keeps agreement and payment states separate and ignores client-supplied amount", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pact-api-test-"));
  let createdOrderArgs;
  const paypal = {
    configured: true,
    async createOrder(args) { createdOrderArgs = args; return { id: "SANDBOXORDER-123", status: "CREATED", links: [{ rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=SANDBOXORDER-123" }] }; },
    async captureOrder(orderId) {
      assert.equal(orderId, "SANDBOXORDER-123");
      return { id: orderId, status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAPTURE-123", status: "COMPLETED", amount: { currency_code: "USD", value: "425.00" } }] } }] };
    }
  };
  const { server } = await createAppServer({ store: new FileStore(path.join(tempDir, "store.json")), paypal, ai: async () => ({ candidates: [], processing: "local_ollama" }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const initial = await fetch(`${base}/api/state`).then((r) => r.json());
    assert.equal(initial.config.paypal.clientId, undefined);
    assert.equal(initial.config.paypal.clientSecret, undefined);
    assert.equal(initial.engagements[0].payment.requestIds, undefined);

    const forbidden = await jsonPost(`${base}/api/engagements`, { role: "client", title: "No", terms: {} });
    assert.equal(forbidden.status, 403);

    const createdResponse = await jsonPost(`${base}/api/engagements`, {
      role: "provider", title: "Illustration set", providerName: "Ari", clientName: "Sam",
      terms: { deliverables: ["Three illustrations"], amountMinor: 85000, depositMinor: 42500, currency: "USD" }
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    const engagement = created.engagement;
    assert.equal(engagement.currentVersionId, null);

    const accepted = await jsonPost(`${base}/api/engagements/${engagement.id}/respond`, {
      role: "client", versionId: engagement.versions[0].id, action: "accept"
    });
    assert.equal(accepted.status, 200);

    const progressResponse = await jsonPost(`${base}/api/engagements/${engagement.id}/progress`, {
      role: "provider", versionId: engagement.versions[0].id, deliverableIndex: 0, status: "in_progress"
    });
    assert.equal(progressResponse.status, 200);
    const evidenceResponse = await jsonPost(`${base}/api/engagements/${engagement.id}/evidence`, {
      role: "client", description: "Synthetic attached preview", attachment: {
        name: "preview.txt", type: "text/plain", size: 5, dataUrl: "data:text/plain;base64,SGVsbG8="
      }
    });
    assert.equal(evidenceResponse.status, 201);
    const rejectedAttachment = await jsonPost(`${base}/api/engagements/${engagement.id}/evidence`, {
      role: "client", description: "Not an allowed attachment", attachment: {
        name: "unsafe.svg", type: "image/svg+xml", size: 5, dataUrl: "data:image/svg+xml;base64,SGVsbG8="
      }
    });
    assert.equal(rejectedAttachment.status, 400);

    const orderResponse = await jsonPost(`${base}/api/paypal/orders`, {
      role: "client", engagementId: engagement.id, amountMinor: 1, currency: "NGN"
    });
    assert.equal(orderResponse.status, 201);
    assert.equal(createdOrderArgs.amountMinor, 42500);
    assert.equal(createdOrderArgs.currency, "USD");
    assert.equal(new URL(createdOrderArgs.returnUrl).origin, base);
    assert.equal(new URL(createdOrderArgs.cancelUrl).origin, base);
    const order = await orderResponse.json();
    assert.match(order.merchantNotice, /not the service provider/);
    assert.equal(order.approvalUrl, "https://www.sandbox.paypal.com/checkoutnow?token=SANDBOXORDER-123");
    assert.equal(order.clientId, undefined);

    const captureResponse = await jsonPost(`${base}/api/paypal/orders/${order.orderId}/capture`, { role: "client", engagementId: engagement.id });
    assert.equal(captureResponse.status, 200);
    const final = await fetch(`${base}/api/state`).then((r) => r.json());
    const saved = final.engagements.find((item) => item.id === engagement.id);
    assert.equal(saved.payment.status, "captured");
    assert.equal(saved.payment.verified, true);
    assert.equal(saved.currentVersionId, engagement.versions[0].id);
    assert.equal(saved.payment.requestIds, undefined);
    assert.equal(saved.events.find((event) => event.type === "deliverable_progress_updated")?.status, "in_progress");
    assert.equal(saved.evidence[0].attachment.name, "preview.txt");
    assert.ok(saved.events.some((event) => /not a provider payout/.test(event.label)));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  }
});
