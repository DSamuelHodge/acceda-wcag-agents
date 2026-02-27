# ACCEDA Agents

**Agentic Cloudflare Continuous Evaluation & Dynamic Accessibility**

ACCEDA is a three-mode WCAG 2.2 accessibility agent built on Cloudflare's agentic infrastructure. It closes the semantic and behavioral gap that static scanners leave open.

---

## The Problem ACCEDA Solves

axe-core auto-determines **57%** of WCAG violations. The remaining **43%** — labeled `incomplete` or `inapplicable` — require semantic judgment and behavioral simulation. No existing tool closes this gap. ACCEDA does.

```
Phase 1: Static    → axe-core (57% auto-determinable)
Phase 2: Behavioral → Playwright keyboard simulation (focus, modals, tab order)
Phase 3: Semantic  → Claude reasons on the 43% undetermined
Phase 4: Verify    → S₀→S₁ diff proves remediations worked
```

---

## Three Deployment Modes

| Mode | Trigger | Output |
|------|---------|--------|
| **CI/CD** | GitHub PR webhook | PR comment + commit status gate |
| **WebMCP** | `navigator.modelContext.invokeTool()` | Browser-native agent tool calls |
| **Sentinel** | Real-time DOM observation | Live targeted fixes (not overlays) |

### Sentinel vs. Overlays

JS accessibility overlays (AccessiBe, UserWay) apply heuristic patches without understanding root causes. ACCEDA Sentinel:

1. Observes focus events, keyboard traps, and DOM mutations via MutationObserver
2. Reasons semantically about each barrier (Claude via AI Gateway)
3. Applies the minimal targeted fix to the live DOM
4. Logs every intervention with Δ diff evidence to D1

Every fix is auditable. Every claim is verifiable.

---

## Architecture

```
Cloudflare Edge
├── Worker (src/index.ts)           — HTTP router, webhook handler
├── AuditAgent (Durable Object)     — Full audit lifecycle per URL
├── SentinelAgent (Durable Object)  — Real-time per-session guardian
├── AuditWorkflow                   — Durable, retryable audit execution
├── RemediationWorkflow             — Post-fix verification loop
├── D1 (acceda-db)                  — Relational audit records
├── R2 (acceda-snapshots)           — A11y tree snapshots + screenshots
├── KV (ACCEDA_CACHE, AUDIT_KV)     — Session state, status caching
└── AI Gateway → Claude             — Semantic reasoning, Sentinel decisions
```

---

## Setup

### Prerequisites

```bash
npm install -g wrangler
wrangler login
```

### Install

```bash
npm install
```

### Configure Secrets

```bash
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put GITHUB_TOKEN
wrangler secret put WEBHOOK_SECRET
```

### Create R2 Bucket

```bash
wrangler r2 bucket create acceda-snapshots
```

### Run D1 Migrations

```bash
npm run db:migrate:dev   # local dev
npm run db:migrate       # production
```

### Deploy

```bash
npm run dev              # local development
npm run deploy:dev       # Cloudflare dev environment
npm run deploy:prod      # Cloudflare production
```

---

## API Reference

### `POST /api/audit`
Trigger a full audit.

```json
{
  "url": "https://example.com",
  "mode": "webmcp",
  "wcagLevel": "wcag2aa",
  "maxElements": 30
}
```

### `GET /api/audit/:auditId`
Retrieve audit summary from D1.

### `POST /webhook/github`
GitHub PR webhook endpoint. Configure in repo Settings → Webhooks.
Set Content-Type to `application/json`, trigger on `pull_request` events.

### `GET /webmcp/tools`
Returns all WebMCP tool descriptors.

### `GET /webmcp/register.js`
Browser-injectable script that registers ACCEDA as WebMCP tools via `navigator.modelContext`.

### `POST /sentinel/:sessionId/event`
Receives behavioral events from the Sentinel client script.

---

## WebMCP Integration

```html
<script src="https://acceda-agents.workers.dev/webmcp/register.js"></script>
```

This registers four tools with `navigator.modelContext`:
- `acceda_audit` — full three-phase audit
- `acceda_verify` — post-remediation verification
- `acceda_sentinel_inject` — activate real-time Sentinel
- `acceda_get_report` — retrieve audit report

---

## MCP Ecosystem Integration

ACCEDA composes with the emerging accessibility MCP ecosystem:

| MCP Server | Coverage | ACCEDA Complement |
|------------|----------|-------------------|
| `mcp-accessibility-scanner` | axe-core static | Behavioral + Semantic |
| `lighthouse-mcp` | Performance + a11y scores | Root cause + remediation |
| `@cloudflare/playwright-mcp` | Browser automation | A11y tree snapshots + diff |
| `chrome-devtools-mcp` | DOM inspection | Verification loop (S₀→S₁) |

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key (secret) |
| `GITHUB_TOKEN` | GitHub PAT for PR comments (secret) |
| `WCAG_LEVEL` | Default WCAG level (`wcag2aa`) |
| `MAX_ELEMENTS` | Default max elements for behavioral scan |
| `AI_GATEWAY_ID` | Cloudflare AI Gateway ID |

---

## License

MIT
