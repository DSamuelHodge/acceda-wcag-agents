// src/index.ts
// acceda-playwright-mcp Worker
//
// Two surfaces:
//
// 1. SSE surface (/sse, /messages) — standard Playwright MCP protocol.
//    Used by Claude Desktop, VS Code Copilot, any MCP client connecting
//    remotely via mcp-remote or direct SSE.
//
// 2. Tool-invoke surface (/tool) — JSON REST API.
//    Used by the AuditAgent Service binding (PLAYWRIGHT_MCP → this Worker).
//    AuditAgent calls POST /tool with { tool, params } and gets { result }.
//    This decouples AuditAgent from the MCP wire protocol entirely.
//
// The PlaywrightMCP class is created by createMcpAgent() from
// @cloudflare/playwright-mcp. It is a Durable Object that manages a
// persistent Chromium session via Browser Rendering.

import { createMcpAgent } from '@cloudflare/playwright-mcp';

// ── Env bindings (must match wrangler.jsonc) ──────────────────────────────
export interface Env {
  BROWSER: BrowserWorker;          // Browser Rendering binding
  MCP_OBJECT: DurableObjectNamespace; // PlaywrightMCP DO namespace
  ENVIRONMENT: string;
  MAX_CONCURRENT_SESSIONS: string;
  SESSION_TIMEOUT_MS: string;
}

// ── Export PlaywrightMCP DO class ─────────────────────────────────────────
// createMcpAgent returns the class that wrangler needs as a named export
// matching the class_name in durable_objects binding.
export const PlaywrightMCP = createMcpAgent(
  // env.BROWSER is injected at runtime — pass the binding name as a string
  // so createMcpAgent can resolve it from the env object
  'BROWSER' as unknown as BrowserWorker,
  {
    // Enable inline screenshots for vision-capable clients
    imageResponses: 'allow',
  },
);

