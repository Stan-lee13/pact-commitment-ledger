import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { FileStore } from "./src/store.mjs";
import { DomainError, addEvidence, createEngagement, getCurrentVersion, getEngagement, proposeChange, respondToVersion, updateDeliverableProgress } from "./src/domain.mjs";
import { AIUnavailableError, extractTerms } from "./src/ai.mjs";
import { PayPalError, PayPalSandbox, verifyCaptureAgainstExpected } from "./src/paypal.mjs";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(APP_DIR, "public");
const MAX_BODY_BYTES = 32 * 1024;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

function securityHeaders() {
  return {
    "Content-Security-Policy": "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self' https://www.sandbox.paypal.com; connect-src 'self' https://api-m.sandbox.paypal.com; img-src 'self' data:; style-src 'self'; frame-src https://www.sandbox.paypal.com; form-action 'self' https://www.sandbox.paypal.com",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cache-Control": "no-store"
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, { ...securityHeaders(), "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request body is too large."), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 }); }
}

function cleanStateForBrowser(state) {
  const copy = structuredClone(state);
  for (const engagement of copy.engagements) {
    if (engagement.payment?.requestIds) delete engagement.payment.requestIds;
  }
  return copy;
}

function getPayableAmount(engagement) {
  const version = getCurrentVersion(engagement);
  if (!version || version.status !== "accepted") throw new DomainError("A mutually accepted version is required before Sandbox checkout.", 409);
  const terms = version.terms;
  const amountMinor = terms.depositMinor ?? terms.amountMinor;
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new DomainError("Add a positive agreed amount before starting Sandbox checkout.");
  return { amountMinor, currency: terms.currency || "USD", version };
}

