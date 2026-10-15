import { createLocalDemoApi, PUBLIC_DEMO_STORAGE_KEY } from "./local-demo.mjs";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const isPublicStaticBuild = document.querySelector('meta[name="pact-public-demo"]')?.content === "true";

let appState = null;
let selectedId = null;
let role = localStorage.getItem("pact-demo-role") === "client" ? "client" : "provider";
let toastTimer;
let paypalSession = null;
let paypalSdkPromise = null;
let currentAiCandidates = [];
let localDemoApi = null;

async function startPublicDemo() {
  if (localDemoApi) return localDemoApi;
  const response = await fetch("/demo-state.json", { cache: "no-store" });
  if (!response.ok) throw new Error("The public demo seed could not be loaded.");
  const initialState = await response.json();
  localDemoApi = createLocalDemoApi({ initialState, storage: window.localStorage, key: PUBLIC_DEMO_STORAGE_KEY });
  return localDemoApi;
}

async function api(path, options = {}) {
  if (localDemoApi) return localDemoApi(path, options);
  if (isPublicStaticBuild) return (await startPublicDemo())(path, options);
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) },
      cache: "no-store"
    });
  } catch (error) {
    if (path === "/api/state") return (await startPublicDemo())(path, options);
    throw error;
  }
  if (path === "/api/state" && response.status === 404) return (await startPublicDemo())(path, options);
  let payload = {};
  try { payload = await response.json(); } catch {}
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload;
}

function toast(message, isError = false) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.toggle("error", isError);
  node.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("visible"), 4200);
}

function formatMoney(minor, currency = "USD") {
  if (!Number.isSafeInteger(minor)) return "Not specified";
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(minor / 100); }
  catch { return `${currency} ${(minor / 100).toFixed(2)}`; }
}

function formatDate(dateValue) {
  if (!dateValue) return "Not specified";
  const date = new Date(`${dateValue}T12:00:00Z`);
  if (Number.isNaN(date.valueOf())) return String(dateValue);
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date);
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Time not available";
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(date);
}

function personName(engagement, party) { return party === "provider" ? engagement.providerName : engagement.clientName; }
function currentVersion(engagement) { return engagement.versions.find((version) => version.id === engagement.currentVersionId) || null; }
function pendingVersion(engagement) { return [...engagement.versions].reverse().find((version) => version.status === "proposed") || null; }
function versionNumber(engagement, version) { return version ? `Version ${version.number}` : "No accepted version"; }

function statusPill(engagement) {
  const pending = pendingVersion(engagement);
  if (pending) return '<span class="status-pill status-proposed">Change pending</span>';
  if (engagement.status === "accepted") return '<span class="status-pill status-accepted">Accepted</span>';
  if (engagement.status === "awaiting_client") return '<span class="status-pill status-proposed">Awaiting response</span>';
  if (engagement.status === "clarification_requested") return '<span class="status-pill status-proposed">Needs clarity</span>';
  return '<span class="status-pill status-neutral">Draft</span>';
}

function renderList() {
  const container = $("#engagementList");
  const engagements = appState?.engagements || [];
  $("#agreementCount").textContent = engagements.length;
  if (!engagements.length) {
    container.innerHTML = '<div class="empty-list">No agreements yet.<br>Start with one clear project.</div>';
    return;
  }
  container.innerHTML = engagements.map((engagement) => {
    const version = currentVersion(engagement) || engagement.versions.at(-1);
    const due = version?.terms?.dueDate ? `Due ${formatDate(version.terms.dueDate)}` : "Due date not set";
    return `<button class="list-item ${selectedId === engagement.id ? "selected" : ""}" type="button" data-select="${escapeHtml(engagement.id)}" aria-current="${selectedId === engagement.id ? "page" : "false"}">
      <span class="list-top"><span class="list-title">${escapeHtml(engagement.title)}</span>${statusPill(engagement)}</span>
      <span class="list-date">${escapeHtml(personName(engagement, role === "provider" ? "client" : "provider"))} · ${escapeHtml(due)}</span>
    </button>`;
  }).join("");
}

