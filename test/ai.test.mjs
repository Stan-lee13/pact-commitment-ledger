import test from "node:test";
import assert from "node:assert/strict";
import { extractTerms, AIUnavailableError } from "../src/ai.mjs";

const source = "Deliver five pages by November 20, 2026. Total fee is USD 850.";

test("AI extraction marks exact source quotes and flags hallucinated quotes", async () => {
  const fakeFetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.messages[1].content, source);
    return new Response(JSON.stringify({ message: { content: JSON.stringify({
      candidates: [
        { field: "dueDate", value: "November 20, 2026", exactQuote: "by November 20, 2026", ambiguity: null },
        { field: "amount", value: "USD 850", exactQuote: "Total fee is USD 85-0", ambiguity: null },
        { field: "amount", value: "USD 999", exactQuote: "Total fee is USD 850", ambiguity: null },
        { field: "merchant_account", value: "send funds to provider", exactQuote: "Total fee is USD 850", ambiguity: null }
      ], clarifyingQuestions: []
    }) } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await extractTerms({ sourceText: source, fetchImpl: fakeFetch });
  assert.equal(result.processing, "local_ollama");
  assert.equal(result.candidates.length, 3, "unknown schema fields are rejected");
  assert.equal(result.candidates[0].quoteVerified, true);
  assert.equal(result.candidates[0].requiresHumanConfirmation, true);
  assert.equal(result.candidates[1].quoteVerified, false);
  assert.equal(result.candidates[2].quoteVerified, false, "a matching quote must also contain the proposed value");
});

test("AI refuses an empty source and handles unavailable local inference", async () => {
  await assert.rejects(() => extractTerms({ sourceText: "too short" }), /at least 20 characters/);
  await assert.rejects(() => extractTerms({ sourceText: source, fetchImpl: async () => { throw new Error("offline"); } }), AIUnavailableError);
  const badShape = async () => new Response(JSON.stringify({ message: { content: JSON.stringify({ unexpected: [] }) } }), { status: 200 });
  await assert.rejects(() => extractTerms({ sourceText: source, fetchImpl: badShape }), /unexpected JSON shape/);
});
