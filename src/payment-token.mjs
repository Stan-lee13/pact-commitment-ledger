import { createHmac, timingSafeEqual } from "node:crypto";

function signatureFor(encoded, key) {
  return createHmac("sha256", key).update(encoded).digest("base64url");
}

export function createPaymentQuoteToken(input, key, { now = Date.now(), ttlSeconds = 6 * 60 * 60 } = {}) {
  if (typeof key !== "string" || key.length < 32) throw new Error("Payment signing key is not configured.");
  const payload = {
    v: 1,
    orderId: String(input.orderId ?? ""),
    engagementId: String(input.engagementId ?? ""),
    versionId: String(input.versionId ?? ""),
    amountMinor: input.amountMinor,
    currency: String(input.currency ?? ""),
    captureRequestId: String(input.captureRequestId ?? ""),
    issuedAt: Math.floor(now / 1000),
    expiresAt: Math.floor(now / 1000) + ttlSeconds
  };
  if (!payload.orderId || !payload.engagementId || !payload.versionId
    || !Number.isSafeInteger(payload.amountMinor) || payload.amountMinor <= 0
    || payload.currency !== "USD" || !payload.captureRequestId || payload.captureRequestId.length > 38) {
    throw new Error("Payment quote is incomplete.");
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${signatureFor(encoded, key)}`;
}

export function verifyPaymentQuoteToken(token, key, orderId, { now = Date.now() } = {}) {
  if (typeof key !== "string" || key.length < 32 || typeof token !== "string" || token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = Buffer.from(signatureFor(parts[0], key));
  const received = Buffer.from(parts[1]);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); }
  catch { return null; }
  const seconds = Math.floor(now / 1000);
  if (payload?.v !== 1 || payload.orderId !== String(orderId)
    || typeof payload.engagementId !== "string" || !payload.engagementId
    || typeof payload.versionId !== "string" || !payload.versionId
    || !Number.isSafeInteger(payload.amountMinor) || payload.amountMinor <= 0
    || payload.currency !== "USD" || typeof payload.captureRequestId !== "string"
    || payload.captureRequestId.length < 1 || payload.captureRequestId.length > 38
    || !Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt)
    || payload.issuedAt > seconds + 60 || payload.expiresAt < seconds || payload.expiresAt - payload.issuedAt > 6 * 60 * 60) return null;
  return payload;
}
