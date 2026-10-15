export class PayPalError extends Error {
  constructor(message, status = 502, details = null) {
    super(message);
    this.name = "PayPalError";
    this.status = status;
    this.details = details;
  }
}

export function formatMinorAmount(minor) {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new PayPalError("Invalid payment amount.", 400);
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
}

export function getPayPalCapture(order) {
  const captures = [];
  for (const unit of order?.purchase_units ?? []) {
    for (const capture of unit?.payments?.captures ?? []) captures.push(capture);
  }
  return captures[0] ?? null;
}

export class PayPalSandbox {
  #clientId;
  #clientSecret;
  #fetch;
  #baseUrl;
  #token = null;
  #tokenExpiresAt = 0;

  constructor({ clientId = process.env.PAYPAL_CLIENT_ID, clientSecret = process.env.PAYPAL_CLIENT_SECRET, fetchImpl = globalThis.fetch, env = process.env.PAYPAL_ENV || "sandbox" } = {}) {
    if (env !== "sandbox") throw new PayPalError("This prototype only permits PayPal Sandbox.", 400);
    this.#clientId = String(clientId ?? "").trim();
    this.#clientSecret = String(clientSecret ?? "").trim();
    this.#fetch = fetchImpl;
    this.#baseUrl = "https://api-m.sandbox.paypal.com";
  }

  get configured() { return Boolean(this.#clientId && this.#clientSecret); }

  async #accessToken() {
    if (!this.configured) throw new PayPalError("PayPal Sandbox is not configured. Add sandbox credentials on the server.", 503);
    if (this.#token && Date.now() < this.#tokenExpiresAt - 30000) return this.#token;
    let response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${this.#clientId}:${this.#clientSecret}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json"
        },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(20000)
      });
    } catch {
      throw new PayPalError("Could not connect to PayPal Sandbox.", 502);
    }
    const payload = await readPayload(response);
    if (!response.ok || !payload?.access_token) throw new PayPalError("PayPal Sandbox authentication failed. Check the server credentials.", 502);
    this.#token = payload.access_token;
    this.#tokenExpiresAt = Date.now() + Math.max(0, Number(payload.expires_in ?? 300) * 1000);
    return this.#token;
  }

  async #request(path, { method = "GET", body, requestId } = {}) {
    const token = await this.#accessToken();
    const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (requestId) headers["PayPal-Request-Id"] = requestId;
    let response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000)
      });
    } catch {
      throw new PayPalError("PayPal Sandbox did not return a response. Check the stored operation before retrying.", 502);
    }
    const payload = await readPayload(response);
    if (!response.ok) {
      const message = response.status === 422
        ? "PayPal Sandbox rejected the order details."
        : `PayPal Sandbox request failed (HTTP ${response.status}).`;
      throw new PayPalError(message, 502, { paypalStatus: response.status, name: payload?.name ?? null });
    }
    return payload;
  }

  async createOrder({ engagementId, title, amountMinor, currency = "USD", requestId, returnUrl, cancelUrl }) {
    if (!engagementId || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new PayPalError("A positive, server-verified amount is required.", 400);
    if (currency !== "USD") throw new PayPalError("The prototype Sandbox checkout is limited to USD.", 400);
    if (!requestId || requestId.length > 38) throw new PayPalError("A valid idempotency key is required.", 400);
    if (Boolean(returnUrl) !== Boolean(cancelUrl)) throw new PayPalError("Both PayPal return and cancel URLs are required.", 400);
    const body = {
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: String(engagementId).slice(0, 64),
        custom_id: String(engagementId).slice(0, 127),
        description: String(title ?? "PACT Sandbox demo").slice(0, 127),
        amount: { currency_code: currency, value: formatMinorAmount(amountMinor) }
      }]
    };
    if (returnUrl && cancelUrl) {
      body.payment_source = { paypal: { experience_context: {
        return_url: returnUrl,
        cancel_url: cancelUrl,
        user_action: "PAY_NOW",
        shipping_preference: "NO_SHIPPING"
      } } };
    }
    const payload = await this.#request("/v2/checkout/orders", { method: "POST", requestId, body });
    if (!payload?.id) throw new PayPalError("PayPal did not return an order ID.", 502);
    return { id: payload.id, status: payload.status ?? "CREATED", links: payload.links ?? [] };
  }

  async captureOrder(orderId, requestId) {
    if (!/^[A-Z0-9-]{5,80}$/i.test(String(orderId ?? ""))) throw new PayPalError("Invalid PayPal order ID.", 400);
    if (!requestId || requestId.length > 38) throw new PayPalError("A valid idempotency key is required.", 400);
    return this.#request(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { method: "POST", requestId, body: {} });
  }

  async getOrder(orderId) {
    if (!/^[A-Z0-9-]{5,80}$/i.test(String(orderId ?? ""))) throw new PayPalError("Invalid PayPal order ID.", 400);
    return this.#request(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  }
}

export function getSandboxApprovalUrl(order) {
  const approval = (order?.links ?? []).find((link) => ["approve", "payer-action"].includes(link?.rel));
  if (!approval?.href) throw new PayPalError("PayPal did not return a Sandbox buyer-approval link.", 502);
  let url;
  try { url = new URL(approval.href); }
  catch { throw new PayPalError("PayPal returned an invalid Sandbox approval link.", 502); }
  if (url.protocol !== "https:" || !["www.sandbox.paypal.com", "sandbox.paypal.com"].includes(url.hostname)
    || url.pathname !== "/checkoutnow") {
    throw new PayPalError("PayPal returned an unexpected approval destination; the order was not opened.", 502);
  }
  return url.href;
}

async function readPayload(response) {
  try { return await response.json(); }
  catch { return null; }
}

export function verifyCaptureAgainstExpected(order, expected) {
  const capture = getPayPalCapture(order);
  const amount = capture?.amount;
  if (order?.status !== "COMPLETED" || capture?.status !== "COMPLETED" || !amount) {
    return { verified: false, status: order?.status === "APPROVED" ? "approved" : "unknown", captureId: capture?.id ?? null };
  }
  const expectedValue = formatMinorAmount(expected.amountMinor);
  if (amount.currency_code !== expected.currency || amount.value !== expectedValue) {
    return { verified: false, status: "unknown", captureId: capture?.id ?? null };
  }
  return { verified: true, status: "captured", captureId: capture.id, amountMinor: expected.amountMinor, currency: expected.currency };
}
