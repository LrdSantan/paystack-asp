# Paystack Payment Processor — OKX.AI ASP (A2MCP)

An MCP server exposing Paystack payment operations so any agent on OKX.AI
can create payment links, verify transactions, and settle payouts —
no human in the loop.

## Tools exposed

| Tool | What it does |
|---|---|
| `create_payment_link` | Create a hosted Paystack checkout link |
| `verify_transaction` | Check if a payment succeeded/failed/pending |
| `create_transfer_recipient` | Register a bank account for payouts |
| `initiate_transfer` | Settle funds to a registered recipient |

## Local setup

```bash
npm install
cp .env.example .env   # fill in PAYSTACK_SECRET_KEY
npm run build
npm start
```

Server listens on `PORT` (default 3000). MCP endpoint: `POST /mcp`.
Health check: `GET /health`.

## Deploying (pick one — needs public HTTPS + a domain, per OKX's A2MCP guide)

**Option A — Railway / Render (recommended, fastest)**
1. Push this folder to a GitHub repo (or a subfolder of an existing monorepo).
2. Create a new Web Service on Railway or Render, point it at the repo.
3. Build command: `npm install && npm run build`
4. Start command: `npm start`
5. Add env var `PAYSTACK_SECRET_KEY`.
6. Attach a custom domain or use the platform's HTTPS subdomain (already HTTPS by default) — this satisfies OKX's "public HTTPS endpoint" requirement.

**Option B — Your existing Vercel workflow**
Vercel serverless functions are stateless per-invocation, which is fine
for this stateless-MCP setup, but the official MCP SDK's HTTP transport
expects a persistent Node process for best compatibility. If you want to
stay on Vercel, use a `vercel.json` with the Node server as a single
serverless function (rewrite all `/mcp` traffic to `dist/server.js`
exported as a handler) — Railway/Render is simpler for this MCP use case.

## Registering on OKX.AI (do this yourself, in your own Claude Code session)

1. `npx skills add okx/onchainos-skills --yes -g`
2. New session → "Log in to Agentic Wallet on Onchain OS with my email"
3. "Help me register an A2MCP ASP on OKX.AI using OKX Agent Identity from Onchain OS"
   — when asked for the endpoint, give it your deployed `https://your-domain/mcp` URL
4. "Help me list my ASP on OKX.AI using Onchain OS"
5. Wait ~24h for review, then submit the hackathon Google form:
   https://forms.gle/mddEUagmDbyV37ws8 (before Jul 17, 00:00 UTC)

## Notes

- `amount` params are in the major currency unit (e.g. Naira), converted
  to kobo internally — matches how Pingvo/Tixora already handle Paystack.
- `create_transfer_recipient` must be called once per bank account before
  `initiate_transfer` will work for that account (Paystack requirement).
- Test with `sk_test_...` keys first; switch to `sk_live_...` before demo day.
