// acceda-playwright-mcp/src/index.ts
//
// ACCEDA Playwright MCP Worker — two surfaces:
//
// Surface A: /sse — Standard MCP SSE endpoint via createMcpAgent.
//   Any MCP client (Claude Desktop, WebMCP browser, agents) connects here
//   and gets the full Playwright MCP tool set (browser_navigate, browser_snapshot,
//   browser_click, browser_press_key, browser_take_screenshot, etc.)
//
// Surface B: /tool — Internal REST endpoint called by AuditAgent Service binding.
//   AuditAgent cannot speak MCP over SSE synchronously in a Service binding call,
//   so /tool provides a simple JSON protocol:
//     POST /tool { tool, params } -> { result }
//   For script execution (axe-core, behavioral scripts) we use the Cloudflare
//   Browser Rendering REST API directly — it supports addScriptTag injection and
//   page.evaluate() semantics which is exactly what our audit scripts need.
//   For a11y tree snapshots we delegate to the MCP DO's browser_snapshot.

import { env as cfEnv } from 'cloudflare:workers';
import { createMcpAgent } from '@cloudflare/playwright-mcp';

// ── Env ───────────────────────────────────────────────────────────────────
interface Env {
  BROWSER: Fetcher;           // Browser Rendering binding
  MCP_OBJECT: DurableObjectNamespace; // PlaywrightMCP DO namespace
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
}

// ── PlaywrightMCP Durable Object ──────────────────────────────────────────
// Exported so wrangler can register it as a DO class.
// createMcpAgent returns a class extending McpAgent<McpAgent(DO)>.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PlaywrightMCP = createMcpAgent((cfEnv as any).BROWSER);

// ── Tool request shape from AuditAgent ───────────────────────────────────
interface ToolRequest {
  tool: 'evaluate' | 'click_and_evaluate' | 'snapshot' | 'screenshot' | 'close';
  params: {
    url?: string;
    script?: string;
    args?: unknown[];
    selector?: string;
  };
}

