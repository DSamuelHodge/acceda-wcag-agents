# acceda-playwright-mcp

Browser execution service for ACCEDA. A Cloudflare Worker wrapping `@cloudflare/playwright-mcp` with Chromium via Browser Rendering.

## What it does

Exposes two surfaces:

**1. `/tool` — ACCEDA internal tool-invoke API**
Called by `AuditAgent` via Cloudflare Service binding. Accepts `{ tool, params, sessionId }` JSON and returns `{ result }`.

Available tools:
| Tool | Description |
|------|-------------|
| `axe_scan` | Inject axe-core, run WCAG audit → AxeResult |
| `a11y_snapshot` | Capture full accessibility tree as JSON |
| `evaluate` | Run arbitrary JS in page context (behavioral scans) |
| `click_and_evaluate` | Click element + evaluate (modal trap testing) |
| `screenshot` | Take screenshot → base64 PNG |
| `navigate` | Navigate to URL → title |
| `get_title` | Lightweight title fetch |

**2. `/sse` — Playwright MCP wire protocol**
Standard MCP SSE endpoint for Claude Desktop, VS Code Copilot, and any `mcp-remote` client.

## Deploy

```bash
npm install

# Deploy (Browser Rendering is enabled at account level)
npm run deploy
```

## Wire into acceda-agents

The `acceda-agents` Worker references this via Service binding:
```jsonc
"services": [
  { "binding": "PLAYWRIGHT_MCP", "service": "acceda-playwright-mcp" }
]
```

Deploy this Worker **first** before deploying `acceda-agents`.

## MCP client config (remote)

```json
{
  "mcpServers": {
    "acceda-playwright": {
      "command": "npx",
      "args": ["mcp-remote", "https://acceda-playwright-mcp.workers.dev/sse"]
    }
  }
}
```

## Requirements

- Cloudflare account with **Browser Rendering** enabled
- `compatibility_date >= 2025-09-15`
- `nodejs_compat` flag
