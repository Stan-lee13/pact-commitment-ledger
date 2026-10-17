# PACT — clear agreements, explicit changes

PACT is a hackathon prototype for recording service-work terms, versioned change proposals, explicit responses, and self-reported delivery notes in one readable timeline. It keeps agreement status separate from payment status. It is **not** legal software, an escrow service, a payment intermediary, or proof that work was delivered or accepted.

## Public demo

**Live demo:** [Open PACT on Vercel](https://pact-commitment-ledger.vercel.app)

The Vercel deployment offers a **browser-local demo**, an opt-in **shared D1 bearer-link demo**, and a **pseudonymous account D1 demo**. Browser-local edits stay in the visitor's `localStorage`. Account creation generates a random handle and a one-time 256-bit account key; there is no password, email, name, or identity check. D1 stores only the key's SHA-256 hash, while the browser receives a seven-day Secure, HttpOnly, SameSite=Strict session cookie. Accounts and workspaces expire after 30 days. The key cannot be recovered, but a signed-in participant can replace it and revoke other sessions. Save the key securely; never reuse a real password or secret.

Each account workspace is a fresh copy of the built-in fictional sample. Server-side membership fixes one Provider and one Client account to their role; a Client invite is a hashed, one-time token claimed by the first eligible account and expires with the workspace. Account mode disables agreement creation/deletion and all PayPal routes. The older shared-link mode remains bearer access: anyone holding a Provider or Client link can act as that role. Neither demo mode proves who a participant is, verifies legal identity, or establishes enforceability. Use fictional names, terms, messages, and attachments only.

Shared demo records are stored in a Cloudflare D1 database in West Europe. The project keeps this setup within Cloudflare's Free plan: the published D1 limits are **5 million rows read/day, 100,000 rows written/day, and 5 GB total storage** ([Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)). The Worker caps active shared/account workspaces at 128 and active pseudonymous accounts at 128; each account can create up to three workspaces. It expires demo rows and invitations after 30 days, cleans expired rows when a new share, account, or workspace is created, and returns an unavailable response if D1's free daily limits are reached; it does not switch to paid services. PayPal's optional Sandbox flow remains available only in browser-local mode. Optional AI sends only selected text to the existing temporary authenticated Ollama/Qwen3 bridge; it can be unavailable when its host sleeps, and manual entry remains available. No paid AI API or live-money PayPal credentials are used.

In browser-local mode, use **Reset this browser demo** or clear this site's browser storage to restore the fictional seed. Shared links, account sessions, and workspaces expire after 30, 7, and 30 days respectively. Neither storage mode is a secure vault.

## Quick judge walkthrough

1. **AI:** Open **New Agreement**, paste or import a fictional TXT/CSV/Markdown source note, and select **Extract suggestions**. Imports are read in this browser; only after you click Extract is the selected text sent to the temporary Ollama bridge. Each suggestion stays a draft with a visible source quote; review and apply it yourself.
2. **Agreement flow:** Switch between Provider and Client demo roles, accept the seed draft, propose a change, inspect the version diff, and explicitly accept, clarify, or reject. Then try delivery progress, evidence notes, the separate client delivery-review actions (accept, request in-scope changes, or ask for delivery clarification), outstanding obligations, browser reminders, JSON/CSV export, and safe deletion of an unpaid record.
3. **PayPal:** Open the seed agreement with its accepted version, switch to Client, and select **Continue to PayPal Sandbox**. PayPal shows the test amount on its hosted approval page; after a Sandbox buyer approves, PACT returns and captures/verifies the order server-side. Use a Sandbox buyer account you control; there is no buyer login in this repository. No live-money checkout is available.
4. **Shared D1 links:** Select **Share fictional sample**, confirm fictional-only use, and copy the Provider and Client links. Open each link in a separate browser to verify that role is fixed and that edits sync to the same one-record demo. A Provider-link holder can replace the Client invite; the prior Client link stops working and the original expiry is preserved. This remains bearer-link access, not identity verification.
5. **Pseudonymous accounts:** Select **Demo account**, create an account with fictional-only confirmation, and save the generated handle plus key. Create a fictional workspace and copy its one-time Client invite. In a separate browser, create or sign into another demo account and claim the invitation. Check that the two fixed roles share one sample while an unrelated account cannot open it. Account keys prove possession only; there is no email verification, identity proof, PayPal, or record deletion.

The demo includes version comparisons, self-reported delivery progress and review, search/status filters, JSON/CSV exports, and evidence notes with optional bounded attachments. Delivery review is separate from agreement status and does not verify fulfilment or trigger payment. AI source import accepts plain-text TXT/CSV/Markdown up to 15 KB; files are read locally and are not sent until you click **Extract suggestions**. Evidence attachments are restricted to PDF/PNG/JPEG/TXT/CSV/Markdown, 256 KiB each and 1 MiB per agreement; browser-local attachments remain in that browser, while shared/account-mode attachments are stored with the single fictional sample in D1. Optional browser notifications run only while this page is open. There is no email, push service, or background scheduler.

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

The public demo is suitable only for a hackathon walkthrough with synthetic data; **the product is not production-ready for real users or real agreements**. Browser-local mode has no shared storage. Shared D1 bearer links have fixed roles and expiry, and the Provider bearer link itself cannot be revoked. Pseudonymous account mode adds hashed random account keys, expiring HttpOnly sessions, one-time Client invites, and server-checked workspace membership, but it does not verify human identity, provide account recovery, or protect against a compromised key or browser. The fictional-only confirmation is a user attestation; PACT does not detect or technically block personal or contract data. The in-memory request throttles are best-effort and may be bypassed; they are not deliberate-abuse protection. This is still a demo—not a private legal portal. The local backend is a single-process JSON-file prototype.

A real multi-user service still requires, at minimum: a reviewed identity and account-recovery model; verified party-scoped authorization; revocable invitations; managed retention and deletion; durable backups and recovery; abuse controls that persist across instances and use trusted client identity; observability and incident response; privacy/legal review; accessibility/cross-browser review; and an independently reviewed live-payment design. Do not represent a Sandbox payment as a provider payout. Nigerian receiving-account, seller, fee, and legal availability must be checked with the relevant providers and advisers before any production payments work.

## Trust boundaries

AI never decides what was agreed. A matching quote is provenance assistance, not proof of truth. Silence is never consent. A payment does not prove delivery or quality. A timestamp, local record, or file hash does not establish legal enforceability or admissibility.

## License

This project is licensed under the MIT License. See [`LICENSE`](LICENSE) for the full terms.

## Architecture

See [`docs/README.md`](docs/README.md) for the diagrams and the recommended future relational schema. The local backend uses a JSON file; the hosted demo offers browser-local storage, legacy bearer-link shares, and pseudonymous account workspaces. The deployed Worker stores one fictional sample per D1 workspace, SHA-256 hashes of account keys and sessions, fixed role memberships, and one-time invite hashes with 30-day expiry. It is demo infrastructure, not verified identity or production authentication. The schema diagram describes a proposed future design, not the deployed schema.
