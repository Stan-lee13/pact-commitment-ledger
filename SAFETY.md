# Safety and go-live boundary

The hosted Vercel build is a static synthetic-data demonstration. It does not deploy the Node API or server-side writable store. Public demo changes stay in each visitor's browser storage; there are no accounts, cross-user records, cloud sync, public AI calls, or payments. Do not enter real data: browser storage is not a secure vault. JSON/CSV export is local to the visitor, and JSON exports embed any attachments.

The local Node server is a disposable prototype, not a live contract, client portal, legal record, marketplace, or payment service.

1. Keep demo data fictional; do not paste real client agreements, emails, bank details, or cards. Optional attachments are limited to small PDF, PNG, JPEG, TXT, CSV, or Markdown files and stay in browser-local storage; PACT does not scan or verify them.
2. The provider/client role switcher is demonstrative and can be changed by any visitor. Production requires authenticated identity, signed expiring invitation tokens, party-scoped authorization on every operation, CSRF/session controls, rate limits, durable database constraints and backups, retention/deletion controls, monitoring, and independent security review.
3. PayPal credentials must be Sandbox-only. Every standard Orders v2 capture goes to the configured Sandbox merchant account. No provider payout, split settlement, or escrow is implemented. PayPal's production marketplace services require partner approval.
4. The local JSON file store is single-process and not production persistence. The public static demo is isolated per browser, not a multi-user product.
5. Optional browser notifications are opt-in, local to one browser, and run only while the app is open. They are not a durable reminder service, email, push notification, or background scheduler.
6. Before any real-user or live-payment use, complete privacy, legal, security, accessibility, reliability, payment-partner, and operational reviews. Never imply that a payment proves delivery or creates escrow.
7. This repository is licensed under the MIT License; see [`LICENSE`](LICENSE) for the terms.
