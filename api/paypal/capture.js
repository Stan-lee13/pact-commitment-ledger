import { PayPalError, PayPalSandbox, verifyCaptureAgainstExpected } from "../../src/paypal.mjs";
import { verifyPaymentQuoteToken } from "../../src/payment-token.mjs";
import { allowRequest, readJson, sendJson, sendMethodNotAllowed } from "../../src/vercel-http.mjs";

export function createPayPalCaptureHandler({ environment = process.env, paypalFactory, now = Date.now } = {}) {
  return async function handler(req, res) {
    if (req.method !== "POST") return sendMethodNotAllowed(res, "POST");
    if (!allowRequest(req, "paypal-capture", { limit: 5, windowMs: 60_000, now: now() })) {
      return sendJson(res, 429, { error: "Sandbox capture rate limit reached. Wait a minute and try again." });
    }
    if (environment.PAYPAL_ENV !== "sandbox" || !environment.PAYPAL_CLIENT_ID || !environment.PAYPAL_CLIENT_SECRET
      || typeof environment.PACT_PAYMENT_SIGNING_KEY !== "string" || environment.PACT_PAYMENT_SIGNING_KEY.length < 32) {
      return sendJson(res, 503, { error: "PayPal Sandbox checkout is not configured." });
    }
    try {
      const body = await readJson(req);
      if (body.role !== "client") return sendJson(res, 403, { error: "Switch to the client demo role to capture this Sandbox order." });
      const orderId = String(body.orderId ?? "");
      const engagementId = String(body.engagementId ?? "");
      const quote = verifyPaymentQuoteToken(body.quoteToken, environment.PACT_PAYMENT_SIGNING_KEY, orderId, { now: now() });
      if (!quote || quote.engagementId !== engagementId) return sendJson(res, 403, { error: "This Sandbox capture quote is invalid, expired, or belongs to another agreement." });
      const paypal = paypalFactory ? paypalFactory() : new PayPalSandbox({
        clientId: environment.PAYPAL_CLIENT_ID,
        clientSecret: environment.PAYPAL_CLIENT_SECRET,
        env: environment.PAYPAL_ENV
      });
      const existing = await paypal.getOrder(orderId);
      let capture = existing;
      if (existing?.status !== "COMPLETED") {
        if (existing?.status !== "APPROVED") return sendJson(res, 409, { error: "PayPal has not approved this order yet. Complete the Sandbox buyer approval first." });
        capture = await paypal.captureOrder(orderId, quote.captureRequestId);
      }
      const verified = verifyCaptureAgainstExpected(capture, quote);
      const payment = {
        status: verified.status,
        verified: verified.verified,
        captureId: verified.captureId,
        amountMinor: verified.verified ? verified.amountMinor : quote.amountMinor,
        currency: quote.currency,
        orderId
      };
      if (!verified.verified) return sendJson(res, 202, {
        payment,
        merchantNotice: "The capture response did not confirm a matching completed amount and currency. Treat payment as unresolved."
      });
      return sendJson(res, 200, {
        payment,
        merchantNotice: "Sandbox only. The captured funds belong to the configured test merchant, not the service provider. Payment does not prove delivery."
      });
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : (error instanceof PayPalError ? error.status : 502);
      return sendJson(res, status, { error: status >= 500 ? "PayPal Sandbox could not confirm the capture. The payment may be unresolved; check the original order before retrying." : error.message });
    }
  };
}

export default createPayPalCaptureHandler();
