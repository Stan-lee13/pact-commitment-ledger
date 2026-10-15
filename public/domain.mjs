const randomUUID = () => globalThis.crypto.randomUUID();

export class DomainError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "DomainError";
    this.status = status;
  }
}

const validRoles = new Set(["provider", "client"]);
const validResponses = new Set(["accept", "reject", "clarification"]);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object ?? {}, key);

function assertRole(role) {
  if (!validRoles.has(role)) throw new DomainError("Choose provider or client demo role.");
}

function requiredText(value, label, max = 160) {
  const text = String(value ?? "").trim();
  if (!text) throw new DomainError(`${label} is required.`);
  if (text.length > max) throw new DomainError(`${label} must be ${max} characters or fewer.`);
  return text;
}

function optionalText(value, label, max = 600) {
  const text = String(value ?? "").trim();
  if (text.length > max) throw new DomainError(`${label} must be ${max} characters or fewer.`);
  return text || null;
}

function normalizeList(value, label = "Deliverables") {
  const items = Array.isArray(value)
    ? value
    : String(value ?? "").split(/\n|;/);
  const cleaned = items.map((item) => String(item ?? "").trim()).filter(Boolean);
  if (cleaned.length > 20) throw new DomainError(`${label} must contain 20 items or fewer.`);
  for (const item of cleaned) {
    if (item.length > 300) throw new DomainError(`Each ${label.toLowerCase()} item must be 300 characters or fewer.`);
  }
  return cleaned;
}

function validDateOrNull(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new DomainError("Due date must use YYYY-MM-DD.");
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new DomainError("Due date is not a valid calendar date.");
  }
  return text;
}

export function normalizeTerms(input = {}, base = {}) {
  const deliverables = has(input, "deliverables") ? normalizeList(input.deliverables) : [...(base.deliverables ?? [])];
  const revisionLimit = has(input, "revisionLimit") ? optionalText(input.revisionLimit, "Revision limit", 160) : (base.revisionLimit ?? null);
  const dueDate = has(input, "dueDate") ? validDateOrNull(input.dueDate) : (base.dueDate ?? null);
  const amountMinor = has(input, "amountMinor") ? input.amountMinor : (base.amountMinor ?? null);
  const depositMinor = has(input, "depositMinor") ? input.depositMinor : (base.depositMinor ?? null);
  const currency = has(input, "currency") ? String(input.currency ?? "").toUpperCase() : (base.currency ?? "USD");

  for (const [name, amount] of [["Total amount", amountMinor], ["Deposit", depositMinor]]) {
    if (amount !== null && amount !== undefined && (!Number.isSafeInteger(amount) || amount < 0 || amount > 1_000_000_000)) {
      throw new DomainError(`${name} must be an integer amount in minor currency units.`);
    }
  }
  if (depositMinor != null && amountMinor == null) throw new DomainError("A deposit needs a total amount.");
  if (depositMinor != null && amountMinor != null && depositMinor > amountMinor) throw new DomainError("Deposit cannot exceed the total amount.");
  if (currency !== "USD") throw new DomainError("This prototype's PayPal Sandbox payment flow is limited to USD.");

  return {
    deliverables,
    revisionLimit,
    dueDate,
    amountMinor: amountMinor ?? null,
    depositMinor: depositMinor ?? null,
    currency,
    paymentTerms: has(input, "paymentTerms") ? optionalText(input.paymentTerms, "Payment terms", 600) : (base.paymentTerms ?? null),
    completionCriteria: has(input, "completionCriteria") ? optionalText(input.completionCriteria, "Completion criteria", 600) : (base.completionCriteria ?? null)
  };
}

export function getEngagement(state, engagementId) {
  const engagement = state.engagements.find((item) => item.id === engagementId);
  if (!engagement) throw new DomainError("Agreement not found.", 404);
  return engagement;
}

function addEvent(engagement, type, actor, at, label, extra = {}) {
  engagement.events.push({ id: randomUUID(), type, actor, at, label, ...extra });
}

export function createEngagement(state, input, actorRole, at = new Date().toISOString()) {
  assertRole(actorRole);
  if (actorRole !== "provider") throw new DomainError("Only the provider can start an agreement in this prototype.", 403);
  const title = requiredText(input.title, "Project name", 120);
  const providerName = requiredText(input.providerName, "Your name", 80);
  const clientName = requiredText(input.clientName, "Client name", 80);
  const terms = normalizeTerms(input.terms ?? {});
  if (terms.deliverables.length === 0) throw new DomainError("Add at least one deliverable before sending terms.");
  const versionId = randomUUID();
  const engagement = {
    id: randomUUID(), title, providerName, clientName, createdAt: at,
    currentVersionId: null, status: "awaiting_client", evidence: [],
    versions: [{
      id: versionId, number: 1, baseVersionId: null, status: "proposed", proposedBy: actorRole,
      acceptedBy: [actorRole], createdAt: at, acceptedAt: null,
      changeSummary: "Initial terms", terms
    }],
    payment: { status: "not_started", provider: "paypal_sandbox", orderId: null, captureId: null,
      amountMinor: null, currency: terms.currency, requestIds: { create: null, capture: null }, updatedAt: null },
    events: []
  };
  addEvent(engagement, "engagement_created", actorRole, at, `${providerName} drafted version 1 and confirmed it for client review.`, { versionId });
  state.engagements.unshift(engagement);
  return engagement;
}