function termValue(label, value, icon, wide = false) {
  let display;
  if (Array.isArray(value) && value.length) display = `<ul>${value.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
  else display = value ? escapeHtml(value) : '<span class="term-empty">Not specified</span>';
  return `<div class="term-card ${wide ? "wide" : ""}"><div class="term-label"><span class="term-icon" aria-hidden="true">${icon}</span>${escapeHtml(label)}</div><div class="term-value">${display}</div></div>`;
}

function compareRows(current, proposed) {
  const rows = [];
  if (JSON.stringify(current?.deliverables) !== JSON.stringify(proposed?.deliverables)) rows.push(["Deliverables", `${current?.deliverables?.length || 0} items`, `${proposed?.deliverables?.length || 0} items`]);
  if (current?.dueDate !== proposed?.dueDate) rows.push(["Due date", formatDate(current?.dueDate), formatDate(proposed?.dueDate)]);
  if (current?.amountMinor !== proposed?.amountMinor) rows.push(["Total fee", formatMoney(current?.amountMinor, current?.currency), formatMoney(proposed?.amountMinor, proposed?.currency)]);
  if (current?.revisionLimit !== proposed?.revisionLimit) rows.push(["Revision limit", current?.revisionLimit || "Not specified", proposed?.revisionLimit || "Not specified"]);
  if (!rows.length) rows.push(["Terms", "Current accepted", "Updated terms"]);
  return rows.map(([label, before, after]) => `<div class="diff-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(before)} <span aria-hidden="true">→</span> ${escapeHtml(after)}</strong></div>`).join("");
}

function renderChangeCard(engagement, pending, current) {
  if (!pending) return "";
  const isRecipient = pending.proposedBy !== role;
  const proposer = personName(engagement, pending.proposedBy);
  return `<div class="change-card">
    <div class="change-head"><div><span class="status-pill status-proposed">Awaiting explicit response</span><h3>${escapeHtml(versionNumber(engagement, pending))} · ${escapeHtml(pending.changeSummary)}</h3><p>Proposed by ${escapeHtml(proposer)} on ${escapeHtml(formatTimestamp(pending.createdAt))}. The accepted version remains current.</p></div></div>
    <div class="change-content"><div class="change-diff"><h4>Change summary</h4>${compareRows(current?.terms, pending.terms)}</div><div class="change-diff"><h4>Proposed terms</h4><div class="diff-row"><span>Deliverables</span><strong>${pending.terms.deliverables?.length || 0} items</strong></div><div class="diff-row"><span>Due date</span><strong>${escapeHtml(formatDate(pending.terms.dueDate))}</strong></div><div class="diff-row"><span>Total fee</span><strong>${escapeHtml(formatMoney(pending.terms.amountMinor, pending.terms.currency))}</strong></div><div class="diff-row"><span>Deposit</span><strong>${escapeHtml(pending.terms.depositMinor == null ? "Not specified" : formatMoney(pending.terms.depositMinor, pending.terms.currency))}</strong></div></div></div>
    ${isRecipient ? `<div class="change-actions"><button class="button button-small button-accept" type="button" data-respond="accept" data-version="${escapeHtml(pending.id)}">Accept this version</button><button class="button button-small button-clarify" type="button" data-respond="clarification" data-version="${escapeHtml(pending.id)}">Ask for clarification</button><button class="button button-small button-reject" type="button" data-respond="reject" data-version="${escapeHtml(pending.id)}">Reject</button><span class="pending-note">Silence does not count as consent.</span></div>` : '<div class="change-actions"><span class="pending-note">Waiting for the other party. No change is active until they respond.</span></div>'}
  </div>`;
}

