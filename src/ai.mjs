const allowedFields = new Set([
  "deliverables", "revisionLimit", "dueDate", "amount", "deposit", "paymentTerms", "completionCriteria", "other"
]);

export class AIUnavailableError extends Error {
  constructor(message = "Local AI is unavailable. Start Ollama and check the configured model.") {
    super(message);
    this.name = "AIUnavailableError";
    this.status = 503;
  }
}

function parseJson(text) {
  const cleaned = String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(cleaned); }
  catch { throw new AIUnavailableError("The local model did not return valid structured output. Try a shorter source note."); }
}

export async function extractTerms({ sourceText, fetchImpl = globalThis.fetch, model = process.env.PACT_AI_MODEL || "qwen3:4b-instruct", baseUrl = process.env.OLLAMA_URL || "http://127.0.0.1:11434" }) {
  const source = String(sourceText ?? "").trim();
  if (source.length < 20) throw Object.assign(new Error("Paste at least 20 characters of source text."), { status: 400 });
  if (source.length > 15000) throw Object.assign(new Error("Keep the source note under 15,000 characters."), { status: 413 });

  const prompt = "You are a literal fact extractor, not an adviser. Extract every explicit project fact in the source. Map facts only to: deliverables, revisionLimit, dueDate, amount, deposit, paymentTerms, completionCriteria, or other. For each candidate provide the value and the shortest useful exactQuote: a contiguous substring copied verbatim from the source that contains the value (ideally under 180 characters). If a fact is explicit, include it; do not ask a question instead of extracting it. Do not infer, calculate, fill gaps, or decide what either party meant. If something is ambiguous, say why and ask a neutral question. Return only JSON with this shape: {\"candidates\":[{\"field\":\"...\",\"value\":\"...\",\"exactQuote\":\"...\",\"ambiguity\":\"\"}],\"clarifyingQuestions\":[]}. Example: for \"Deliver by November 20, 2026\" return {\"field\":\"dueDate\",\"value\":\"November 20, 2026\",\"exactQuote\":\"Deliver by November 20, 2026\",\"ambiguity\":\"\"}.";

  let response;
  try {
    response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model, stream: false, format: "json",
        options: { temperature: 0, num_predict: 1200 },
        messages: [{ role: "system", content: prompt }, { role: "user", content: source }]
      }),
      signal: AbortSignal.timeout(90000)
    });
  } catch {
    throw new AIUnavailableError();
  }
  if (!response.ok) throw new AIUnavailableError(`Ollama returned HTTP ${response.status}. Check that the local model is available.`);
  let payload;
  try { payload = await response.json(); }
  catch { throw new AIUnavailableError("Ollama returned an unreadable response."); }
  const parsed = parseJson(payload?.message?.content);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.candidates) || !Array.isArray(parsed.clarifyingQuestions)) {
    throw new AIUnavailableError("The local model returned an unexpected JSON shape. Try again or enter terms manually.");
  }
  const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
  const safeCandidates = candidates.slice(0, 40).map((item) => {
    const field = String(item?.field ?? "");
    if (!allowedFields.has(field)) return null;
    const value = String(item?.value ?? "").trim().slice(0, 600);
    const exactQuote = String(item?.exactQuote ?? "").trim().slice(0, 1000);
    const quoteVerified = Boolean(value && exactQuote)
      && exactQuote.length <= 260
      && source.includes(exactQuote)
      && exactQuote.toLocaleLowerCase().includes(value.toLocaleLowerCase());
    return {
      field, value, exactQuote, quoteVerified,
      ambiguity: item?.ambiguity ? String(item.ambiguity).slice(0, 500) : null,
      requiresHumanConfirmation: true
    };
  }).filter((item) => item && item.value);

  return {
    model,
    processing: "local_ollama",
    candidates: safeCandidates,
    clarifyingQuestions: Array.isArray(parsed?.clarifyingQuestions)
      ? parsed.clarifyingQuestions.slice(0, 8).map((item) => String(item).slice(0, 300))
      : [],
    sourceLength: source.length,
    note: "Suggestions only. Verify every quote and edit the terms yourself before sending."
  };
}