export function proposeChange(state, engagementId, input, actorRole, at = new Date().toISOString()) {
  assertRole(actorRole);
  const engagement = getEngagement(state, engagementId);
  const current = engagement.versions.find((version) => version.id === engagement.currentVersionId);
  if (!current || current.status !== "accepted") throw new DomainError("A mutually accepted version is required before proposing a change.", 409);
  if (input.baseVersionId !== current.id) throw new DomainError("This change is based on an outdated version. Refresh and try again.", 409);
  if (engagement.versions.some((version) => version.status === "proposed")) {
    throw new DomainError("Resolve the open proposal before sending another change.", 409);
  }
  const terms = normalizeTerms(input.terms ?? {}, current.terms);
  if (JSON.stringify(terms) === JSON.stringify(current.terms)) throw new DomainError("Change at least one term before sending a proposal.");
  const version = {
    id: randomUUID(), number: Math.max(...engagement.versions.map((item) => item.number)) + 1,
    baseVersionId: current.id, status: "proposed", proposedBy: actorRole,
    acceptedBy: [actorRole], createdAt: at, acceptedAt: null,
    changeSummary: requiredText(input.changeSummary, "Change summary", 240), terms
  };
  engagement.versions.push(version);
  engagement.status = "change_pending";
  addEvent(engagement, "change_proposed", actorRole, at, `${actorRole === "provider" ? engagement.providerName : engagement.clientName} proposed version ${version.number}. The current accepted version remains in force until both parties accept.`, { versionId: version.id });
  return version;
}

export function respondToVersion(state, engagementId, versionId, actorRole, action, comment = "", at = new Date().toISOString()) {
  assertRole(actorRole);
  if (!validResponses.has(action)) throw new DomainError("Response must be accept, reject, or clarification.");
  const engagement = getEngagement(state, engagementId);
  const version = engagement.versions.find((item) => item.id === versionId);
  if (!version) throw new DomainError("Version not found.", 404);
  if (version.status !== "proposed") throw new DomainError("This proposal is no longer open for response.", 409);
  if (version.proposedBy === actorRole) throw new DomainError("The other party must respond to this proposal.", 403);
  const note = optionalText(comment, "Comment", 1000);

  if (action === "accept") {
    if (!version.acceptedBy.includes(actorRole)) version.acceptedBy.push(actorRole);
    if (!version.acceptedBy.includes(version.proposedBy)) throw new DomainError("Both parties must explicitly accept.", 409);
    version.status = "accepted";
    version.acceptedAt = at;
    engagement.currentVersionId = version.id;
    engagement.status = "accepted";
    addEvent(engagement, "version_accepted", actorRole, at, `${actorRole === "provider" ? engagement.providerName : engagement.clientName} explicitly accepted version ${version.number}.`, { versionId: version.id, comment: note });
    return { engagement, version };
  }

  version.status = action === "reject" ? "rejected" : "clarification_requested";
  if (action === "reject") engagement.status = engagement.currentVersionId ? "accepted" : "needs_revision";
  else engagement.status = "clarification_requested";
  const label = action === "reject" ? "rejected" : "requested clarification on";
  addEvent(engagement, action === "reject" ? "version_rejected" : "clarification_requested", actorRole, at, `${actorRole === "provider" ? engagement.providerName : engagement.clientName} ${label} version ${version.number}.${note ? ` Note: ${note}` : ""}`, { versionId: version.id, comment: note });
  return { engagement, version };
}

export function addEvidence(state, engagementId, input, actorRole, at = new Date().toISOString()) {
  assertRole(actorRole);
  const engagement = getEngagement(state, engagementId);
  const description = requiredText(input.description, "Evidence note", 600);
  let url = null;
  if (input.url) {
    try {
      const parsed = new URL(String(input.url));
      if (!new Set(["https:", "http:"]).has(parsed.protocol)) throw new Error("scheme");
      url = parsed.href;
    } catch {
      throw new DomainError("Evidence links must be valid HTTP or HTTPS URLs.");
    }
  }
  const evidence = { id: randomUUID(), description, url, actor: actorRole, at, status: "reported" };
  engagement.evidence.unshift(evidence);
  addEvent(engagement, "evidence_reported", actorRole, at, `${actorRole === "provider" ? engagement.providerName : engagement.clientName} added a note reported by them. PACT has not verified fulfilment.`, { evidenceId: evidence.id });
  return evidence;
}

export function getCurrentVersion(engagement) {
  return engagement.versions.find((version) => version.id === engagement.currentVersionId) ?? null;
}
