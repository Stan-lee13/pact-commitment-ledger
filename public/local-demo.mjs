import {
  addEvidence,
  createEngagement,
  getEngagement,
  proposeChange,
  respondToVersion
} from "./domain.mjs";

export const PUBLIC_DEMO_STORAGE_KEY = "pact.public-demo.v1";
const clone = (value) => structuredClone(value);

function error(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export function createLocalDemoApi({ initialState, storage = globalThis.localStorage, key = PUBLIC_DEMO_STORAGE_KEY }) {
  let queue = Promise.resolve();

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
      storage.setItem(key, JSON.stringify(state));
      return clone(result);
    });
    queue = operation.catch(() => undefined);
    return operation;
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
        config: {
          publicDemo: true,
          storage: "browser_local",
          ai: { enabled: false, mode: "disabled", model: null },
          paypal: { configured: false, clientId: null, environment: "sandbox" }
        }
      };
    }

    if (method === "POST" && pathname === "/api/engagements") {
      return transact((state) => ({ engagement: createEngagement(state, body, body.role || "provider") }));
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

    if (method === "POST" && pathname === "/api/ai/extract") {
      throw error("AI extraction is disabled in the public demo. Run the local app with Ollama for private local extraction.", 503);
    }
    if (method === "POST" && (pathname === "/api/paypal/orders" || /^\/api\/paypal\/orders\/[^/]+\/capture$/.test(pathname))) {
      throw error("PayPal Sandbox checkout is disabled in the public demo. No payment is processed.", 503);
    }
    throw error("Demo API route not found.", 404);
  };
}
