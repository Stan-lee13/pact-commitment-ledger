# PACT — clear agreements, explicit changes

PACT is a hackathon prototype for recording service-work terms, versioned change proposals, explicit responses, and self-reported delivery notes in one readable timeline. It keeps agreement status separate from payment status. It is **not** legal software, an escrow service, a payment intermediary, or proof that work was delivered or accepted.

## Public demo

**Live demo:** [Open PACT on Vercel](https://pact-commitment-ledger.vercel.app)

The Vercel deployment serves a **browser-local demo plus serverless AI/PayPal routes**. Fictional seed records and each visitor's edits stay in that visitor's browser `localStorage`; visitors do not share records and there are no user accounts or cloud synchronization. PayPal uses a hosted Sandbox approval page and server-side capture; no PayPal credential is sent to the browser. Optional AI sends only the text selected in the form to a temporary authenticated Ollama/Qwen3 service hosted on the builder's computer; that service can be unavailable when the computer sleeps. Use fictional text only. Do not enter real names, contract terms, messages, or payment data. No paid AI API or live-money PayPal credentials are used.

Use **Reset this browser demo** in the workspace or clear this site's browser storage to restore the fictional seed. Browser-local storage is not a secure vault; this mode is for demonstration only.

## Quick judge walkthrough

1. **AI:** Open **New Agreement**, paste or import a fictional TXT/CSV/Markdown source note, and select **Extract suggestions**. Imports are read in this browser; only after you click Extract is the selected text sent to the temporary Ollama bridge. Each suggestion stays a draft with a visible source quote; review and apply it yourself.
2. **Agreement flow:** Switch between Provider and Client demo roles, accept the seed draft, propose a change, inspect the version diff, and explicitly accept, clarify, or reject. Then try delivery progress, evidence notes, the separate client delivery-review actions (accept, request in-scope changes, or ask for delivery clarification), outstanding obligations, browser reminders, JSON/CSV export, and safe deletion of an unpaid record.
3. **PayPal:** Open the seed agreement with its accepted version, switch to Client, and select **Continue to PayPal Sandbox**. PayPal shows the test amount on its hosted approval page; after a Sandbox buyer approves, PACT returns and captures/verifies the order server-side. Use a Sandbox buyer account you control; there is no buyer login in this repository. No live-money checkout is available.

The demo includes full amendment comparisons, per-deliverable self-reported progress, explicit client delivery review, an across-agreement outstanding-obligations view, search/status filters, JSON and CSV exports, safe deletion of unpaid browser-local records, and evidence notes with optional small attachments. Delivery review is a separate self-reported event; it does not change agreement terms, verify fulfilment, or trigger payment. AI source import accepts plain-text TXT/CSV/Markdown up to 15 KB; files are read in the browser and are not sent until you click **Extract suggestions**. Evidence attachments are restricted to PDF/PNG/JPEG/TXT/CSV/Markdown, 256 KiB each and 1 MiB per agreement; they remain in local browser storage and are embedded in JSON exports. Optional browser notifications are derived from pending responses and due dates and run only while this page is open in this browser. There is no email, push service, or background scheduler.

## Run locally

Requirements: Node.js 22 or newer; no runtime dependencies.

```bash
npm ci
npm test
npm run check
npm run build
npm start
```

Open <http://127.0.0.1:3000>. The local Node server stores synthetic and user-entered prototype records in `data/store.json` (ignored by Git). The local mode is still single-process, unauthenticated, and not safe for real client data. Use `cp .env.example .env` only if you need to configure local Ollama or PayPal Sandbox; leave payment secrets blank otherwise.

Optional local AI uses Ollama on the same computer. Candidate terms are suggestions only: exact source quotes are checked, and a person must review and apply every field. For the public demo, a small authenticated bridge forwards the selected text to local Ollama; no prompt is deliberately logged by the bridge, but the service is temporary and must be treated as a public demo dependency. See `scripts/ollama-bridge.mjs` for the bounded request and token checks.

The public AI route is enabled only while the temporary Ollama bridge is reachable. Its Vercel Production variables are `PACT_AI_ENDPOINT`, `PACT_AI_BRIDGE_TOKEN`, and `PACT_AI_MODEL`; set the same random token (at least 32 characters) as a sensitive Vercel variable and on the inference host. Start the bridge with `HOST=0.0.0.0 PORT=4174 PACT_AI_MODEL=qwen3:4b-instruct npm run ai:bridge` after exporting that token. The inference host must also have Ollama running with that model. If the host sleeps or Ollama is unavailable, the app keeps manual term entry available. No paid AI API is used.

## What the prototype demonstrates

- An initial draft does not become current until the client explicitly accepts it.
- Amendments are versioned and compared field by field. The previous accepted version remains current until the other party explicitly accepts a proposed change.
- Rejection and clarification are explicit states; silence is never consent.
- Delivery progress can be tracked per deliverable; the client can separately accept delivery, request an in-scope correction, or ask for clarification. These are self-reported review events, not verification, and do not change agreement or payment status.
- Evidence notes and optional small attachments are attributed and labelled self-reported, not verified.
- Multiple agreements can be searched, filtered by status, and reviewed together in an outstanding-obligations view.
- Agreement records can be exported as JSON backups (including attachment data) or CSV summaries.
- Optional due-date and response reminders are browser-local; notifications require opt-in and work only while the page is open.
- The displayed agreement, any payment reference, and reported work status remain separate.
- PayPal Checkout uses Sandbox Orders v2, creates the order from the current accepted version, signs the quote for capture, and verifies the captured amount and currency on the server. A standard Sandbox capture goes to the configured test merchant, **not** the service provider. It is not escrow, a payout, or proof of delivery. The role selector is only a simulator; do not treat the public route as authenticated.

## PayPal Sandbox

For local Node development, set `PAYPAL_ENV=sandbox`, `PAYPAL_CLIENT_ID`, and `PAYPAL_CLIENT_SECRET` in the server environment. For hosted Vercel, set `PAYPAL_ENV`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PACT_PAYMENT_SIGNING_KEY`, and `PACT_PUBLIC_URL` as server-side Production environment variables. All PayPal credentials remain server-side. The server creates the Orders v2 order, validates PayPal's `approve`/`payer-action` link is a Sandbox checkout URL, then the browser redirects to that hosted page. A signed expiring quote binds the order, agreement version, and amount; after PayPal returns, the server captures and verifies the completed amount and currency. Never substitute live credentials. The demo supports one USD Sandbox payment per agreement and only enables checkout for a mutually accepted version with a positive amount. Use a Sandbox buyer account you control; no buyer credentials are included in this repository.

PayPal marketplace/seller settlement for production requires PayPal partner approval and a separately reviewed integration. No live-money payment or provider payout is implemented here.

## Verification and release workflow

```bash
npm ci
npm test
npm run check
npm run build
npm audit --omit=dev
```

GitHub Actions runs the test, syntax, build, and dependency-audit checks on Node 22 and 24. The static output contains the front-end, shared domain rules, and fictional seed data; Vercel deploys the Node API routes separately. The build does not include the local JSON store, environment files, or PayPal credentials. Vercel adds a restrictive Content Security Policy, HSTS, and standard security headers.

## Production boundary — read before real use

The public demo is suitable for a hackathon walkthrough with synthetic data; **the product is not production-ready for real users or real agreements**. The role selector is a demo simulator, not authentication or authorization. The browser-local demo is not shared storage and is not tamper-resistant. The local backend is a single-process JSON-file prototype.

A real multi-user service still requires, at minimum: authenticated accounts and party-scoped authorization on every operation; expiring invitations; a durable database with transactions and backups; abuse/rate controls; CSRF and session design; retention/export/deletion policies; observability and incident response; privacy/legal review; accessibility and cross-browser review; and an independently reviewed live-payment design. Do not represent a Sandbox payment as a provider payout. Nigerian receiving-account, seller, fee, and legal availability must be checked with the relevant providers and advisers before any production payments work.

## Trust boundaries

AI never decides what was agreed. A matching quote is provenance assistance, not proof of truth. Silence is never consent. A payment does not prove delivery or quality. A timestamp, local record, or file hash does not establish legal enforceability or admissibility.

## License

This project is licensed under the MIT License. See [`LICENSE`](LICENSE) for the full terms.

## Architecture

See [`docs/README.md`](docs/README.md) for the diagrams and the recommended future relational schema. The running local backend uses a JSON file; the hosted public demo uses browser-local storage. The schema diagram describes a proposed future design, not deployed infrastructure.
