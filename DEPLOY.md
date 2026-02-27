# ACCEDA Deployment Runbook

Two Workers must be deployed in order. `acceda-playwright-mcp` must exist before
`acceda-server-production` deploys, because the main worker declares a Service binding
to it that Cloudflare validates at deploy time.

## Order of Operations

### Step 1 — Infrastructure (one-time)

```bash
# R2 bucket for a11y snapshots
wrangler r2 bucket create acceda-snapshots

# D1 migrations (production)
wrangler d1 execute acceda-db --file=./infra/schema.sql

# Secrets
wrangler secret put ANTHROPIC_API_KEY   # your Anthropic key
wrangler secret put GITHUB_TOKEN        # repo:status, pull_requests scopes
wrangler secret put WEBHOOK_SECRET      # GitHub webhook secret
```

Create **AI Gateway** in Cloudflare dashboard:
→ AI → AI Gateway → Create Gateway → name: `acceda-gateway`

### Step 2 — Deploy Playwright MCP Worker first

```bash
cd packages/acceda-playwright-mcp
npm install
npx wrangler deploy
```

Expected output:
```
Deployed acceda-playwright-mcp (X.Xs)
  https://acceda-playwright-mcp.<your-subdomain>.workers.dev
- MCP_OBJECT: PlaywrightMCP
- BROWSER (Browser Rendering)
```

Smoke test:
```bash
curl https://acceda-playwright-mcp.<subdomain>.workers.dev/health
# {"service":"acceda-playwright-mcp","status":"ok","version":"0.1.0"}
```

### Step 3 — Deploy main ACCEDA worker

```bash
cd ../..   # back to repo root
npm install
npx wrangler deploy
```

The Service binding `PLAYWRIGHT_MCP → acceda-playwright-mcp` is now resolvable.

### Step 4 — GitHub webhook

In your target repo Settings → Webhooks → Add webhook:
- Payload URL: `https://acceda-agents.<subdomain>.workers.dev/webhook/github`
- Content type: `application/json`
- Secret: same value as `WEBHOOK_SECRET`
- Events: `Pull requests`

### Step 5 — Verify end-to-end

```bash
# Trigger a manual audit via the API
curl -X POST https://acceda-agents.<subdomain>.workers.dev/api/audit \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","wcagLevel":"wcag2aa","mode":"webmcp"}'

# Poll for result
curl https://acceda-agents.<subdomain>.workers.dev/api/audit/<auditId>
```

## Architecture Recap

```
GitHub PR webhook
      │
      ▼
acceda-agents Worker (main)
  AuditWorkflow (Durable)
      │
      ├── AuditAgent DO ──────► acceda-playwright-mcp Worker  ◄── Browser Rendering
      │   (state machine)              /tool REST endpoint           (Chromium)
      │        │                       /mcp SSE endpoint
      │        │
      │   Phase 1: axe-core via evaluate
      │   Phase 2: behavioral via evaluate + click_and_evaluate  
      │   Phase 3: Claude via AI Gateway
      │   Phase 4: snapshot diff S₀→S₁
      │
      ├── D1 (acceda-db)      — violation records, sessions, diffs
      ├── R2 (acceda-snapshots) — a11y tree JSON, screenshots
      └── KV (AUDIT_KV)       — real-time status, WebSocket state
```

## Environment Variables Reference

| Variable | Where set | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | `wrangler secret put` | Claude API access via AI Gateway |
| `GITHUB_TOKEN` | `wrangler secret put` | PR comments + commit status |
| `WEBHOOK_SECRET` | `wrangler secret put` | GitHub webhook HMAC validation |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub Actions secret | For CI deploy |
| `CLOUDFLARE_API_TOKEN` | GitHub Actions secret | For CI deploy |