function renderPayment(engagement, version) {
  const payment = engagement.payment || { status: "not_started" };
  const terms = version?.terms || {};
  const dueMinor = terms.depositMinor ?? terms.amountMinor;
  const label = terms.depositMinor != null ? "Agreed initial deposit" : "Agreed project amount";
  let action = "";
  if (appState.config?.publicDemo) {
    action = '<div class="payment-disabled">PayPal is disabled in this public demo. No payment is processed.</div>';
  } else if (!appState.config?.paypal?.configured) {
    action = '<div class="payment-disabled">Sandbox checkout is disabled until server-side test credentials are configured.</div>';
  } else if (payment.status === "captured") {
    action = `<div class="payment-disabled"><strong>Sandbox capture confirmed</strong> · ${escapeHtml(formatMoney(payment.amountMinor, payment.currency))} to the configured test merchant. Not a provider payout.</div>`;
  } else if (role === "client" && version && dueMinor > 0) {
    action = `<div class="paypal-button-wrap"><button id="paypalCheckout" type="button" class="button button-dark">Pay with PayPal Sandbox <span aria-hidden="true">↗</span></button></div>`;
  } else if (payment.status === "created") {
    action = '<div class="payment-disabled">A Sandbox order exists. Switch to Client to test checkout.</div>';
  } else {
    action = '<div class="payment-disabled">Sandbox checkout is a client-side test only.</div>';
  }
  const status = payment.status === "not_started" ? "Not started" : payment.status.replaceAll("_", " ");
  const amount = payment.amountMinor ?? dueMinor;
  const paymentBadgeClass = payment.status === "captured" ? "status-accepted" : ["unknown", "approved", "capturing", "creating"].includes(payment.status) ? "status-proposed" : "status-neutral";
  const paymentBadge = `<span class="status-pill ${paymentBadgeClass}">${escapeHtml(status)}</span>`;
  return `<section class="detail-card payment-card"><div class="section-title-row"><div><h3>Payment reference</h3><p>Separate from agreement and delivery status.</p></div><span class="paypal-brand"><span class="paypal-mark" aria-hidden="true">P</span> Sandbox only</span></div>
    <div class="payment-status-row"><div><span class="term-label">${escapeHtml(label)}</span><div class="payment-amount">${dueMinor == null ? "Not specified" : escapeHtml(formatMoney(amount, payment.currency || terms.currency || "USD"))}<small> · one test payment</small></div></div>${paymentBadge}</div>
    <div class="payment-warning"><strong>Important:</strong> A standard Sandbox capture pays the Sandbox merchant account configured for this app. It does not pay this provider, create escrow, or prove work was delivered.</div>
    <div class="payment-controls">${action}<span class="small-disclaimer">Current payment state: ${escapeHtml(status)}<br>No live credentials or real money are used.</span></div>
  </section>`;
}

