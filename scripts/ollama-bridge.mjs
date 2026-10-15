import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { extractTerms } from "../src/ai.mjs";

const token = String(process.env.PACT_AI_BRIDGE_TOKEN ?? "");
const port = Number(process.env.PORT || 4174);
const host = process.env.HOST || "0.0.0.0";
const model = process.env.PACT_AI_MODEL || "qwen3:4b-instruct";
const maxBodyBytes = 20 * 1024;
const bucket = { startedAt: Date.now(), count: 0 };
let active = 0;

if (token.length < 32) throw new Error("PACT_AI_BRIDGE_TOKEN must be a random token of at least 32 characters.");

function sameToken(candidate) {
  const left = Buffer.from(String(candidate ?? ""));
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}
function send(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, max-age=0",
    "x-content-type-options": "nosniff"
  });
  res.end(JSON.stringify(payload));
}
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw Object.assign(new Error("Request body is too large."), { status: 413 });
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("shape");
    return body;
  } catch {
    throw Object.assign(new Error("Request body must be a JSON object."), { status: 400 });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { status: "ok", model, inference: "local_ollama" });
  if (req.method !== "POST" || url.pathname !== "/extract") return send(res, 404, { error: "Not found." });
  if (!sameToken(req.headers["x-pact-bridge-token"])) return send(res, 401, { error: "Unauthorized." });
  const now = Date.now();
  if (now - bucket.startedAt >= 60_000) { bucket.startedAt = now; bucket.count = 0; }
  if (bucket.count >= 20) return send(res, 429, { error: "Temporary AI service rate limit reached." });
  if (active >= 2) return send(res, 503, { error: "Temporary AI service is busy. Try again shortly." });
  bucket.count += 1;
  active += 1;
  try {
    const body = await readJson(req);
    const result = await extractTerms({ sourceText: body.sourceText, model });
    return send(res, 200, result);
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 503;
    const message = status === 400 || status === 413 ? error.message : "The local AI model is unavailable or returned an unusable response.";
    return send(res, status, { error: message });
  } finally {
    active -= 1;
  }
});

server.listen(port, host, () => console.log(`PACT temporary AI bridge listening on ${host}:${port} using ${model}.`));
server.on("error", (error) => {
  console.error(`PACT AI bridge failed: ${error.name}`);
  process.exitCode = 1;
});
