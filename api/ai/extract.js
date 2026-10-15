import { allowRequest, readJson, sendJson, sendMethodNotAllowed } from "../../src/vercel-http.mjs";

const allowedFields = new Set(["deliverables", "revisionLimit", "dueDate", "amount", "deposit", "paymentTerms", "completionCriteria", "other"]);

function safeResult(payload, sourceText, model) {
  if (!payload || !Array.isArray(payload.candidates) || !Array.isArray(payload.clarifyingQuestions)) {
    throw Object.assign(new Error("The AI service returned an unexpected response. Try again or enter terms manually."), { status: 502 });
  }
  const candidates = payload.candidates.slice(0, 40).map((item) => {
    const field = String(item?.field ?? "");
    if (!allowedFields.has(field)) return null;
    const value = String(item?.value ?? "").trim().slice(0, 600);
    const exactQuote = String(item?.exactQuote ?? "").trim().slice(0, 1000);
    if (!value) return null;
    const quoteVerified = Boolean(exactQuote) && exactQuote.length <= 260
      && sourceText.includes(exactQuote)
      && exactQuote.toLocaleLowerCase().includes(value.toLocaleLowerCase());
    return {
      field, value, exactQuote, quoteVerified,
      ambiguity: item?.ambiguity ? String(item.ambiguity).slice(0, 500) : null,
      requiresHumanConfirmation: true
    };
  }).filter(Boolean);
  return {
    model,
    processing: "temporary_local_ollama",
    candidates,
    clarifyingQuestions: payload.clarifyingQuestions.slice(0, 8).map((item) => String(item).slice(0, 300)),
    sourceLength: sourceText.length,
    note: "Suggestions only. Verify every quote and edit the terms yourself before sending. The selected text was sent to the temporary local-model bridge for this request."
  };
}

export function createAiExtractHandler({ environment = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  return async function handler(req, res) {
    if (req.method !== "POST") return sendMethodNotAllowed(res, "POST");
    if (!allowRequest(req, "ai-extract", { limit: 4, windowMs: 60_000, now: now() })) {
      return sendJson(res, 429, { error: "AI demo rate limit reached. Wait a minute and try again." });
    }
    const endpoint = String(environment.PACT_AI_ENDPOINT ?? "");
    const bridgeToken = String(environment.PACT_AI_BRIDGE_TOKEN ?? "");
    if (!endpoint || !bridgeToken) return sendJson(res, 503, { error: "AI suggestions are temporarily unavailable. Enter terms manually." });
    let target;
    try { target = new URL(endpoint); }
    catch { return sendJson(res, 503, { error: "AI suggestions are temporarily unavailable. Enter terms manually." }); }
    if (target.protocol !== "https:") return sendJson(res, 503, { error: "AI suggestions are temporarily unavailable. Enter terms manually." });

    try {
      const body = await readJson(req, 20 * 1024);
      const sourceText = String(body.sourceText ?? "").trim();
      if (sourceText.length < 20) return sendJson(res, 400, { error: "Paste at least 20 characters of source text." });
      if (sourceText.length > 15_000) return sendJson(res, 413, { error: "Keep the source note under 15,000 characters." });
      const response = await fetchImpl(target, {
        method: "POST",
        headers: { "content-type": "application/json", "x-pact-bridge-token": bridgeToken },
        body: JSON.stringify({ sourceText }),
        signal: AbortSignal.timeout(110_000)
      });
      if (!response.ok) return sendJson(res, response.status === 429 ? 429 : 503, { error: "The temporary AI service is busy or offline. Try again later or enter terms manually." });
      const payload = await response.json();
      return sendJson(res, 200, safeResult(payload, sourceText, environment.PACT_AI_MODEL || "qwen3:4b-instruct"));
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 503;
      const message = status === 400 || status === 413 ? error.message : "The temporary AI service is busy or offline. Try again later or enter terms manually.";
      return sendJson(res, status, { error: message });
    }
  };
}

export default createAiExtractHandler();
