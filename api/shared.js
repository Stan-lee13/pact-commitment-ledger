import { allowRequest, readJson, sendJson, sendMethodNotAllowed } from "../src/vercel-http.mjs";

const MAX_BODY_BYTES = 1_700_000;

export function createSharedHandler(environment = process.env, fetchImpl = globalThis.fetch) {
  return async function handler(req, res) {
    if (req.method !== "POST") return sendMethodNotAllowed(res, "POST");
    try {
      const configuredUrl = environment.PACT_SHARED_STORAGE_URL;
      if (!configuredUrl) return sendJson(res, 503, { error: "Shared D1 demo storage is not configured yet." });
      let workerUrl;
      try { workerUrl = new URL(configuredUrl); }
      catch { return sendJson(res, 503, { error: "Shared D1 demo storage is not configured correctly." }); }
      if (workerUrl.protocol !== "https:" || !workerUrl.hostname.endsWith(".workers.dev")) {
        return sendJson(res, 503, { error: "Shared D1 demo storage endpoint is not an approved HTTPS Worker URL." });
      }
      const publicOrigin = (() => {
        try { return new URL(environment.PACT_PUBLIC_URL).origin; } catch { return ""; }
      })();
      const origin = String(req.headers?.origin || "");
      if (!origin || !publicOrigin || origin !== publicOrigin) {
        return sendJson(res, 403, { error: "Shared demo requests must come from the PACT public demo." });
      }
      if (!allowRequest(req, "shared-demo", { limit: 24, windowMs: 60_000 })) {
        return sendJson(res, 429, { error: "Too many shared demo requests. Wait a minute and retry." });
      }
      const payload = await readJson(req, MAX_BODY_BYTES);
      if (!fetchImpl) return sendJson(res, 503, { error: "Shared D1 demo storage is temporarily unavailable." });
      const forwardedIp = String(req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
      const workerResponse = await fetchImpl(workerUrl.href, {
        method: "POST",
        headers: { "content-type": "application/json", "x-pact-client-ip": forwardedIp },
        body: JSON.stringify(payload),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(10_000)
      });
      let result;
      try { result = await workerResponse.json(); }
      catch { return sendJson(res, 503, { error: "Shared D1 demo storage returned an unreadable response." }); }
      if (workerResponse.ok && payload.action === "request" && payload.method === "GET" && new URL(payload.path || "/", "https://pact.invalid").pathname === "/api/state") {
        const aiEnabled = Boolean(environment.PACT_AI_ENDPOINT && environment.PACT_AI_BRIDGE_TOKEN);
        result.config = {
          ...(result.config || {}),
          ai: {
            enabled: aiEnabled,
            mode: aiEnabled ? "temporary_remote_ollama" : "disabled",
            model: aiEnabled ? (environment.PACT_AI_MODEL || "qwen3:4b-instruct") : null
          },
          paypal: { configured: false, environment: "sandbox" }
        };
      }
      return sendJson(res, workerResponse.status, result);
    } catch (error) {
      return sendJson(res, error.status || 503, {
        error: error.status ? error.message : "Shared D1 demo storage could not be reached. Your fictional record remains stored; retry shortly."
      });
    }
  };
}

export default createSharedHandler();
