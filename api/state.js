import { sendJson, sendMethodNotAllowed } from "../src/vercel-http.mjs";

export function createStateHandler(environment = process.env) {
  return async function handler(req, res) {
    if (req.method !== "GET") return sendMethodNotAllowed(res, "GET");
    const paypalConfigured = environment.PAYPAL_ENV === "sandbox"
      && Boolean(environment.PAYPAL_CLIENT_ID && environment.PAYPAL_CLIENT_SECRET)
      && typeof environment.PACT_PAYMENT_SIGNING_KEY === "string"
      && environment.PACT_PAYMENT_SIGNING_KEY.length >= 32;
    const aiConfigured = Boolean(environment.PACT_AI_ENDPOINT && environment.PACT_AI_BRIDGE_TOKEN);
    return sendJson(res, 200, {
      demoOnly: true,
      config: {
        publicDemo: true,
        storage: "browser_local",
        sharedStorageAvailable: Boolean(environment.PACT_SHARED_STORAGE_URL),
        ai: {
          enabled: aiConfigured,
          mode: aiConfigured ? "temporary_remote_ollama" : "disabled",
          model: aiConfigured ? (environment.PACT_AI_MODEL || "qwen3:4b-instruct") : null
        },
        paypal: {
          configured: paypalConfigured,
          environment: "sandbox"
        }
      }
    });
  };
}

export default createStateHandler();
