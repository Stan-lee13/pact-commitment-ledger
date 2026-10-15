import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileStore } from "../src/store.mjs";
import { createAppServer } from "../server.mjs";

test("HTTP responses are no-store and CSP blocks unapproved scripts; AI calls are injected locally", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pact-headers-test-"));
  const { server } = await createAppServer({
    store: new FileStore(path.join(tempDir, "store.json")),
    paypal: { configured: false },
    ai: async ({ sourceText }) => ({ processing: "local_ollama", candidates: [{ field: "other", value: "example", exactQuote: sourceText, quoteVerified: true }] })
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const home = await fetch(base);
    assert.equal(home.status, 200);
    assert.equal(home.headers.get("cache-control"), "no-store");
    assert.match(home.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    const ai = await fetch(`${base}/api/ai/extract`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceText: "This synthetic note has more than twenty characters." }) });
    assert.equal(ai.status, 200);
    const data = await ai.json();
    assert.equal(data.processing, "local_ollama");
    const paypal = await fetch(`${base}/api/state`).then((response) => response.json());
    assert.equal(paypal.config.paypal.configured, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  }
});
