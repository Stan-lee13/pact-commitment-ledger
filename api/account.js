import { allowRequest, readJson, sendJson, sendMethodNotAllowed } from "../src/vercel-http.mjs";

const MAX_BODY_BYTES = 1_700_000;
const SESSION_COOKIE = "pact_demo_session";
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const ALLOWED_OPERATIONS = new Set([
  "register", "login", "session", "logout", "create_workspace",
  "join_workspace", "rotate_key", "request"
]);

function parseCookie(req) {
  const raw = String(req.headers?.cookie || "");
  for (const entry of raw.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0 || entry.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    const value = entry.slice(separator + 1).trim();
    return TOKEN_PATTERN.test(value) ? value : "";
  }
  return "";
}

function cookieValue(token, maxAge) {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

function safeWorkerUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".workers.dev")
      || url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function forwardBody(operation, body, sessionToken) {
  const payload = { action: "account", operation };
  if (sessionToken) payload.sessionToken = sessionToken;
  if (operation === "register" || operation === "create_workspace") payload.fictionalConfirmed = body.fictionalConfirmed === true;
  if (operation === "login") {
    payload.handle = String(body.handle || "");
    payload.accountKey = String(body.accountKey || "");
  }
  if (operation === "join_workspace") payload.inviteToken = String(body.inviteToken || "");
  if (operation === "request") {
    const path = String(body.path || "");
    if (path.startsWith("/api/paypal")) return null;
    payload.workspaceId = String(body.workspaceId || "");
    payload.path = path;
    payload.method = String(body.method || "GET").toUpperCase();
    payload.body = body.body && typeof body.body === "object" && !Array.isArray(body.body) ? body.body : {};
  }
  return payload;
}

export function createAccountHandler(environment = process.env, fetchImpl = globalThis.fetch) {
  return async function handler(req, res) {
    if (req.method !== "POST") return sendMethodNotAllowed(res, "POST");
    let payload;
    try { payload = await readJson(req, MAX_BODY_BYTES); }
    catch (error) { return sendJson(res, error.status || 400, { error: error.message }); }
    const operation = String(payload.operation || "");
    if (!ALLOWED_OPERATIONS.has(operation)) return sendJson(res, 404, { error: "Unknown demo account operation." });

    const workerUrl = safeWorkerUrl(environment.PACT_SHARED_STORAGE_URL);
    if (!workerUrl) return sendJson(res, 503, { error: "Pseudonymous demo accounts are temporarily unavailable." });
    let publicOrigin;
    try { publicOrigin = new URL(environment.PACT_PUBLIC_URL).origin; }
    catch { publicOrigin = ""; }
    const origin = String(req.headers?.origin || "");
    if (!origin || !publicOrigin || origin !== publicOrigin) return sendJson(res, 403, { error: "Demo account requests must come from the PACT public demo." });
    if (req.headers?.["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") {
      return sendJson(res, 403, { error: "Demo account requests must be same-origin." });
    }
    const limit = operation === "register" ? 5 : operation === "login" ? 12 : 30;
    if (!allowRequest(req, `demo-account-${operation}`, { limit, windowMs: 60_000 })) {
      return sendJson(res, 429, { error: "Too many demo account requests. Wait a minute and retry." });
    }

    const sessionToken = parseCookie(req);
    const workerPayload = forwardBody(operation, payload, sessionToken);
    if (!workerPayload) return sendJson(res, 403, { error: "PayPal is disabled in account workspaces." });
    if (operation === "request" && (!/^([a-f0-9-]{36})$/i.test(workerPayload.workspaceId) || !workerPayload.path.startsWith("/api/"))) {
      return sendJson(res, 400, { error: "A valid demo workspace and API path are required." });
    }
    if (!fetchImpl) return sendJson(res, 503, { error: "Pseudonymous demo accounts are temporarily unavailable." });

    try {
      const forwardedIp = String(req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
      const workerResponse = await fetchImpl(workerUrl.href, {
        method: "POST",
        headers: { "content-type": "application/json", "x-pact-client-ip": forwardedIp },
        body: JSON.stringify(workerPayload),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(10_000)
      });
      let result;
      try { result = await workerResponse.json(); }
      catch { return sendJson(res, 503, { error: "The demo account service returned an unreadable response." }); }
      if (operation === "logout" || (operation === "session" && result.authenticated === false)) {
        res.setHeader("Set-Cookie", cookieValue("", 0));
      }
      if (!workerResponse.ok) return sendJson(res, workerResponse.status, { error: result.error || "The demo account request could not be completed." });
      if ((operation === "register" || operation === "login") && TOKEN_PATTERN.test(String(result.sessionToken || ""))) {
        res.setHeader("Set-Cookie", cookieValue(result.sessionToken, 7 * 24 * 60 * 60));
        delete result.sessionToken;
      }
      return sendJson(res, workerResponse.status, result);
    } catch (error) {
      return sendJson(res, error.status || 503, {
        error: error.status ? error.message : "The demo account service could not be reached. Try again shortly."
      });
    }
  };
}

export default createAccountHandler();
