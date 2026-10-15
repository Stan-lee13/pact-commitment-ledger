# PACT — clear agreements, explicit changes

PACT is a hackathon prototype for recording service-work terms, versioned change proposals, explicit responses, and self-reported delivery notes in one readable timeline. It keeps agreement status separate from payment status. It is **not** legal software, an escrow service, a payment intermediary, or proof that work was delivered or accepted.

## Public demo

**Live demo:** [Open PACT on Vercel](https://pact-commitment-ledger.vercel.app)

The Vercel deployment is a **static, browser-local demo**. It uses fictional seed records and stores each visitor's changes in that visitor's browser `localStorage`; visitors do not share records. There are no user accounts, cloud synchronization, server-side writes, live payments, or public AI calls. AI extraction and PayPal Sandbox are intentionally disabled on the hosted demo. Do not enter real names, contract terms, messages, or payment data.

Use **Reset this browser demo** in the workspace or clear this site's browser storage to restore the fictional seed. Browser-local storage is not a secure vault; this mode is for demonstration only.

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

Optional local AI uses Ollama on the same computer. Candidate terms are suggestions only: exact source quotes are checked, and a person must review and apply every field. Source text is sent only to the configured local Ollama endpoint.

## What the prototype demonstrates

- An initial draft does not become current until the client explicitly accepts it.
- Amendments are versioned. The previous accepted version remains current until the other party explicitly accepts a proposed change.
- Rejection and clarification are explicit states; silence is never consent.
- Delivery/evidence notes are attributed and labelled self-reported, not verified.
- The displayed agreement, any payment reference, and reported work status remain separate.
- PayPal support, when enabled locally, uses Sandbox Orders v2 and calculates the amount on the server. A standard Sandbox capture goes to the configured test merchant, **not** the service provider. It is not escrow, a payout, or proof of delivery.

## PayPal Sandbox (local development only)

Set `PAYPAL_ENV=sandbox`, `PAYPAL_CLIENT_ID`, and `PAYPAL_CLIENT_SECRET` in the local server environment. Checkout remains disabled when either credential is absent. Keep credentials out of source control and never substitute live credentials. The prototype supports one USD Sandbox payment per agreement.

PayPal marketplace/seller settlement for production requires PayPal partner approval and a separately reviewed integration. No live-money payment or provider payout is implemented here.

## Verification and release workflow

```bash
npm ci
npm test
npm run check
npm run build
npm audit --omit=dev
```

GitHub Actions runs the test, syntax, build, and dependency-audit checks on Node 22 and 24. The static build intentionally contains only the front-end, the shared domain rules, and fictional seed data; it does not include the Node server, local JSON store, environment files, or PayPal credentials. Vercel adds a restrictive Content Security Policy, HSTS, and standard security headers.

## Production boundary — read before real use

The public demo is suitable for a hackathon walkthrough with synthetic data; **the product is not production-ready for real users or real agreements**. The role selector is a demo simulator, not authentication or authorization. The browser-local demo is not shared storage and is not tamper-resistant. The local backend is a single-process JSON-file prototype.

A real multi-user service still requires, at minimum: authenticated accounts and party-scoped authorization on every operation; expiring invitations; a durable database with transactions and backups; abuse/rate controls; CSRF and session design; retention/export/deletion policies; observability and incident response; privacy/legal review; accessibility and cross-browser review; and an independently reviewed live-payment design. Do not represent a Sandbox payment as a provider payout. Nigerian receiving-account, seller, fee, and legal availability must be checked with the relevant providers and advisers before any production payments work.

## Trust boundaries

AI never decides what was agreed. A matching quote is provenance assistance, not proof of truth. Silence is never consent. A payment does not prove delivery or quality. A timestamp, local record, or file hash does not establish legal enforceability or admissibility.

## License

This project is licensed under the MIT License. See [`LICENSE`](LICENSE) for the full terms.

## Architecture

See [`docs/README.md`](docs/README.md) for the diagrams and the recommended future relational schema. The running local backend uses a JSON file; the hosted public demo uses browser-local storage. The schema diagram describes a proposed future design, not deployed infrastructure.