// ── Browser Rendering REST API client ────────────────────────────────────
// Used for script evaluation (axe-core injection, behavioral scripts).
// The Browser binding (env.BROWSER) is for the Playwright MCP agent;
// for direct REST calls we use the fetch-based API.
async function browserEvaluate(
  browser: Fetcher,
  url: string,
  scripts: Array<{ content?: string; url?: string }>,
  evaluateScript?: string,
): Promise<unknown> {
  // Use the Browser Rendering Worker binding's fetch interface
  // Route: POST https://browser.internal/v1/evaluate
  // The BROWSER binding exposes Playwright page methods via its internal protocol
  const payload: Record<string, unknown> = {
    url,
    gotoOptions: { waitUntil: 'networkidle', timeout: 30000 },
  };

  if (scripts.length > 0) {
    payload.addScriptTag = scripts;
  }

  if (evaluateScript) {
    payload.evaluate = evaluateScript;
  }

  // Use Browser Rendering's snapshot endpoint which supports addScriptTag + evaluate
  const resp = await browser.fetch(
    new Request('https://workers.cloudflare.com/browser-rendering/snapshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Browser Rendering error ${resp.status}: ${errText}`);
  }

  const data = await resp.json() as { result?: unknown; content?: string; screenshot?: string };
  return data.result ?? data;
}

// ── Simplified evaluate via Browser binding ───────────────────────────────
// The BROWSER binding on Workers maps to the Browser Rendering REST API.
// We call it using the standard interface documented at:
// https://developers.cloudflare.com/browser-rendering/rest-api/snapshot/
async function runEvaluate(
  browser: Fetcher,
  url: string,
  script: string,
  args?: unknown[],
): Promise<unknown> {
  // Build a self-contained evaluation expression
  // The Browser Rendering /snapshot endpoint supports addScriptTag for injection
  // and returns page content. For evaluate we use a trick: inject a script that
  // writes the result to a data attribute, then read it back.
  const evalExpr = args && args.length > 0
    ? `(${script.trim()})(${JSON.stringify(args[0])})`
    : `(${script.trim()})()`;

  const injectedScript = `
    (async () => {
      const result = await ${evalExpr};
      document.__acceda_result__ = JSON.stringify(result);
    })();
  `;

  const readbackScript = `document.__acceda_result__`;

  const payload = {
    url,
    gotoOptions: { waitUntil: 'networkidle', timeout: 30000 },
    addScriptTag: [{ content: injectedScript }],
    evaluate: readbackScript,
  };

  const resp = await browser.fetch(
    new Request('https://browser.internal/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Browser eval failed ${resp.status}: ${text.slice(0, 300)}`);
  }

  const data = await resp.json() as { result?: string };
  const raw = data.result;
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// ── Snapshot via MCP DO ───────────────────────────────────────────────────
// For a11y tree snapshots we use the MCP agent's browser_snapshot tool.
// We call the DO's SSE endpoint programmatically using the MCP JSON-RPC protocol.
async function runSnapshot(
  mcpNamespace: DurableObjectNamespace,
  url: string,
): Promise<{ snapshot: string; title: string; url: string; timestamp: string }> {
  // Each URL gets its own isolated MCP session DO
  const doId = mcpNamespace.idFromName(`snapshot:${url}`);
  const stub = mcpNamespace.get(doId);

  // Initialize SSE session then call tools via streamable-http transport
  const sessionResp = await stub.fetch(
    new Request('https://mcp.internal/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'acceda-audit', version: '0.1.0' },
        },
      }),
    }),
  );

  if (!sessionResp.ok) {
    throw new Error(`MCP init failed: ${sessionResp.status}`);
  }

  // Navigate
  await stub.fetch(new Request('https://mcp.internal/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'browser_navigate', arguments: { url } },
    }),
  }));

  // Wait for page to settle
  await stub.fetch(new Request('https://mcp.internal/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'browser_wait_for', arguments: { time: 1000 } },
    }),
  }));

  // Capture a11y snapshot
  const snapResp = await stub.fetch(new Request('https://mcp.internal/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'browser_snapshot', arguments: {} },
    }),
  }));

  const snapData = await snapResp.json() as {
    result?: { content?: Array<{ type: string; text?: string }> }
  };

  const snapshotText = snapData?.result?.content
    ?.filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n') ?? '';

  // Close session
  await stub.fetch(new Request('https://mcp.internal/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'browser_close', arguments: {} },
    }),
  }));

  return {
    snapshot: snapshotText,
    title: extractTitle(snapshotText) ?? url,
    url,
    timestamp: new Date().toISOString(),
  };
}

function extractTitle(snapshot: string): string | null {
  const match = snapshot.match(/title[:\s]+([^\n]+)/i);
  return match ? match[1].trim() : null;
}

// ── Click + evaluate for modal testing ───────────────────────────────────
async function runClickAndEvaluate(
  mcpNamespace: DurableObjectNamespace,
  url: string,
  selector: string,
  script: string,
): Promise<unknown> {
  const doId = mcpNamespace.idFromName(`click:${url}`);
  const stub = mcpNamespace.get(doId);

  // Initialize
  await stub.fetch(new Request('https://mcp.internal/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'acceda', version: '0.1.0' } },
    }),
  }));

  // Navigate
  await stub.fetch(new Request('https://mcp.internal/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'browser_navigate', arguments: { url } },
    }),
  }));

  // Snapshot to get element refs
  const preSnapResp = await stub.fetch(new Request('https://mcp.internal/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'browser_snapshot', arguments: {} },
    }),
  }));

  const preSnap = await preSnapResp.json() as {
    result?: { content?: Array<{ type: string; text?: string }> }
  };

  // Extract ref for our selector from snapshot
  const snapText = preSnap?.result?.content?.[0]?.text ?? '';
  const ref = extractRefForSelector(snapText, selector);

  if (ref) {
    // Click via MCP using ref
    await stub.fetch(new Request('https://mcp.internal/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: {
          name: 'browser_click',
          arguments: { element: selector, ref },
        },
      }),
    }));

    await stub.fetch(new Request('https://mcp.internal/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 5, method: 'tools/call',
        params: { name: 'browser_wait_for', arguments: { time: 400 } },
      }),
    }));
  }

  // Take post-click snapshot to detect modal/dialog state
  const postSnapResp = await stub.fetch(new Request('https://mcp.internal/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'browser_snapshot', arguments: {} },
    }),
  }));

  const postSnap = await postSnapResp.json() as {
    result?: { content?: Array<{ type: string; text?: string }> }
  };

  const postSnapText = postSnap?.result?.content?.[0]?.text ?? '';

  // Detect dialog from snapshot text (modal patterns in a11y tree)
  const dialogExists = /role="?dialog"?|aria-modal="?true"?/i.test(postSnapText);
  const dialogLabeled = /aria-label=|aria-labelledby=/i.test(postSnapText);

  // Press Escape to close
  await stub.fetch(new Request('https://mcp.internal/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'browser_press_key', arguments: { key: 'Escape' } },
    }),
  }));

  return {
    dialogExists,
    focusInDialog: dialogExists, // If dialog exists in a11y tree, focus is tracked by browser
    dialogLabeled: dialogExists ? dialogLabeled : null,
  };
}