function renderEvidence(engagement) {
  const evidenceItems = engagement.evidence || [];
  const rows = evidenceItems.length ? evidenceItems.map((item) => `<article class="evidence-item"><div class="evidence-item-head"><span class="reported-tag">Reported by ${escapeHtml(personName(engagement, item.actor))}</span><time class="reported-tag">${escapeHtml(formatTimestamp(item.at))}</time></div><p>${escapeHtml(item.description)}</p>${item.url ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.url)}</a>` : ""}</article>`).join("") : '<div class="empty-evidence">No evidence notes yet. Notes are self-reported, not verified.</div>';
  return `<section class="detail-card"><div class="section-title-row"><div><h3>Evidence & delivery notes</h3><p>References are attributed to the person who added them.</p></div></div><div class="evidence-layout"><form id="evidenceForm" class="evidence-form"><label class="field">Add a note<textarea name="description" required maxlength="600" rows="3" placeholder="e.g. Shared first design draft for review"></textarea></label><label class="field">Optional link<input name="url" type="url" maxlength="500" placeholder="https://…"></label><button class="button button-outline button-small" type="submit">Add reported note <span aria-hidden="true">＋</span></button><span class="small-disclaimer">No file is uploaded. PACT does not verify delivery or quality.</span></form><div class="evidence-list">${rows}</div></div></section>`;
}

function renderActivity(engagement) {
  const events = [...(engagement.events || [])].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 6);
  const icon = (type) => type.includes("accept") ? "✓" : type.includes("change") ? "↗" : type.includes("payment") ? "$" : type.includes("evidence") ? "▤" : "·";
  return `<section class="detail-card"><div class="section-title-row"><div><h3>Activity</h3><p>Timestamped actions, not a legal conclusion.</p></div><span class="status-pill status-neutral">${events.length} recent</span></div><ol class="activity-list">${events.map((event) => `<li class="activity-item"><span class="activity-marker" aria-hidden="true">${icon(event.type)}</span><span class="activity-text">${escapeHtml(event.label)}<time class="activity-meta">${escapeHtml(formatTimestamp(event.at))}</time></span></li>`).join("")}</ol></section>`;
}

function renderDetails() {
  const engagement = appState?.engagements?.find((item) => item.id === selectedId);
  const container = $("#engagementDetails");
  if (!engagement) {
    container.innerHTML = '<div class="detail-card empty-detail"><span class="eyebrow">START SMALL</span><h2>Your next clear agreement.</h2><p>Record what is included, what is due, and how each person will respond. No one is treated as having agreed by silence.</p><button class="button button-dark" type="button" data-open-new>Create an agreement <span aria-hidden="true">↗</span></button></div>';
    return;
  }
  const current = currentVersion(engagement);
  const pending = pendingVersion(engagement);
  const displayVersion = current || pending || engagement.versions.at(-1);
  const party = role === "provider" ? engagement.clientName : engagement.providerName;
  const reviewLabel = current ? versionNumber(engagement, current) : "Draft · not yet mutually accepted";
  const terms = displayVersion?.terms || {};
  const noCurrentNote = current ? "" : '<div class="no-accepted"><strong>No mutually accepted version yet.</strong> The draft below is not the current agreement. It only becomes current after the client explicitly accepts it.</div>';
  container.innerHTML = `
    <section class="detail-card">
      <div class="detail-header"><div class="detail-heading"><span class="eyebrow">${statusPill(engagement)} <span class="version-dot">·</span> ${escapeHtml(role === "provider" ? "PROVIDER VIEW" : "CLIENT VIEW")}</span><h2>${escapeHtml(engagement.title)}</h2><p class="detail-sub">With ${escapeHtml(party)} · Created ${escapeHtml(formatDate(engagement.createdAt?.slice(0, 10)))}</p></div><div class="detail-actions"><button class="button button-outline button-small" type="button" data-open-change ${current ? "" : "disabled"}>Propose a change <span aria-hidden="true">＋</span></button></div></div>
      <div class="version-strip"><span>Current terms</span><strong>${escapeHtml(reviewLabel)}</strong><span class="version-dot">·</span><span>${current ? `Accepted by ${escapeHtml(engagement.providerName)} and ${escapeHtml(engagement.clientName)}` : "Waiting for explicit client response"}</span></div>
      ${noCurrentNote}
      ${renderChangeCard(engagement, pending, current)}
    </section>
    <section class="detail-card"><div class="section-title-row"><div><h3>${current ? "Current agreed terms" : "Draft terms"}</h3><p>${current ? "The last version both parties explicitly accepted." : "Not current until both parties explicitly accept."}</p></div><span class="status-pill ${current ? "status-accepted" : "status-proposed"}">${escapeHtml(reviewLabel)}</span></div>
      <div class="terms-grid">${termValue("Deliverables", terms.deliverables, "▤", true)}${termValue("Due date", formatDate(terms.dueDate), "◷")}${termValue("Revision limit", terms.revisionLimit, "↺")}${termValue("Total fee", terms.amountMinor == null ? null : formatMoney(terms.amountMinor, terms.currency), "$", true)}${termValue("Payment terms", terms.paymentTerms, "⇄")}${termValue("Completion / review", terms.completionCriteria, "✓", true)}</div>
    </section>
    ${renderPayment(engagement, current)}
    ${renderEvidence(engagement)}
    ${renderActivity(engagement)}`;
}

function renderStats() {
  const engagements = appState?.engagements || [];
  const pendingCount = engagements.filter((item) => pendingVersion(item)).length;
  const capturedMinor = engagements.reduce((sum, item) => sum + (item.payment?.status === "captured" ? (item.payment.amountMinor || 0) : 0), 0);
  $("#statAgreements").textContent = String(engagements.length);
  $("#statNeedsResponse").textContent = String(pendingCount);
  $("#statPayments").textContent = capturedMinor ? formatMoney(capturedMinor, "USD") : "$0";
}

async function refresh({ keepSelection = true } = {}) {
  appState = await api("/api/state");
  const publicDemo = Boolean(appState.config?.publicDemo);
  if (publicDemo) {
    $("#demoBannerText").innerHTML = "<strong>Public demo mode.</strong> Changes stay in this browser only. Use fictional names and terms; do not enter real client, contract, or payment details.";
    $("#storageLabel").textContent = "Browser-local demo";
    $("#storageNote").textContent = "Data stays in this browser; it is not shared across people or devices.";
    $("#footerSafety").textContent = "Synthetic-data demo · No accounts, cloud sync, AI, or live payments";
    $("#sourceText").disabled = true;
    $("#extractButton").disabled = true;
    $(".ai-local-note").textContent = "Unavailable in the public demo · local Ollama only";
  }
  $("#resetDemoButton").hidden = !publicDemo;
  if (!keepSelection || !appState.engagements.some((item) => item.id === selectedId)) selectedId = appState.engagements[0]?.id || null;
  $("#roleSelect").value = role;
  renderStats();
  renderList();
  renderDetails();
}

async function resetPublicDemo() {
  if (!appState?.config?.publicDemo) return;
  if (!window.confirm("Reset this browser's demo data to the fictional sample? This affects only this browser.")) return;
  window.localStorage.removeItem(PUBLIC_DEMO_STORAGE_KEY);
  window.localStorage.removeItem("pact-demo-role");
  role = "provider";
  selectedId = null;
  await refresh({ keepSelection: false });
  toast("This browser's demo data was reset to the fictional sample.");
}

function openNewAgreement() {
  if (role !== "provider") {
    toast("Switch to the Provider demo role to create an initial agreement.", true);
    return;
  }
  $("#newAgreementDialog").showModal();
}

function toMinor(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount < 0 || amount > 10_000_000) throw new Error("Enter a valid non-negative USD amount.");
  return Math.round(amount * 100);
}

function buildTermsFromForm(prefix = "") {
  const get = (id) => $(`#${prefix}${id}`);
  return {
    deliverables: get("deliverables").value.split(/\n|;/).map((item) => item.trim()).filter(Boolean),
    dueDate: get("dueDate").value || null,
    revisionLimit: get("revisionLimit").value.trim() || null,
    amountMinor: toMinor(get("totalAmount").value),
    depositMinor: toMinor(get("depositAmount").value),
    currency: "USD",
    paymentTerms: get("paymentTerms").value.trim() || null,
    completionCriteria: get("completionCriteria").value.trim() || null
  };
}