// ── CORS headers ──────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ── Tool definitions understood by the /tool invoke surface ──────────────
// These mirror the Playwright MCP tool names + add ACCEDA-specific tools
// (axe injection, a11y tree capture, behavioral scripts).
const ACCEDA_TOOLS = {
  // Navigate to URL and return page title
  navigate: async (page: PlaywrightPage, params: { url: string }) => {
    await page.goto(params.url, { waitUntil: 'networkidle', timeout: 30000 });
    return { title: await page.title(), url: page.url() };
  },

  // Inject axe-core and run WCAG audit — returns raw AxeResult
  axe_scan: async (page: PlaywrightPage, params: {
    url: string;
    wcag_level: string;
    axe_cdn: string;
  }) => {
    await page.goto(params.url, { waitUntil: 'networkidle', timeout: 30000 });

    const axeScript = `
      async () => {
        if (typeof window.axe === 'undefined') {
          await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = '${params.axe_cdn}';
            s.onload = resolve;
            s.onerror = reject;
            document.head.appendChild(s);
          });
          await new Promise(r => setTimeout(r, 600));
        }
        return await window.axe.run(document, {
          runOnly: { type: 'tag', values: ['${params.wcag_level}', 'best-practice'] },
          resultTypes: ['violations', 'incomplete', 'inapplicable'],
          reporter: 'v2'
        });
      }
    `;
    return page.evaluate(axeScript);
  },

  // Capture full accessibility tree as structured JSON
  a11y_snapshot: async (page: PlaywrightPage, params: { url: string }) => {
    await page.goto(params.url, { waitUntil: 'networkidle', timeout: 30000 });
    return page.evaluate(`
      () => {
        function captureNode(el, depth = 0) {
          if (depth > 10 || !el) return null;
          const s = window.getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden') return null;
          const node = {
            tag: el.tagName?.toLowerCase(),
            role: el.getAttribute('role') || el.tagName?.toLowerCase(),
            id: el.id || null,
            name: el.getAttribute('aria-label')
              || el.getAttribute('aria-labelledby')
              || (el.textContent || '').trim().slice(0, 80),
            hidden: el.getAttribute('aria-hidden') === 'true',
            disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
            expanded: el.getAttribute('aria-expanded'),
            selected: el.getAttribute('aria-selected'),
            checked: el.getAttribute('aria-checked') ?? el.checked,
            required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
            level: el.getAttribute('aria-level'),
            tabIndex: el.tabIndex,
            focusable: el.tabIndex >= 0,
            children: Array.from(el.children).map(c => captureNode(c, depth + 1)).filter(Boolean)
          };
          return node;
        }
        return {
          url: window.location.href,
          title: document.title,
          timestamp: new Date().toISOString(),
          tree: captureNode(document.body)
        };
      }
    `);
  },

  // Evaluate arbitrary JS in page context — used by behavioral scan scripts
  evaluate: async (page: PlaywrightPage, params: {
    url: string;
    script: string;
    args?: unknown[];
  }) => {
    await page.goto(params.url, { waitUntil: 'networkidle', timeout: 30000 });
    if (params.args && params.args.length > 0) {
      return page.evaluate(params.script, params.args);
    }
    return page.evaluate(params.script);
  },

  // Click element then evaluate — used for modal focus trap testing
  click_and_evaluate: async (page: PlaywrightPage, params: {
    url: string;
    selector: string;
    script: string;
  }) => {
    await page.goto(params.url, { waitUntil: 'networkidle', timeout: 30000 });
    try {
      const el = await page.$(params.selector);
      if (el) {
        await el.click();
        await page.waitForTimeout(400);
      }
    } catch {
      // Element may not be clickable — continue to evaluate anyway
    }
    return page.evaluate(params.script);
  },

  // Take screenshot and return as base64 PNG
  screenshot: async (page: PlaywrightPage, params: { url: string }) => {
    await page.goto(params.url, { waitUntil: 'networkidle', timeout: 30000 });
    const buffer = await page.screenshot({ type: 'png', fullPage: false });
    return { base64: Buffer.from(buffer).toString('base64'), type: 'image/png' };
  },

  // Get page title only (lightweight health check)
  get_title: async (page: PlaywrightPage, params: { url: string }) => {
    await page.goto(params.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    return { title: await page.title(), url: page.url() };
  },
} satisfies Record<string, (page: PlaywrightPage, params: Record<string, unknown>) => Promise<unknown>>;

type PlaywrightPage = {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
  evaluate(script: string, args?: unknown): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  $(selector: string): Promise<{ click(): Promise<void> } | null>;
  screenshot(options?: { type?: string; fullPage?: boolean }): Promise<Uint8Array>;
};

// ── Main Worker fetch handler ─────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const json = (data: unknown, status = 200) =>
      Response.json(data, { status, headers: CORS });

    // ── Health ──────────────────────────────────────────────────────────
    if (pathname === '/' || pathname === '/health') {
      return json({
        service: 'acceda-playwright-mcp',
        status: 'ok',
        tools: Object.keys(ACCEDA_TOOLS),
        environment: env.ENVIRONMENT,
      });
    }

    // ── SSE / MCP wire protocol ─────────────────────────────────────────
    // Route to PlaywrightMCP Durable Object for native MCP clients
    // Each session gets its own DO instance keyed by session ID
    if (pathname === '/sse' || pathname.startsWith('/messages')) {
      const sessionId = url.searchParams.get('sessionId')
        ?? request.headers.get('x-session-id')
        ?? 'default';

      const doId = env.MCP_OBJECT.idFromName(sessionId);
      const doStub = env.MCP_OBJECT.get(doId);
      return doStub.fetch(request);
    }

    // ── ACCEDA Tool Invoke surface ──────────────────────────────────────
    // POST /tool — called by AuditAgent via Service binding
    // Body: { tool: string, params: Record<string, unknown>, sessionId?: string }
    // Response: { result: unknown } | { error: string }
    if (pathname === '/tool' && request.method === 'POST') {
      let body: { tool: string; params: Record<string, unknown>; sessionId?: string };

      try {
        body = await request.json() as typeof body;
      } catch {
        return json({ error: 'Invalid JSON body' }, 400);
      }

      const { tool, params, sessionId = 'audit-default' } = body;

      if (!tool || !(tool in ACCEDA_TOOLS)) {
        return json({
          error: `Unknown tool: ${tool}. Available: ${Object.keys(ACCEDA_TOOLS).join(', ')}`,
        }, 400);
      }

      // Acquire a browser session via the PlaywrightMCP DO
      // We invoke the DO's internal page execution by routing through its fetch handler
      // with a special x-acceda-invoke header that signals direct page access mode
      const doId = env.MCP_OBJECT.idFromName(sessionId);
      const doStub = env.MCP_OBJECT.get(doId);

      // Execute tool via DO using the page-execute endpoint
      const execResponse = await doStub.fetch(
        new Request('https://playwright-mcp.internal/execute', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-acceda-tool': tool,
          },
          body: JSON.stringify({ tool, params }),
        }),
      );

      if (!execResponse.ok) {
        // DO execute failed — fall back to direct browser execution
        // This handles cases where the DO hasn't been initialised with /execute route
        return await directBrowserExecution(env, tool, params, json);
      }

      const result = await execResponse.json();
      return json({ result });
    }

    // ── Tool list ───────────────────────────────────────────────────────
    if (pathname === '/tools') {
      return json({
        tools: Object.keys(ACCEDA_TOOLS).map(name => ({
          name,
          description: getToolDescription(name),
        })),
      });
    }

    return json({ error: 'Not Found' }, 404);
  },
};

// ── Direct browser execution fallback ────────────────────────────────────
// Used when the DO route isn't available. Launches a fresh browser session,
// executes the tool, and closes. Less efficient than session reuse via DO
// but guarantees correctness as a fallback.
async function directBrowserExecution(
  env: Env,
  tool: string,
  params: Record<string, unknown>,
  json: (data: unknown, status?: number) => Response,
): Promise<Response> {
  // Dynamic import of @cloudflare/playwright to avoid top-level issues
  const { launch } = await import('@cloudflare/playwright');

  const browser = await launch(env.BROWSER);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'ACCEDA-Audit/1.0 (Accessibility Scanner)',
  });
  const page = await context.newPage();

  try {
    const toolFn = ACCEDA_TOOLS[tool as keyof typeof ACCEDA_TOOLS];
    const result = await toolFn(page as unknown as PlaywrightPage, params as Record<string, unknown>);
    return json({ result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[acceda-playwright-mcp] Tool ${tool} failed:`, message);
    return json({ error: message, tool }, 500);
  } finally {
    await browser.close();
  }
}

// ── Tool descriptions for /tools endpoint ─────────────────────────────────
function getToolDescription(name: string): string {
  const descriptions: Record<string, string> = {
    navigate: 'Navigate to a URL and return page title',
    axe_scan: 'Inject axe-core and run full WCAG audit, returning violations and incomplete items',
    a11y_snapshot: 'Capture the full accessibility tree as structured JSON for diff computation',
    evaluate: 'Evaluate arbitrary JavaScript in the page context (used for behavioral scans)',
    click_and_evaluate: 'Click an element then evaluate JS (used for modal focus trap testing)',
    screenshot: 'Take a full-page screenshot, returned as base64 PNG',
    get_title: 'Lightweight page title fetch for health checks',
  };
  return descriptions[name] ?? name;
}
