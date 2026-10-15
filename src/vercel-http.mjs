const buckets = new Map();

export function sendJson(res, status, payload) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.end(JSON.stringify(payload));
}

export function sendMethodNotAllowed(res, allowed) {
  res.setHeader("Allow", allowed);
  sendJson(res, 405, { error: `Use ${allowed}.` });
}

export async function readJson(req, maxBytes = 20 * 1024) {
  let raw = req.body;
  if (raw !== undefined && raw !== null) {
    if (Buffer.isBuffer(raw)) raw = raw.toString("utf8");
    if (typeof raw === "string") {
      if (Buffer.byteLength(raw, "utf8") > maxBytes) throw Object.assign(new Error("Request body is too large."), { status: 413 });
      try { raw = JSON.parse(raw); }
      catch { throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 }); }
    } else if (typeof raw === "object") {
      if (Buffer.byteLength(JSON.stringify(raw), "utf8") > maxBytes) throw Object.assign(new Error("Request body is too large."), { status: 413 });
    } else {
      throw Object.assign(new Error("Request body must be a JSON object."), { status: 400 });
    }
    if (!raw || Array.isArray(raw) || typeof raw !== "object") throw Object.assign(new Error("Request body must be a JSON object."), { status: 400 });
    return raw;
  }

  const chunks = [];
  let size = 0;
  if (typeof req[Symbol.asyncIterator] === "function") {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) throw Object.assign(new Error("Request body is too large."), { status: 413 });
      chunks.push(chunk);
    }
  }
  if (!size) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || Array.isArray(body) || typeof body !== "object") throw new Error("shape");
    return body;
  } catch {
    throw Object.assign(new Error("Request body must be a JSON object."), { status: 400 });
  }
}

function clientKey(req) {
  const forwarded = String(req.headers?.["x-forwarded-for"] ?? "").split(",")[0].trim();
  return forwarded || String(req.socket?.remoteAddress ?? "unknown");
}

export function allowRequest(req, scope, { limit = 6, windowMs = 60_000, now = Date.now() } = {}) {
  const key = `${scope}:${clientKey(req)}`;
  const current = buckets.get(key);
  if (!current || now - current.startedAt >= windowMs) {
    buckets.set(key, { startedAt: now, count: 1 });
    if (buckets.size > 2000) {
      for (const [entry, value] of buckets) if (now - value.startedAt >= windowMs) buckets.delete(entry);
    }
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}