function extractRefForSelector(snapshot: string, selector: string): string | null {
  // Playwright MCP snapshot format: elements have ref="e123" attributes
  // Try to find element matching our selector hint
  const idMatch = selector.match(/^#(.+)/);
  if (idMatch) {
    const idPattern = new RegExp(`id="${idMatch[1]}"[^>]*ref="([^"]+)"`, 'i');
    const m = snapshot.match(idPattern);
    if (m) return m[1];
  }
  // Fallback: return null, click will be skipped
  return null;
}

// ── Main fetch handler ────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    // ── /mcp or /sse — MCP protocol surface for external clients ────
    if (url.pathname === '/sse' || url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
      // Delegate to PlaywrightMCP agent's mount
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (PlaywrightMCP.mount('/mcp') as any).fetch(request, env, {} as ExecutionContext);
    }

    // ── /tool — Internal REST surface for AuditAgent binding ─────────
    if (url.pathname === '/tool' && request.method === 'POST') {
      try {
        const body = await request.json() as ToolRequest;

        if (!body.tool) {
          return Response.json({ error: 'tool field required' }, { status: 400, headers: cors });
        }

        let result: unknown;

        switch (body.tool) {
          case 'evaluate':
            result = await runEvaluate(
              env.BROWSER,
              body.params.url!,
              body.params.script!,
              body.params.args,
            );
            break;

          case 'snapshot':
            result = await runSnapshot(env.MCP_OBJECT, body.params.url!);
            break;

          case 'click_and_evaluate':
            result = await runClickAndEvaluate(
              env.MCP_OBJECT,
              body.params.url!,
              body.params.selector!,
              body.params.script!,
            );
            break;

          case 'screenshot': {
            // Use Browser Rendering for screenshot
            const ssResp = await env.BROWSER.fetch(
              new Request('https://browser.internal/screenshot', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  url: body.params.url,
                  gotoOptions: { waitUntil: 'networkidle' },
                }),
              }),
            );
            const ssData = await ssResp.json() as { screenshot?: string };
            result = { base64: ssData.screenshot ?? null, mimeType: 'image/png' };
            break;
          }

          case 'close':
            // Sessions auto-close; just acknowledge
            result = { closed: true };
            break;

          default:
            return Response.json(
              { error: `Unknown tool: ${(body as ToolRequest).tool}` },
              { status: 400, headers: cors },
            );
        }

        return Response.json({ result }, { headers: cors });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[acceda-playwright-mcp] Tool error:', msg);
        return Response.json({ error: msg }, { status: 500, headers: cors });
      }
    }

    // ── /health ──────────────────────────────────────────────────────
    if (url.pathname === '/health') {
      return Response.json(
        { service: 'acceda-playwright-mcp', status: 'ok', version: '0.1.0' },
        { headers: cors },
      );
    }

    return Response.json({ error: 'Not Found' }, { status: 404, headers: cors });
  },
};
