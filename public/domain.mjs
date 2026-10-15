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

export function deleteEngagement(state, engagementId, actorRole) {
  assertRole(actorRole);
  if (actorRole !== "provider") throw new DomainError("Only the provider can delete an agreement in this prototype.", 403);
  const engagement = getEngagement(state, engagementId);
  if (engagement.payment?.orderId || engagement.payment?.captureId || engagement.payment?.status === "captured") {
    throw new DomainError("This agreement has a PayPal Sandbox order or capture. Keep its payment reference; delete is disabled.", 409);
  }
  state.engagements = state.engagements.filter((item) => item.id !== engagementId);
  return { deleted: true, engagementId };
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
  const attachment = input.attachment == null ? null : normalizeAttachment(input.attachment, engagement);
  const evidence = { id: randomUUID(), description, url, attachment, actor: actorRole, at, status: "reported" };
  engagement.evidence.unshift(evidence);
  addEvent(engagement, "evidence_reported", actorRole, at, `${actorRole === "provider" ? engagement.providerName : engagement.clientName} added a note reported by them${attachment ? " with an attachment" : ""}. PACT has not verified fulfilment.`, { evidenceId: evidence.id });
  return evidence;
}

export function getCurrentVersion(engagement) {
  return engagement.versions.find((version) => version.id === engagement.currentVersionId) ?? null;
}

const attachmentTypes = new Set(["application/pdf", "image/png", "image/jpeg", "text/plain", "text/csv", "text/markdown"]);
const maxAttachmentBytes = 256 * 1024;
const maxAgreementAttachmentBytes = 1024 * 1024;

function normalizeAttachment(input, engagement) {
  if (!input || typeof input !== "object") throw new DomainError("Choose a supported evidence attachment.");
  const name = String(input.name ?? "").replace(/[\\/\0-\x1f\x7f]/g, "_").trim().slice(0, 160);
  const type = String(input.type ?? "").toLowerCase();
  const dataUrl = String(input.dataUrl ?? "");
  if (!name) throw new DomainError("Attachment filename is required.");
  if (!attachmentTypes.has(type)) throw new DomainError("Attachments must be PDF, PNG, JPEG, plain text, CSV, or Markdown files.");
  if (!Number.isSafeInteger(input.size) || input.size < 1 || input.size > maxAttachmentBytes) {
    throw new DomainError("Each attachment must be between 1 byte and 256 KiB.");
  }
  const match = dataUrl.match(/^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/i);
  if (!match || match[1].toLowerCase() !== type || dataUrl.length > 400_000) throw new DomainError("Attachment data is invalid or does not match its file type.");
  let actualBytes;
  try {
    const binary = atob(match[2]);
    if (btoa(binary) !== match[2]) throw new Error("Invalid base64 encoding");
    actualBytes = binary.length;
  } catch {
    throw new DomainError("Attachment data is not valid base64.");
  }
  if (actualBytes !== input.size) throw new DomainError("Attachment size does not match its content.");
  const currentTotal = engagement.evidence.reduce((sum, item) => sum + (Number.isSafeInteger(item.attachment?.size) ? item.attachment.size : 0), 0);
  if (currentTotal + actualBytes > maxAgreementAttachmentBytes) throw new DomainError("Attachments for one agreement are limited to 1 MiB total.");
  return { name, type, size: actualBytes, dataUrl };
}

const progressStatuses = new Set(["not_started", "in_progress", "completed"]);

export function getDeliverableProgress(engagement, versionId, deliverableIndex) {
  const event = [...(engagement.events ?? [])].reverse().find((item) =>
    item.type === "deliverable_progress_updated" && item.versionId === versionId && item.deliverableIndex === deliverableIndex
  );
  return event?.status ?? "not_started";
}

export function updateDeliverableProgress(state, engagementId, input, actorRole, at = new Date().toISOString()) {
  assertRole(actorRole);
  const engagement = getEngagement(state, engagementId);
  const current = getCurrentVersion(engagement);
  if (!current || current.status !== "accepted") throw new DomainError("A mutually accepted version is required to update delivery progress.", 409);
  if (input.versionId !== current.id) throw new DomainError("This progress update is based on an outdated version. Refresh and try again.", 409);
  if (!Number.isSafeInteger(input.deliverableIndex) || input.deliverableIndex < 0 || input.deliverableIndex >= current.terms.deliverables.length) {
    throw new DomainError("Choose a deliverable in the current accepted version.");
  }
  if (!progressStatuses.has(input.status)) throw new DomainError("Progress must be not started, in progress, or completed.");
  const label = `${actorRole === "provider" ? engagement.providerName : engagement.clientName} marked deliverable ${input.deliverableIndex + 1} as ${input.status.replaceAll("_", " ")}.`;
  addEvent(engagement, "deliverable_progress_updated", actorRole, at, label, {
    versionId: current.id, deliverableIndex: input.deliverableIndex, status: input.status
  });
  return engagement.events.at(-1);
}

const deliveryReviewActions = new Set(["accept", "changes_requested", "clarification"]);

export function getDeliveryReview(engagement, versionId = getCurrentVersion(engagement)?.id) {
  if (!versionId) return null;
  return [...(engagement.events ?? [])].reverse().find((event) =>
    event.type === "delivery_review_recorded" && event.versionId === versionId
  ) ?? null;
}