async function submitNewAgreement(event) {
  event.preventDefault();
  try {
    const body = {
      role: "provider", title: $("#newTitle").value, providerName: $("#providerName").value,
      clientName: $("#clientName").value, terms: buildTermsFromForm()
    };
    const result = await api("/api/engagements", { method: "POST", body: JSON.stringify(body) });
    $("#newAgreementDialog").close();
    event.currentTarget.reset();
    await refresh({ keepSelection: false });
    selectedId = result.engagement.id;
    await refresh();
    toast("Draft sent in the prototype. Switch to Client to review and explicitly accept.");
  } catch (error) { toast(error.message, true); }
}

function openChangeDialog() {
  const engagement = appState?.engagements?.find((item) => item.id === selectedId);
  const version = engagement && currentVersion(engagement);
  if (!version) return toast("A mutually accepted version is needed before changing terms.", true);
  const terms = version.terms;
  $("#changeDeliverables").value = (terms.deliverables || []).join("\n");
  $("#changeDueDate").value = terms.dueDate || "";
  $("#changeRevisionLimit").value = terms.revisionLimit || "";
  $("#changeTotalAmount").value = terms.amountMinor == null ? "" : (terms.amountMinor / 100).toFixed(2);
  $("#changeDepositAmount").value = terms.depositMinor == null ? "" : (terms.depositMinor / 100).toFixed(2);
  $("#changeSummary").value = "";
  $("#changeDialog").showModal();
}

