export function createSeedState() {
  return {
    schemaVersion: 1,
    engagements: [
      {
        id: "demo-pact-01",
        title: "Website refresh · Phase one",
        providerName: "Maya Okafor",
        clientName: "Jordan Lee",
        createdAt: "2026-10-14T09:00:00.000Z",
        currentVersionId: "demo-v1",
        status: "accepted",
        versions: [
          {
            id: "demo-v1",
            number: 1,
            baseVersionId: null,
            status: "accepted",
            proposedBy: "provider",
            acceptedBy: ["provider", "client"],
            createdAt: "2026-10-14T09:00:00.000Z",
            acceptedAt: "2026-10-14T10:25:00.000Z",
            changeSummary: "Original project terms",
            terms: {
              deliverables: ["5-page responsive marketing site", "Home, About, Services, Work, Contact"],
              revisionLimit: "2 rounds",
              dueDate: "2026-11-20",
              amountMinor: 85000,
              depositMinor: 42500,
              currency: "USD",
              paymentTerms: "50% deposit to start; balance after final approval",
              completionCriteria: "Client reviews the final agreed pages and records acceptance or requests changes."
            }
          },
          {
            id: "demo-v2",
            number: 2,
            baseVersionId: "demo-v1",
            status: "proposed",
            proposedBy: "provider",
            acceptedBy: ["provider"],
            createdAt: "2026-10-15T08:10:00.000Z",
            acceptedAt: null,
            changeSummary: "Add one case-study page; move delivery to Nov 23; add $175 to the total fee.",
            terms: {
              deliverables: ["6-page responsive marketing site", "Home, About, Services, Work, Contact, Case study"],
              revisionLimit: "2 rounds",
              dueDate: "2026-11-23",
              amountMinor: 102500,
              depositMinor: 51250,
              currency: "USD",
              paymentTerms: "50% deposit to start; balance after final approval",
              completionCriteria: "Client reviews the final agreed pages and records acceptance or requests changes."
            }
          }
        ],
        evidence: [],
        payment: {
          status: "not_started",
          provider: "paypal_sandbox",
          orderId: null,
          captureId: null,
          amountMinor: null,
          currency: "USD",
          requestIds: { create: null, capture: null },
          updatedAt: null
        },
        events: [
          { id: "evt-demo-1", type: "engagement_created", actor: "provider", at: "2026-10-14T09:00:00.000Z", label: "Version 1 drafted by Maya." },
          { id: "evt-demo-2", type: "version_accepted", actor: "client", at: "2026-10-14T10:25:00.000Z", label: "Jordan accepted version 1. The original terms are the current agreement." },
          { id: "evt-demo-3", type: "change_proposed", actor: "provider", at: "2026-10-15T08:10:00.000Z", label: "Maya proposed version 2. It is waiting for Jordan's explicit response." }
        ]
      }
    ],
    webhookEvents: []
  };
}
