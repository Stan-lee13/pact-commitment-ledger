import {
  addEvidence,
  createEngagement,
  deleteEngagement,
  getCurrentVersion,
  getEngagement,
  proposeChange,
  recordDeliveryReview,
  respondToVersion,
  updateDeliverableProgress
} from "./domain.mjs";

export const PUBLIC_DEMO_STORAGE_KEY = "pact.public-demo.v1";
const clone = (value) => structuredClone(value);
const disabledConfig = {
  ai: { enabled: false, mode: "disabled", model: null },
  paypal: { configured: false, environment: "sandbox" }
};

function error(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export function createLocalDemoApi({
  initialState,
  storage = globalThis.localStorage,
  key = PUBLIC_DEMO_STORAGE_KEY,
  publicConfig = {},
  fetchImpl = globalThis.fetch
}) {
  let queue = Promise.resolve();
  const config = {
    publicDemo: true,
    storage: "browser_local",
    sharedStorageAvailable: Boolean(publicConfig.sharedStorageAvailable),
    ai: publicConfig.ai ?? disabledConfig.ai,
    paypal: publicConfig.paypal ?? disabledConfig.paypal
  };

  function readState() {
    const saved = storage.getItem(key);
    if (!saved) return clone(initialState);
    try {
      const parsed = JSON.parse(saved);
      if (!parsed || !Array.isArray(parsed.engagements)) throw new Error("Invalid state shape");
      return parsed;
    } catch {
      throw error("This browser's demo data could not be read. Export or clear this browser's site data to continue.", 500);
    }
  }

  function transact(mutator) {
    const operation = queue.then(() => {
      const state = readState();
      const result = mutator(state);
      const serialized = JSON.stringify(state);
      if (new TextEncoder().encode(serialized).byteLength > 4 * 1024 * 1024) {
        throw error("Browser demo storage is full. Export your records and reduce attachment sizes before adding more.", 507);
      }
      try { storage.setItem(key, serialized); }
      catch (cause) {
        if (cause?.name === "QuotaExceededError" || cause?.code === 22) {
          throw error("Browser demo storage is full. Export your records and reduce attachment sizes before adding more.", 507);
        }
        throw cause;
      }
      return clone(result);
    });
    queue = operation.catch(() => undefined);
    return operation;
  }

  async function remotePost(path, body) {
    if (typeof fetchImpl !== "function") throw error("The hosted integration route is unavailable.", 503);
    let response;
    try {
      response = await fetchImpl(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify(body)
      });
    } catch {
      throw error("The hosted integration service could not be reached. Try again later.", 503);
    }
    let payload = {};
    try { payload = await response.json(); } catch {}
    if (!response.ok) throw error(payload.error || `Request failed (${response.status}).`, response.status);
    return payload;
  }

  async function createSandboxOrder(body) {
    if (!config.paypal?.configured) throw error("PayPal Sandbox checkout is not configured.", 503);
    if (body.role !== "client") throw error("Switch to the client demo role to test buyer checkout.", 403);
    const reservation = await transact((state) => {
      const engagement = getEngagement(state, body.engagementId);
      const current = getCurrentVersion(engagement);
      if (!current || current.status !== "accepted") throw error("A mutually accepted version is required before Sandbox checkout.", 409);
      if (engagement.payment?.status === "captured") throw error("This Sandbox payment is already captured.", 409);
      if (engagement.payment?.orderId) {
        if (!engagement.payment.quoteToken || !engagement.payment.approvalUrl) throw error("The saved Sandbox order has no usable approval link or capture quote. Reset this browser demo before starting another order.", 409);
        return {
          existingOrder: true,
          orderId: engagement.payment.orderId,
          quoteToken: engagement.payment.quoteToken,
          approvalUrl: engagement.payment.approvalUrl,
          merchantNotice: "Sandbox only. Any capture goes to the configured test merchant account, not the service provider."
        };
      }
      engagement.payment ??= { status: "not_started", provider: "paypal_sandbox" };
      engagement.payment.requestIds ??= { create: null, capture: null };
      const requestId = engagement.payment.requestIds.create || globalThis.crypto.randomUUID();
      engagement.payment.requestIds.create = requestId;
      engagement.payment.status = "creating";
      engagement.payment.amountMinor = current.terms.depositMinor ?? current.terms.amountMinor;
      engagement.payment.currency = current.terms.currency || "USD";
      engagement.payment.versionId = current.id;
      engagement.payment.updatedAt = new Date().toISOString();
      return {
        existingOrder: false,
        requestId,
        engagementId: engagement.id,
        title: engagement.title,
        versionId: current.id,
        acceptedVersion: current
      };
    });
    if (reservation.existingOrder) return reservation;
    try {
      const result = await remotePost("/api/paypal/orders", {
        role: body.role,
        engagementId: reservation.engagementId,
        title: reservation.title,
        versionId: reservation.versionId,
        acceptedVersion: reservation.acceptedVersion,
        requestId: reservation.requestId
      });
      await transact((state) => {
        const engagement = getEngagement(state, reservation.engagementId);
        if (engagement.payment.requestIds?.create !== reservation.requestId) return;
        engagement.payment.orderId = result.orderId;
        engagement.payment.quoteToken = result.quoteToken;
        engagement.payment.approvalUrl = result.approvalUrl;
        engagement.payment.status = "created";
        engagement.payment.updatedAt = new Date().toISOString();
        engagement.events.push({
          id: globalThis.crypto.randomUUID(), type: "sandbox_order_created", actor: "client",
          at: engagement.payment.updatedAt,
          label: `PayPal Sandbox order ${result.orderId} created for the configured test merchant. This is not a provider payout.`
        });
      });
      return result;
    } catch (cause) {
      await transact((state) => {
        const engagement = getEngagement(state, reservation.engagementId);
        if (engagement.payment.requestIds?.create === reservation.requestId) {
          engagement.payment.status = "unknown";
          engagement.payment.updatedAt = new Date().toISOString();
        }
      });
      throw cause;
    }
  }

  async function captureSandboxOrder(body) {
    if (!config.paypal?.configured) throw error("PayPal Sandbox checkout is not configured.", 503);
    if (body.role !== "client") throw error("Switch to the client demo role to capture this Sandbox order.", 403);
    const reservation = await transact((state) => {
      const engagement = getEngagement(state, body.engagementId);
      const payment = engagement.payment ?? {};
      if (!body.orderId || payment.orderId !== body.orderId) throw error("This order does not belong to the selected agreement.", 404);
      if (payment.status === "captured") return { alreadyCaptured: true, payment: clone(payment) };
      const quoteToken = String(body.quoteToken || payment.quoteToken || "");
      if (!quoteToken) throw error("The signed Sandbox capture quote is missing. Do not retry with a different order.", 409);
      return { alreadyCaptured: false, engagementId: engagement.id, orderId: payment.orderId, quoteToken };
    });
    if (reservation.alreadyCaptured) return { payment: reservation.payment, alreadyCaptured: true };
    try {
      const result = await remotePost("/api/paypal/capture", {
        role: body.role,
        engagementId: reservation.engagementId,
        orderId: reservation.orderId,
        quoteToken: reservation.quoteToken
      });
      await transact((state) => {
        const engagement = getEngagement(state, reservation.engagementId);
        if (engagement.payment.orderId !== reservation.orderId) return;
        const priorStatus = engagement.payment.status;
        engagement.payment.status = result.payment?.status || "unknown";
        engagement.payment.captureId = result.payment?.captureId ?? engagement.payment.captureId ?? null;
        engagement.payment.amountMinor = result.payment?.amountMinor ?? engagement.payment.amountMinor;
        engagement.payment.currency = result.payment?.currency ?? engagement.payment.currency ?? "USD";
        engagement.payment.verified = Boolean(result.payment?.verified);
        engagement.payment.updatedAt = new Date().toISOString();
        if (engagement.payment.status === "captured" && priorStatus !== "captured") {
          engagement.events.push({
            id: globalThis.crypto.randomUUID(), type: "sandbox_payment_captured", actor: "server",
            at: engagement.payment.updatedAt,
            label: `PayPal Sandbox capture ${engagement.payment.captureId} was verified for the configured test merchant. It is not a provider payout and does not prove delivery.`
          });
        } else if (!result.payment?.verified && priorStatus !== engagement.payment.status) {
          engagement.events.push({
            id: globalThis.crypto.randomUUID(), type: "sandbox_payment_unresolved", actor: "server",
            at: engagement.payment.updatedAt,
            label: "PayPal Sandbox did not confirm a matching completed capture. Payment remains unresolved."
          });
        }
      });
      return result;
    } catch (cause) {
      await transact((state) => {
        const engagement = getEngagement(state, reservation.engagementId);
        if (engagement.payment.orderId === reservation.orderId && engagement.payment.status !== "captured") {
          engagement.payment.status = "unknown";
          engagement.payment.updatedAt = new Date().toISOString();
        }
      });
      throw cause;
    }
  }

  return async function localDemoApi(path, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const pathname = new URL(path, "https://pact.local").pathname;
    let body = {};
    if (options.body) {
      try { body = typeof options.body === "string" ? JSON.parse(options.body) : options.body; }
      catch { throw error("Request body must be valid JSON."); }
    }

    if (method === "GET" && pathname === "/api/state") {
      return {
        ...readState(),
        demoOnly: true,
        config: clone(config)
      };
    }

    if (method === "POST" && pathname === "/api/engagements") {
      return transact((state) => ({ engagement: createEngagement(state, body, body.role || "provider") }));
    }

    const deleteMatch = pathname.match(/^\/api\/engagements\/([^/]+)$/);
    if (method === "DELETE" && deleteMatch) {
      return transact((state) => deleteEngagement(state, decodeURIComponent(deleteMatch[1]), body.role));
    }

    const changeMatch = pathname.match(/^\/api\/engagements\/([^/]+)\/changes$/);
    if (method === "POST" && changeMatch) {
      return transact((state) => ({ version: proposeChange(state, decodeURIComponent(changeMatch[1]), body, body.role) }));
    }

    const responseMatch = pathname.match(/^\/api\/engagements\/([^/]+)\/respond$/);
    if (method === "POST" && responseMatch) {
      return transact((state) => respondToVersion(
        state, decodeURIComponent(responseMatch[1]), body.versionId, body.role, body.action, body.comment
      ));
    }

    const evidenceMatch = pathname.match(/^\/api\/engagements\/([^/]+)\/evidence$/);
    if (method === "POST" && evidenceMatch) {
      return transact((state) => ({ evidence: addEvidence(state, decodeURIComponent(evidenceMatch[1]), body, body.role) }));
    }

    const progressMatch = pathname.match(/^\/api\/engagements\/([^/]+)\/progress$/);
    if (method === "POST" && progressMatch) {
      return transact((state) => ({ event: updateDeliverableProgress(state, decodeURIComponent(progressMatch[1]), body, body.role) }));
    }

    const reviewMatch = pathname.match(/^\/api\/engagements\/([^/]+)\/review$/);
    if (method === "POST" && reviewMatch) {
      return transact((state) => ({ event: recordDeliveryReview(state, decodeURIComponent(reviewMatch[1]), body, body.role) }));
    }

    if (method === "POST" && pathname === "/api/ai/extract") {
      if (!config.ai?.enabled) throw error("AI suggestions are temporarily unavailable. Enter terms manually.", 503);
      return remotePost(pathname, body);
    }
    if (method === "POST" && pathname === "/api/paypal/orders") return createSandboxOrder(body);
    if (method === "POST" && pathname === "/api/paypal/capture") return captureSandboxOrder(body);
    if (method === "POST" && /^\/api\/paypal\/orders\/[^/]+\/capture$/.test(pathname)) {
      throw error("Use the hosted PayPal capture endpoint.", 404);
    }
    throw error("Demo API route not found.", 404);
  };
}
