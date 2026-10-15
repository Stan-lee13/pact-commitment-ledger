import { randomUUID } from "node:crypto";
import { getSandboxApprovalUrl, PayPalError, PayPalSandbox } from "../../src/paypal.mjs";
import { createPaymentQuoteToken } from "../../src/payment-token.mjs";
import { allowRequest, readJson, sendJson, sendMethodNotAllowed } from "../../src/vercel-http.mjs";

export function createPayPalOrderHandler({ environment = process.env, paypalFactory, now = Date.now } = {}) {
  return async function handler(req, res) {
    if (req.method !== "POST") return sendMethodNotAllowed(res, "POST");
    if (!allowRequest(req, "paypal-create", { limit: 5, windowMs: 60_000, now: now() })) {
      return sendJson(res, 429, { error: "Sandbox order rate limit reached. Wait a minute and try again." });
    }
    if (environment.PAYPAL_ENV !== "sandbox" || !environment.PAYPAL_CLIENT_ID || !environment.PAYPAL_CLIENT_SECRET) {
      return sendJson(res, 503, { error: "PayPal Sandbox checkout is not configured." });
    }
    if (typeof environment.PACT_PAYMENT_SIGNING_KEY !== "string" || environment.PACT_PAYMENT_SIGNING_KEY.length < 32) {
      return sendJson(res, 503, { error: "Sandbox checkout is not configured." });
    }
    try {
      const body = await readJson(req);
      if (body.role !== "client") return sendJson(res, 403, { error: "Switch to the client demo role to test buyer checkout." });
      const engagementId = String(body.engagementId ?? "").trim();
      const title = String(body.title ?? "PACT Sandbox demo").trim().slice(0, 127);
      const version = body.acceptedVersion;
      if (!engagementId || engagementId.length > 127 || !version || version.id !== body.versionId
        || version.status !== "accepted" || !Array.isArray(version.acceptedBy)
        || !version.acceptedBy.includes("provider") || !version.acceptedBy.includes("client")) {
        return sendJson(res, 409, { error: "A mutually accepted version is required before Sandbox checkout." });
      }
      const terms = version.terms ?? {};
      const amountMinor = terms.depositMinor ?? terms.amountMinor;
      const currency = String(terms.currency ?? "USD").toUpperCase();
      if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > 1_000_000_000) {
        return sendJson(res, 400, { error: "Add a positive agreed amount before starting Sandbox checkout." });
      }
      if (terms.amountMinor != null && terms.depositMinor != null
        && (!Number.isSafeInteger(terms.amountMinor) || terms.depositMinor > terms.amountMinor)) {
        return sendJson(res, 400, { error: "The deposit cannot exceed the total agreed amount." });
      }
      if (currency !== "USD") return sendJson(res, 400, { error: "The PayPal Sandbox demo currently supports USD only." });
      const requestId = String(body.requestId ?? "");
      if (!/^[A-Za-z0-9_-]{1,38}$/.test(requestId)) return sendJson(res, 400, { error: "A valid unique Sandbox order request ID is required." });
      const paypal = paypalFactory ? paypalFactory() : new PayPalSandbox({
        clientId: environment.PAYPAL_CLIENT_ID,
        clientSecret: environment.PAYPAL_CLIENT_SECRET,
        env: environment.PAYPAL_ENV
      });
      let publicBase;
      try { publicBase = new URL(environment.PACT_PUBLIC_URL || "https://pact-commitment-ledger.vercel.app"); }
      catch { return sendJson(res, 503, { error: "PayPal return routing is not configured." }); }
      if (publicBase.protocol !== "https:" || publicBase.username || publicBase.password) {
        return sendJson(res, 503, { error: "PayPal return routing must use a public HTTPS origin." });
      }
      const returnUrl = new URL("/", publicBase.origin);
      returnUrl.searchParams.set("paypal", "return");
      returnUrl.searchParams.set("engagementId", engagementId);
      const cancelUrl = new URL("/", publicBase.origin);
      cancelUrl.searchParams.set("paypal", "cancel");
      cancelUrl.searchParams.set("engagementId", engagementId);
      const order = await paypal.createOrder({
        engagementId, title, amountMinor, currency, requestId,
        returnUrl: returnUrl.href, cancelUrl: cancelUrl.href
      });
      const approvalUrl = getSandboxApprovalUrl(order);
      const quoteToken = createPaymentQuoteToken({
        orderId: order.id,
        engagementId,
        versionId: version.id,
        amountMinor,
        currency,
        captureRequestId: randomUUID()
      }, environment.PACT_PAYMENT_SIGNING_KEY, { now: now() });
      return sendJson(res, 201, {
        orderId: order.id,
        quoteToken,
        approvalUrl,
        merchantNotice: "Sandbox only. Any capture goes to the configured test merchant account, not the service provider."
      });
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : (error instanceof PayPalError ? error.status : 502);
      return sendJson(res, status, { error: status >= 500 ? "PayPal Sandbox could not create the test order. Try again after checking the order state." : error.message });
    }
  };
}

export default createPayPalOrderHandler();
