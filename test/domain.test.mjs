import test from "node:test";
import assert from "node:assert/strict";
import { createSeedState } from "../src/demo-data.mjs";
import { addEvidence, createEngagement, deleteEngagement, deriveOutstandingObligations, deriveReminders, getDeliverableProgress, getDeliveryReview, proposeChange, recordDeliveryReview, respondToVersion, updateDeliverableProgress } from "../src/domain.mjs";

const now = "2026-10-15T12:00:00.000Z";

function acceptedState() {
  const state = createSeedState();
  const engagement = state.engagements[0];
  engagement.versions = engagement.versions.filter((version) => version.id === "demo-v1");
  engagement.events = engagement.events.filter((event) => event.type !== "change_proposed");
  engagement.status = "accepted";
  return state;
}

test("initial terms are only a proposal until the client explicitly accepts", () => {
  const state = createSeedState();
  const engagement = createEngagement(state, {
    title: "Logo package", providerName: "Ari", clientName: "Sam",
    terms: { deliverables: ["Primary logo"], amountMinor: 10000, depositMinor: 5000, currency: "USD" }
  }, "provider", now);
  assert.equal(engagement.status, "awaiting_client");
  assert.equal(engagement.currentVersionId, null);
  assert.deepEqual(engagement.versions[0].acceptedBy, ["provider"]);
  assert.throws(() => respondToVersion(state, engagement.id, engagement.versions[0].id, "provider", "accept", "", now), /other party/);
  const result = respondToVersion(state, engagement.id, engagement.versions[0].id, "client", "accept", "Approved", now);
  assert.equal(result.engagement.currentVersionId, engagement.versions[0].id);
  assert.equal(result.engagement.status, "accepted");
});

test("proposing an amendment leaves the last mutually accepted version current", () => {
  const state = acceptedState();
  const engagement = state.engagements[0];
  const change = proposeChange(state, engagement.id, {
    baseVersionId: "demo-v1", changeSummary: "Add a page and move the date",
    terms: { dueDate: "2026-11-24", amountMinor: 105000, depositMinor: 52500, paymentTerms: "Three milestones", completionCriteria: "Written sign-off" }
  }, "provider", now);
  assert.equal(engagement.currentVersionId, "demo-v1");
  assert.equal(change.status, "proposed");
  assert.equal(change.acceptedBy[0], "provider");
  assert.equal(engagement.versions.find((version) => version.id === "demo-v1").terms.amountMinor, 85000);
  assert.equal(change.terms.paymentTerms, "Three milestones");
  assert.equal(change.terms.completionCriteria, "Written sign-off");
});

test("acceptance updates the current version; a later clarification does not", () => {
  const state = acceptedState();
  const engagement = state.engagements[0];
  const version = proposeChange(state, engagement.id, {
    baseVersionId: "demo-v1", changeSummary: "Move the due date",
    terms: { dueDate: "2026-11-24" }
  }, "provider", now);
  const result = respondToVersion(state, engagement.id, version.id, "client", "accept", "Looks good", now);
  assert.equal(result.engagement.currentVersionId, version.id);
  assert.equal(version.acceptedBy.length, 2);
  assert.equal(version.status, "accepted");

  const second = proposeChange(state, engagement.id, {
    baseVersionId: version.id, changeSummary: "Add another revision",
    terms: { revisionLimit: "3 rounds" }
  }, "provider", now);
  respondToVersion(state, engagement.id, second.id, "client", "clarification", "Does this change the fee?", now);
  assert.equal(engagement.currentVersionId, version.id);
  assert.equal(second.status, "clarification_requested");
});

test("a stale proposal cannot overwrite an accepted version and a rejection leaves it unchanged", () => {
  const state = acceptedState();
  const engagement = state.engagements[0];
  assert.throws(() => proposeChange(state, engagement.id, {
    baseVersionId: "old-version", changeSummary: "Stale edit", terms: { dueDate: "2026-11-24" }
  }, "client", now), /outdated version/);
  const version = proposeChange(state, engagement.id, {
    baseVersionId: "demo-v1", changeSummary: "Change the due date",
    terms: { dueDate: "2026-11-24" }
  }, "client", now);
  respondToVersion(state, engagement.id, version.id, "provider", "reject", "Not agreed", now);
  assert.equal(engagement.currentVersionId, "demo-v1");
  assert.equal(version.status, "rejected");
});

test("an unchanged proposal is rejected and silence creates no acceptance event", () => {
  const state = acceptedState();
  const engagement = state.engagements[0];
  const initialEventCount = engagement.events.length;
  assert.throws(() => proposeChange(state, engagement.id, {
    baseVersionId: "demo-v1", changeSummary: "No actual changes", terms: {}
  }, "provider", now), /Change at least one term/);
  assert.equal(engagement.currentVersionId, "demo-v1");
  assert.equal(engagement.versions.length, 1);
  assert.equal(engagement.events.length, initialEventCount);
});

test("partial-delivery progress is tied to the current accepted version and keeps an auditable event", () => {
  const state = acceptedState();
  const engagement = state.engagements[0];
  const event = updateDeliverableProgress(state, engagement.id, {
    versionId: "demo-v1", deliverableIndex: 0, status: "in_progress"
  }, "provider", now);
  assert.equal(getDeliverableProgress(engagement, "demo-v1", 0), "in_progress");
  assert.equal(event.actor, "provider");
  assert.equal(event.status, "in_progress");
  assert.throws(() => updateDeliverableProgress(state, engagement.id, {
    versionId: "stale-version", deliverableIndex: 0, status: "completed"
  }, "client", now), /outdated version/);
  assert.throws(() => updateDeliverableProgress(state, engagement.id, {
    versionId: "demo-v1", deliverableIndex: 0, status: "verified"
  }, "client", now), /Progress must be/);
  updateDeliverableProgress(state, engagement.id, { versionId: "demo-v1", deliverableIndex: 0, status: "completed" }, "client", now);
  assert.equal(getDeliverableProgress(engagement, "demo-v1", 0), "completed");
});

