import test from "node:test";
import assert from "node:assert/strict";
import { createSeedState } from "../src/demo-data.mjs";
import { createEngagement, proposeChange, respondToVersion } from "../src/domain.mjs";

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
    terms: { dueDate: "2026-11-24", amountMinor: 105000, depositMinor: 52500 }
  }, "provider", now);
  assert.equal(engagement.currentVersionId, "demo-v1");
  assert.equal(change.status, "proposed");
  assert.equal(change.acceptedBy[0], "provider");
  assert.equal(engagement.versions.find((version) => version.id === "demo-v1").terms.amountMinor, 85000);
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