export function recordDeliveryReview(state, engagementId, input, actorRole, at = new Date().toISOString()) {
  assertRole(actorRole);
  if (actorRole !== "client") throw new DomainError("Only the client can record a delivery review.", 403);
  const engagement = getEngagement(state, engagementId);
  const current = getCurrentVersion(engagement);
  if (!current || current.status !== "accepted") throw new DomainError("A mutually accepted version is required before reviewing delivery.", 409);
  if (input.versionId !== current.id) throw new DomainError("This delivery review is based on an outdated version. Refresh and try again.", 409);
  if (!deliveryReviewActions.has(input.action)) throw new DomainError("Choose accept, request changes, or ask for clarification.");
  const comment = String(input.comment ?? "").trim();
  if (comment.length > 1200) throw new DomainError("Review notes must be 1,200 characters or less.");
  if (input.action !== "accept" && !comment) throw new DomainError("Add a short note for a change request or clarification.");
  const label = input.action === "accept"
    ? `${engagement.clientName} marked delivery accepted for version ${current.number}. This is a client-reported review, not verified fulfilment.`
    : input.action === "changes_requested"
      ? `${engagement.clientName} requested changes to delivery within version ${current.number}: ${comment}`
      : `${engagement.clientName} asked for delivery clarification on version ${current.number}: ${comment}`;
  addEvent(engagement, "delivery_review_recorded", actorRole, at, label, {
    versionId: current.id, reviewAction: input.action, comment
  });
  return engagement.events.at(-1);
}

function daysUntil(dateValue, now) {
  if (!dateValue) return null;
  const today = new Date(now);
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const due = Date.parse(`${dateValue}T00:00:00.000Z`);
  return Number.isFinite(due) ? Math.round((due - start) / 86_400_000) : null;
}

export function deriveOutstandingObligations(engagements = [], role = "provider", now = new Date()) {
  const obligations = [];
  for (const engagement of engagements) {
    const pending = [...(engagement.versions ?? [])].reverse().find((version) => version.status === "proposed");
    if (pending) {
      const needsYou = pending.proposedBy !== role;
      obligations.push({
        id: `response:${engagement.id}:${pending.id}`, engagementId: engagement.id, type: "response",
        versionId: pending.id, title: engagement.title,
        summary: needsYou ? "Your explicit response is needed" : `Waiting for ${pending.proposedBy === "provider" ? engagement.clientName : engagement.providerName}`,
        detail: `Version ${pending.number}: ${pending.changeSummary}`, needsYou, priority: needsYou ? 0 : 1
      });
    }
    const current = getCurrentVersion(engagement);
    if (!current || current.status !== "accepted") continue;
    const remaining = current.terms.deliverables.filter((_, index) => getDeliverableProgress(engagement, current.id, index) !== "completed").length;
    const dueInDays = daysUntil(current.terms.dueDate, now);
    let dueLabel = "";
    if (remaining && dueInDays != null) {
      if (dueInDays < 0) dueLabel = `${Math.abs(dueInDays)} day${Math.abs(dueInDays) === 1 ? "" : "s"} overdue`;
      else if (dueInDays === 0) dueLabel = "Due today";
      else dueLabel = `Due in ${dueInDays} day${dueInDays === 1 ? "" : "s"}`;
    }
    current.terms.deliverables.forEach((deliverable, index) => {
      const status = getDeliverableProgress(engagement, current.id, index);
      if (status === "completed") return;
      obligations.push({
        id: `deliverable:${engagement.id}:${current.id}:${index}`, engagementId: engagement.id, type: "deliverable",
        versionId: current.id, deliverableIndex: index, title: engagement.title, summary: deliverable,
        detail: `${status === "in_progress" ? "In progress" : "Not started"}${dueLabel ? ` · ${dueLabel}` : ""}`,
        status, dueDate: current.terms.dueDate ?? null, dueInDays, priority: dueInDays != null && dueInDays < 0 ? 2 : 3
      });
    });
  }
  return obligations.sort((a, b) => a.priority - b.priority || String(a.title).localeCompare(String(b.title)) || String(a.summary).localeCompare(String(b.summary)));
}

export function deriveReminders(engagements = [], role = "provider", now = new Date()) {
  const reminders = [];
  for (const engagement of engagements) {
    const pending = [...(engagement.versions ?? [])].reverse().find((version) => version.status === "proposed");
    if (pending && pending.proposedBy !== role) reminders.push({
      key: `response:${engagement.id}:${pending.id}`, type: "response", engagementId: engagement.id,
      title: engagement.title, message: `Your explicit response is needed on version ${pending.number}.`, priority: 0
    });
    const current = getCurrentVersion(engagement);
    if (!current || current.status !== "accepted") continue;
    const remaining = current.terms.deliverables.filter((_, index) => getDeliverableProgress(engagement, current.id, index) !== "completed").length;
    const dueInDays = daysUntil(current.terms.dueDate, now);
    if (!remaining || dueInDays == null || dueInDays > 7) continue;
    const type = dueInDays < 0 ? "overdue" : dueInDays === 0 ? "due_today" : "due_soon";
    const timing = type === "overdue" ? `${Math.abs(dueInDays)} day${Math.abs(dueInDays) === 1 ? "" : "s"} overdue` : type === "due_today" ? "due today" : `due in ${dueInDays} day${dueInDays === 1 ? "" : "s"}`;
    reminders.push({
      key: `deadline:${engagement.id}:${current.id}:${current.terms.dueDate}:${type}`, type,
      engagementId: engagement.id, title: engagement.title,
      message: `${remaining} deliverable${remaining === 1 ? "" : "s"} remain; ${timing}.`, priority: type === "overdue" ? 1 : 2
    });
  }
  return reminders.sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title));
}