async function submitChange(event) {
  event.preventDefault();
  const engagement = appState?.engagements?.find((item) => item.id === selectedId);
  const version = engagement && currentVersion(engagement);
  if (!version) return toast("Refresh and choose an accepted agreement first.", true);
  try {
    const body = {
      role, baseVersionId: version.id, changeSummary: $("#changeSummary").value,
      terms: {
        deliverables: $("#changeDeliverables").value.split(/\n|;/).map((item) => item.trim()).filter(Boolean),
        dueDate: $("#changeDueDate").value || null,
        revisionLimit: $("#changeRevisionLimit").value.trim() || null,
        amountMinor: toMinor($("#changeTotalAmount").value),
        depositMinor: toMinor($("#changeDepositAmount").value), currency: "USD"
      }
    };
    await api(`/api/engagements/${encodeURIComponent(selectedId)}/changes`, { method: "POST", body: JSON.stringify(body) });
    $("#changeDialog").close();
    await refresh();
    toast("Change proposed. The last accepted version remains current until explicit acceptance.");
  } catch (error) { toast(error.message, true); }
}

async function respondToChange(button) {
  const action = button.dataset.respond;
  const versionId = button.dataset.version;
  let comment = "";
  if (action === "clarification") {
    comment = window.prompt("What needs clarification? The note will be visible in the prototype activity timeline.") || "";
    if (!comment.trim()) return;
  } else if (action === "reject") {
    if (!window.confirm("Reject this proposal? The current accepted version will remain unchanged.")) return;
  } else if (action === "accept") {
    if (!window.confirm("Accept this exact version? This updates the current agreement terms.")) return;
  }
  try {
    await api(`/api/engagements/${encodeURIComponent(selectedId)}/respond`, {
      method: "POST", body: JSON.stringify({ role, versionId, action, comment })
    });
    await refresh();
    toast(action === "accept" ? "Version explicitly accepted. The agreed version is now current." : action === "reject" ? "Proposal rejected. The accepted version was not changed." : "Clarification request recorded.");
  } catch (error) { toast(error.message, true); }
}

async function submitEvidence(event) {
  event.preventDefault();
  if (!selectedId) return;
  const form = event.currentTarget;
  const formData = new FormData(form);
  try {
    await api(`/api/engagements/${encodeURIComponent(selectedId)}/evidence`, {
      method: "POST", body: JSON.stringify({ role, description: formData.get("description"), url: formData.get("url") || null })
    });
    form.reset();
    await refresh();
    toast("Note added as self-reported. PACT has not verified the work.");
  } catch (error) { toast(error.message, true); }
}

function aiFieldName(field) {
  return ({ deliverables: "Deliverables", revisionLimit: "Revision limit", dueDate: "Due date", amount: "Amount", deposit: "Deposit", paymentTerms: "Payment terms", completionCriteria: "Completion criteria", other: "Other" })[field] || "Other";
}