test("client delivery review is explicit, current-version scoped, and separate from agreement acceptance", () => {
  const state = acceptedState();
  const engagement = state.engagements[0];
  const event = recordDeliveryReview(state, engagement.id, { versionId: "demo-v1", action: "accept" }, "client", now);
  assert.equal(event.type, "delivery_review_recorded");
  assert.equal(event.actor, "client");
  assert.equal(event.reviewAction, "accept");
  assert.equal(getDeliveryReview(engagement, "demo-v1").id, event.id);
  assert.equal(engagement.currentVersionId, "demo-v1");
  assert.equal(engagement.status, "accepted");
  assert.throws(() => recordDeliveryReview(state, engagement.id, { versionId: "demo-v1", action: "accept" }, "provider", now), /Only the client/);
  assert.throws(() => recordDeliveryReview(state, engagement.id, { versionId: "stale-version", action: "accept" }, "client", now), /outdated version/);
  assert.throws(() => recordDeliveryReview(state, engagement.id, { versionId: "demo-v1", action: "changes_requested" }, "client", now), /Add a short note/);
  const clarification = recordDeliveryReview(state, engagement.id, { versionId: "demo-v1", action: "clarification", comment: "Which file format should the handoff use?" }, "client", now);
  assert.equal(getDeliveryReview(engagement, "demo-v1").id, clarification.id);
  assert.equal(clarification.reviewAction, "clarification");
});

test("reminders and outstanding obligations reflect response ownership, incomplete work, and due dates", () => {
  const state = acceptedState();
  const engagement = state.engagements[0];
  const current = engagement.versions[0];
  current.terms.dueDate = "2026-10-20";
  updateDeliverableProgress(state, engagement.id, { versionId: current.id, deliverableIndex: 0, status: "completed" }, "provider", now);
  const proposal = proposeChange(state, engagement.id, {
    baseVersionId: current.id, changeSummary: "Add a delivery item", terms: { deliverables: [...current.terms.deliverables, "Final handoff"] }
  }, "provider", now);
  const obligations = deriveOutstandingObligations(state.engagements, "client", new Date(now));
  assert.ok(obligations.some((item) => item.type === "response" && item.needsYou && item.versionId === proposal.id));
  assert.ok(obligations.some((item) => item.type === "deliverable" && item.status === "not_started" && item.dueDate === "2026-10-20"));
  const reminders = deriveReminders(state.engagements, "client", new Date(now));
  assert.ok(reminders.some((item) => item.type === "response"));
  assert.ok(reminders.some((item) => item.type === "due_soon" && /deliverable/.test(item.message)));
  assert.equal(deriveReminders(state.engagements, "provider", new Date(now)).some((item) => item.type === "response"), false);
});

test("overdue reminders stop once all deliverables are marked complete", () => {
  const state = acceptedState();
  const engagement = state.engagements[0];
  const current = engagement.versions[0];
  current.terms.dueDate = "2026-10-14";
  assert.equal(deriveReminders(state.engagements, "provider", new Date(now))[0].type, "overdue");
  current.terms.deliverables.forEach((_, index) => updateDeliverableProgress(state, engagement.id, {
    versionId: current.id, deliverableIndex: index, status: "completed"
  }, "provider", now));
  assert.equal(deriveReminders(state.engagements, "provider", new Date(now)).length, 0);
});

test("evidence attachments accept only bounded supported data and remain self-reported", () => {
  const state = acceptedState();
  const engagement = state.engagements[0];
  const evidence = addEvidence(state, engagement.id, {
    description: "Synthetic exported image", attachment: {
      name: "preview.txt", type: "text/plain", size: 5, dataUrl: "data:text/plain;base64,SGVsbG8="
    }
  }, "provider", now);
  assert.equal(evidence.attachment.name, "preview.txt");
  assert.equal(evidence.status, "reported");
  assert.throws(() => addEvidence(state, engagement.id, {
    description: "Unsupported executable", attachment: { name: "script.svg", type: "image/svg+xml", size: 5, dataUrl: "data:image/svg+xml;base64,SGVsbG8=" }
  }, "provider", now), /must be PDF, PNG, JPEG/);
  assert.throws(() => addEvidence(state, engagement.id, {
    description: "Mismatched bytes", attachment: { name: "notes.txt", type: "text/plain", size: 4, dataUrl: "data:text/plain;base64,SGVsbG8=" }
  }, "provider", now), /size does not match/);
  assert.throws(() => addEvidence(state, engagement.id, {
    description: "Oversized file", attachment: { name: "large.txt", type: "text/plain", size: 256 * 1024 + 1, dataUrl: "data:text/plain;base64,SGVsbG8=" }
  }, "provider", now), /between 1 byte and 256 KiB/);
});

test("provider can delete an unpaid demo agreement, but not a record with a Sandbox order", () => {
  const state = acceptedState();
  const engagement = state.engagements[0];
  assert.throws(() => deleteEngagement(state, engagement.id, "client"), /Only the provider/);
  engagement.payment.orderId = "SANDBOX-ORDER-1";
  assert.throws(() => deleteEngagement(state, engagement.id, "provider"), /Keep its payment reference/);
  engagement.payment.orderId = null;
  assert.deepEqual(deleteEngagement(state, engagement.id, "provider"), { deleted: true, engagementId: engagement.id });
  assert.equal(state.engagements.length, 0);
});