export async function createAppServer({ store: suppliedStore, paypal: suppliedPayPal, ai = extractTerms } = {}) {
  const dataFile = process.env.PACT_DATA_FILE
    ? path.resolve(process.env.PACT_DATA_FILE)
    : path.join(APP_DIR, "data", "store.json");
  const store = suppliedStore ?? new FileStore(dataFile);
  await store.init();
  const paypal = suppliedPayPal ?? new PayPalSandbox();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;
    try {
      if (pathname.startsWith("/api/")) {
        if (req.method === "GET" && pathname === "/api/state") {
          const state = cleanStateForBrowser(await store.snapshot());
          return sendJson(res, 200, {
            ...state,
            demoOnly: true,
            config: {
              ai: { mode: "local_ollama", model: process.env.PACT_AI_MODEL || "qwen3:4b-instruct" },
              paypal: { configured: Boolean(paypal.configured), clientId: paypal.publicClientId ?? null, environment: "sandbox" }
            }
          });
        }

        if (req.method === "POST" && pathname === "/api/engagements") {
          const body = await readJson(req);
          const engagement = await store.transact((state) => createEngagement(state, body, body.role || "provider"));
          return sendJson(res, 201, { engagement });
        }

        const changeMatch = pathname.match(/^\/api\/engagements\/([^/]+)\/changes$/);
        if (req.method === "POST" && changeMatch) {
          const body = await readJson(req);
          const version = await store.transact((state) => proposeChange(state, decodeURIComponent(changeMatch[1]), body, body.role, undefined));
          return sendJson(res, 201, { version });
        }

        const responseMatch = pathname.match(/^\/api\/engagements\/([^/]+)\/respond$/);
        if (req.method === "POST" && responseMatch) {
          const body = await readJson(req);
          const result = await store.transact((state) => respondToVersion(state, decodeURIComponent(responseMatch[1]), body.versionId, body.role, body.action, body.comment));
          return sendJson(res, 200, result);
        }

        const evidenceMatch = pathname.match(/^\/api\/engagements\/([^/]+)\/evidence$/);
        if (req.method === "POST" && evidenceMatch) {
          const body = await readJson(req, 700 * 1024);
          const evidence = await store.transact((state) => addEvidence(state, decodeURIComponent(evidenceMatch[1]), body, body.role));
          return sendJson(res, 201, { evidence });
        }

        const progressMatch = pathname.match(/^\/api\/engagements\/([^/]+)\/progress$/);
        if (req.method === "POST" && progressMatch) {
          const body = await readJson(req);
          const event = await store.transact((state) => updateDeliverableProgress(state, decodeURIComponent(progressMatch[1]), body, body.role));
          return sendJson(res, 200, { event });
        }

        if (req.method === "POST" && pathname === "/api/ai/extract") {
          const body = await readJson(req, 20 * 1024);
          const result = await ai({ sourceText: body.sourceText });
          return sendJson(res, 200, result);
        }

        if (req.method === "POST" && pathname === "/api/paypal/orders") {
          if (!paypal.configured) throw new PayPalError("PayPal Sandbox is disabled until server-side Sandbox credentials are configured.", 503);
          const body = await readJson(req);
          if (body.role !== "client") throw new DomainError("Switch to the client demo role to test buyer checkout.", 403);
          let reservation = await store.transact((state) => {
            const engagement = getEngagement(state, body.engagementId);
            if (engagement.payment.status === "captured") return { alreadyCaptured: true, orderId: engagement.payment.orderId };
            if (engagement.payment.orderId) return { existingOrder: true, orderId: engagement.payment.orderId };
            if (engagement.payment.status === "creating") return { busy: true };
            const { amountMinor, currency, version } = getPayableAmount(engagement);
            const requestId = engagement.payment.requestIds?.create || randomUUID();
            engagement.payment.requestIds ??= { create: null, capture: null };
            engagement.payment.requestIds.create = requestId;
            engagement.payment.status = "creating";
            engagement.payment.amountMinor = amountMinor;
            engagement.payment.currency = currency;
            engagement.payment.versionId = version.id;
            engagement.payment.updatedAt = new Date().toISOString();
            return { requestId, engagementId: engagement.id, title: engagement.title, amountMinor, currency };
          });
          if (reservation.alreadyCaptured) return sendJson(res, 409, { error: "This Sandbox payment is already captured.", orderId: reservation.orderId });
          if (reservation.existingOrder) return sendJson(res, 200, { orderId: reservation.orderId, clientId: paypal.publicClientId, merchantNotice: "Sandbox payment only; the captured funds belong to the configured Sandbox merchant account, not the service provider." });
          if (reservation.busy) return sendJson(res, 409, { error: "A Sandbox order is already being created. Wait briefly and refresh." });
          try {
            const order = await paypal.createOrder({ ...reservation, requestId: reservation.requestId });
            await store.transact((state) => {
              const engagement = getEngagement(state, reservation.engagementId);
              if (engagement.payment.requestIds?.create === reservation.requestId) {
                engagement.payment.orderId = order.id;
                engagement.payment.status = "created";
                engagement.payment.updatedAt = new Date().toISOString();
                engagement.events.push({ id: randomUUID(), type: "sandbox_order_created", actor: "client", at: engagement.payment.updatedAt, label: `PayPal Sandbox order ${order.id} created for the configured test merchant. This is not a provider payout.` });
              }
            });
            return sendJson(res, 201, { orderId: order.id, clientId: paypal.publicClientId, merchantNotice: "Sandbox payment only; any capture goes to the configured Sandbox merchant account, not the service provider." });
          } catch (error) {
            await store.transact((state) => {
              const engagement = getEngagement(state, reservation.engagementId);
              if (engagement.payment.requestIds?.create === reservation.requestId) {
                engagement.payment.status = "unknown";
                engagement.payment.updatedAt = new Date().toISOString();
              }
            });
            throw error;
          }
        }

        const captureMatch = pathname.match(/^\/api\/paypal\/orders\/([^/]+)\/capture$/);
        if (req.method === "POST" && captureMatch) {
          if (!paypal.configured) throw new PayPalError("PayPal Sandbox is disabled until server-side Sandbox credentials are configured.", 503);
          const body = await readJson(req);
          if (body.role !== "client") throw new DomainError("Switch to the client demo role to test buyer checkout.", 403);
          const orderId = decodeURIComponent(captureMatch[1]);
          const reservation = await store.transact((state) => {
            const engagement = getEngagement(state, body.engagementId);
            if (engagement.payment.orderId !== orderId) throw new DomainError("This order does not belong to the selected agreement.", 404);
            if (engagement.payment.status === "captured") return { alreadyCaptured: true, captureId: engagement.payment.captureId };
            if (engagement.payment.status === "capturing") return { busy: true };
            const requestId = engagement.payment.requestIds?.capture || randomUUID();
            engagement.payment.requestIds ??= { create: null, capture: null };
            engagement.payment.requestIds.capture = requestId;
            engagement.payment.status = "capturing";
            engagement.payment.updatedAt = new Date().toISOString();
            return { engagementId: engagement.id, requestId, amountMinor: engagement.payment.amountMinor, currency: engagement.payment.currency };
          });
          if (reservation.alreadyCaptured) return sendJson(res, 200, { status: "captured", captureId: reservation.captureId, alreadyCaptured: true });
          if (reservation.busy) return sendJson(res, 409, { error: "A Sandbox capture is already being processed. Wait and refresh." });
          try {
            const order = await paypal.captureOrder(orderId, reservation.requestId);
            const verified = verifyCaptureAgainstExpected(order, reservation);
            const updated = await store.transact((state) => {
              const engagement = getEngagement(state, reservation.engagementId);
              if (engagement.payment.orderId !== orderId || engagement.payment.requestIds?.capture !== reservation.requestId) {
                throw new DomainError("Payment record changed during capture; reconcile before retrying.", 409);
              }
              engagement.payment.status = verified.status;
              engagement.payment.captureId = verified.captureId;
              engagement.payment.updatedAt = new Date().toISOString();
              engagement.payment.verified = verified.verified;
              engagement.events.push({
                id: randomUUID(), type: verified.verified ? "sandbox_payment_captured" : "sandbox_payment_unresolved",
                actor: "server", at: engagement.payment.updatedAt,
                label: verified.verified
                  ? `PayPal Sandbox capture ${verified.captureId} was confirmed for the configured test merchant. It is not a provider payout and does not prove delivery.`
                  : "PayPal Sandbox returned a status that does not prove a matching completed capture. Payment remains unresolved."
              });
              return engagement.payment;
            });
            return sendJson(res, verified.verified ? 200 : 202, { payment: updated, merchantNotice: "Sandbox only; funds are captured by the configured test merchant, not paid out to the freelancer." });
          } catch (error) {
            await store.transact((state) => {
              const engagement = getEngagement(state, reservation.engagementId);
              if (engagement.payment.orderId === orderId && engagement.payment.requestIds?.capture === reservation.requestId) {
                engagement.payment.status = "unknown";
                engagement.payment.updatedAt = new Date().toISOString();
              }
            });
            throw error;
          }
        }

        return sendJson(res, 404, { error: "API route not found." });
      }

      if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "Method not allowed." });
      let requestedPath = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
      if (requestedPath.includes("\\") || requestedPath.includes("\0")) return sendJson(res, 400, { error: "Invalid path." });
      const filePath = path.resolve(PUBLIC_DIR, `.${requestedPath}`);
      if (filePath !== PUBLIC_DIR && !filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) return sendJson(res, 403, { error: "Forbidden." });
      const content = await readFile(filePath);
      res.writeHead(200, { ...securityHeaders(), "content-type": MIME[path.extname(filePath)] || "application/octet-stream" });
      res.end(req.method === "HEAD" ? undefined : content);
    } catch (error) {
      if (!res.headersSent) {
        const status = Number.isInteger(error.status) ? error.status : 500;
        if (status >= 500) console.error("Request failed:", error.name, error.message);
        sendJson(res, status, { error: error.message || "Unexpected server error." });
      } else {
        res.destroy();
      }
    }
  });

  return { server, store, paypal };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server } = await createAppServer();
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 3000);
  server.listen(port, host, () => console.log(`PACT prototype listening at http://${host}:${port}`));
}