function renderAiResults(result) {
  currentAiCandidates = result.candidates || [];
  const container = $("#aiResults");
  if (!currentAiCandidates.length) {
    container.innerHTML = '<div class="ai-empty">No candidate terms found. You can still enter terms manually.</div>';
    return;
  }
  const cards = currentAiCandidates.map((item, index) => `<div class="ai-result-card"><div class="ai-result-top"><span class="ai-field-label">${escapeHtml(aiFieldName(item.field))}</span><span class="quote-badge ${item.quoteVerified ? "" : "bad"}">${item.quoteVerified ? "QUOTE MATCHED" : "CHECK SOURCE"}</span></div><div class="ai-result-value">${escapeHtml(item.value)}</div><blockquote>${item.exactQuote ? `“${escapeHtml(item.exactQuote)}”` : "No source quote returned"}</blockquote>${item.ambiguity ? `<div class="small-disclaimer">Uncertainty: ${escapeHtml(item.ambiguity)}</div>` : ""}<label><input type="checkbox" data-ai-index="${index}" ${item.quoteVerified ? "" : "disabled"}> Stage this quoted suggestion for review</label></div>`).join("");
  const questions = (result.clarifyingQuestions || []).length ? `<ul class="ai-questions">${result.clarifyingQuestions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "";
  container.innerHTML = `${cards}${questions}<div class="ai-toolbar"><button id="applyAiButton" class="button button-outline button-small" type="button">Stage checked suggestions</button><span class="small-disclaimer">You still review and edit every field before creating.</span></div>`;
  $("#applyAiButton")?.addEventListener("click", applyAiSuggestions);
}

function dateFromValue(value) {
  const candidate = String(value ?? "").trim();
  let iso = candidate.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return iso[0];
  const months = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
  const human = candidate.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})\b/i);
  if (human) return `${human[3]}-${String(months[human[1].toLowerCase()]).padStart(2, "0")}-${human[2].padStart(2, "0")}`;
  return "";
}

function moneyFromValue(value) {
  const match = String(value ?? "").replace(/,/g, "").match(/(?:USD|\$)?\s*(\d+(?:\.\d{1,2})?)/i);
  return match ? String(Number(match[1]).toFixed(2)) : "";
}

function applyAiSuggestions() {
  const checked = $$("[data-ai-index]:checked").map((input) => currentAiCandidates[Number(input.dataset.aiIndex)]).filter((item) => item?.quoteVerified);
  for (const candidate of checked) {
    if (candidate.field === "deliverables") $("#deliverables").value = candidate.value.split(/\n|;|, (?=[A-Z])/).map((item) => item.trim()).filter(Boolean).join("\n");
    else if (candidate.field === "revisionLimit") $("#revisionLimit").value = candidate.value;
    else if (candidate.field === "dueDate") $("#dueDate").value = dateFromValue(candidate.value);
    else if (candidate.field === "amount") $("#totalAmount").value = moneyFromValue(candidate.value);
    else if (candidate.field === "deposit") $("#depositAmount").value = moneyFromValue(candidate.value);
    else if (candidate.field === "paymentTerms") $("#paymentTerms").value = candidate.value;
    else if (candidate.field === "completionCriteria") $("#completionCriteria").value = candidate.value;
  }
  toast(`${checked.length} quoted suggestion${checked.length === 1 ? "" : "s"} staged. Review and edit the draft fields.`);
}

async function extractWithAI() {
  const sourceText = $("#sourceText").value.trim();
  const button = $("#extractButton");
  if (!sourceText) return toast("Paste a short source note first.", true);
  button.disabled = true;
  button.textContent = "Working locally…";
  $("#aiResults").innerHTML = '<div class="ai-empty">Checking selected source text with the local model…</div>';
  try {
    const result = await api("/api/ai/extract", { method: "POST", body: JSON.stringify({ sourceText }) });
    renderAiResults(result);
    toast("Local AI suggestions are ready. Review source quotes before applying.");
  } catch (error) {
    $("#aiResults").innerHTML = `<div class="ai-empty">${escapeHtml(error.message)}</div>`;
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.innerHTML = 'Extract suggestions <span aria-hidden="true">↗</span>';
  }
}

async function loadPayPalSdk(clientId) {
  if (window.paypal?.createInstance) return;
  if (!paypalSdkPromise) {
    paypalSdkPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.type = "module";
      script.src = "https://www.sandbox.paypal.com/web-sdk/v6/core";
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("PayPal Sandbox SDK could not load."));
      document.head.appendChild(script);
    });
  }
  await paypalSdkPromise;
  if (!window.paypal?.createInstance) throw new Error("PayPal SDK v6 did not initialize. Check the current Sandbox SDK availability.");
  if (!clientId) throw new Error("Sandbox client ID is missing.");
}

async function beginPayPalCheckout() {
  if (role !== "client") return toast("Switch to the Client demo role to test buyer checkout.", true);
  const engagement = appState?.engagements?.find((item) => item.id === selectedId);
  if (!engagement || !appState.config?.paypal?.configured) return toast("PayPal Sandbox is not configured.", true);
  const button = $("#paypalCheckout");
  if (!button) return;
  button.disabled = true;
  button.textContent = "Opening Sandbox…";
  try {
    await loadPayPalSdk(appState.config.paypal.clientId);
    const sdkInstance = await window.paypal.createInstance({
      clientId: appState.config.paypal.clientId,
      components: ["paypal-payments"],
      pageType: "checkout"
    });
    paypalSession = await sdkInstance.createPayPalOneTimePaymentSession({
      onApprove: async (data) => {
        try {
          await api(`/api/paypal/orders/${encodeURIComponent(data.orderId)}/capture`, {
            method: "POST", body: JSON.stringify({ role, engagementId: selectedId })
          });
          await refresh();
          toast("Sandbox capture confirmed by the server. It went to the test merchant, not the service provider.");
        } catch (error) { toast(error.message, true); await refresh(); }
      },
      onCancel: () => toast("Sandbox checkout cancelled. No agreement terms changed."),
      onError: (error) => toast(error?.message || "PayPal Sandbox checkout reported an error.", true)
    });
    const orderPromise = api("/api/paypal/orders", { method: "POST", body: JSON.stringify({ role, engagementId: selectedId }) })
      .then((result) => ({ orderId: result.orderId }));
    await paypalSession.start({}, orderPromise);
  } catch (error) {
    toast(error.message || "Sandbox checkout could not start.", true);
    await refresh();
  } finally {
    const currentButton = $("#paypalCheckout");
    if (currentButton) { currentButton.disabled = false; currentButton.innerHTML = 'Pay with PayPal Sandbox <span aria-hidden="true">↗</span>'; }
  }
}

function bindEvents() {
  $("#resetDemoButton").addEventListener("click", resetPublicDemo);
  $("#newAgreementButton").addEventListener("click", openNewAgreement);
  $("#heroNewButton").addEventListener("click", openNewAgreement);
  $("#smallNewButton").addEventListener("click", openNewAgreement);
  $("#newAgreementForm").addEventListener("submit", submitNewAgreement);
  $("#changeForm").addEventListener("submit", submitChange);
  $("#extractButton").addEventListener("click", extractWithAI);
  $("#roleSelect").addEventListener("change", async (event) => {
    role = event.target.value;
    localStorage.setItem("pact-demo-role", role);
    await refresh();
    toast(`Viewing the demo as ${role}. This switcher is not access control.`);
  });
  document.addEventListener("click", async (event) => {
    const selectButton = event.target.closest("[data-select]");
    if (selectButton) { selectedId = selectButton.dataset.select; renderList(); renderDetails(); return; }
    if (event.target.closest("[data-open-new]")) return openNewAgreement();
    if (event.target.closest("[data-open-change]")) return openChangeDialog();
    const responseButton = event.target.closest("[data-respond]");
    if (responseButton) return respondToChange(responseButton);
    if (event.target.closest("#paypalCheckout")) return beginPayPalCheckout();
    const close = event.target.closest(".close-dialog, .cancel-dialog");
    if (close) close.closest("dialog")?.close();
  });
  document.addEventListener("submit", (event) => {
    if (event.target?.id === "evidenceForm") { event.preventDefault(); submitEvidence(event); }
  });
}

async function main() {
  bindEvents();
  try { await refresh({ keepSelection: false }); }
  catch (error) { $("#engagementDetails").innerHTML = `<div class="detail-card empty-detail"><h2>Workspace could not load</h2><p>${escapeHtml(error.message)}</p></div>`; }
}

main();
