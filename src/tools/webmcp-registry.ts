// src/tools/webmcp-registry.ts
// WebMCP Tool Descriptors — the JSON Schema contracts that allow
// navigator.modelContext.registerTool() / invokeTool() to call ACCEDA
// from within a browser-native agentic context.
//
// These descriptors define the public surface of ACCEDA as a WebMCP host.
// The browser agent (Claude, Gemini, Copilot) calls these tools; ACCEDA
// routes them to the appropriate Cloudflare Agent DO.

export const ACCEDA_WEBMCP_TOOLS = [
  {
    name: 'acceda_audit',
    description: [
      'Run a full WCAG 2.2 AA accessibility audit on a URL.',
      'Three-phase pipeline: (1) axe-core static analysis — the 57% auto-determinable,',
      '(2) Playwright behavioral keyboard simulation — focus order, visibility, modal traps,',
      '(3) Claude semantic reasoning — resolves the 43% incomplete/undetermined items.',
      'Returns confirmed violations, behavioral findings, semantic judgments, and prioritized remediations.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Fully-qualified URL to audit (must be publicly accessible)',
        },
        wcag_level: {
          type: 'string',
          enum: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'],
          default: 'wcag2aa',
          description: 'WCAG conformance level to test against',
        },
        max_elements: {
          type: 'integer',
          default: 30,
          minimum: 1,
          maximum: 100,
          description: 'Maximum interactive elements to include in behavioral scan',
        },
        mode: {
          type: 'string',
          enum: ['ci', 'webmcp', 'sentinel'],
          default: 'webmcp',
          description: 'Execution mode: ci (CI/CD pipeline), webmcp (browser-native), sentinel (real-time)',
        },
      },
      required: ['url'],
    },
  },

  {
    name: 'acceda_verify',
    description: [
      'Verify that a previously identified accessibility violation has been fixed.',
      'Captures a new accessibility tree snapshot (S1), diffs against the baseline (S0),',
      'and returns Δ evidence confirming whether the remediation reduced violations.',
      'Provides auditable proof that fixes worked — not just that code changed.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        audit_id: {
          type: 'string',
          description: 'The audit ID returned by acceda_audit',
        },
        url: {
          type: 'string',
          description: 'URL to re-scan (may differ from original if deployed to staging)',
        },
      },
      required: ['audit_id', 'url'],
    },
  },

  {
    name: 'acceda_sentinel_inject',
    description: [
      'Inject the ACCEDA Sentinel into the current page for real-time accessibility monitoring.',
      'The Sentinel observes DOM mutations, focus events, and keyboard navigation.',
      'When it detects a barrier, it reasons semantically and applies a targeted live fix.',
      'Unlike JS overlays, every intervention is logged with auditable Δ evidence.',
      'Call this once per session to activate continuous accessibility monitoring.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Unique identifier for this user session (for audit trail)',
        },
        url: {
          type: 'string',
          description: 'Current page URL',
        },
      },
      required: ['url'],
    },
  },

  {
    name: 'acceda_get_report',
    description: 'Retrieve the full audit report for a completed audit session.',
    inputSchema: {
      type: 'object',
      properties: {
        audit_id: {
          type: 'string',
          description: 'The audit ID to retrieve',
        },
      },
      required: ['audit_id'],
    },
  },
];

/**
 * Client-side registration snippet for WebMCP-enabled browsers.
 * Paste this into a <script> tag or inject via extension.
 *
 * Usage:
 *   registerACCEDATools('https://acceda-agents.your-subdomain.workers.dev');
 */
export function buildWebMCPRegistrationScript(workerEndpoint: string): string {
  return `
(async function registerACCEDATools(endpoint) {
  if (typeof navigator.modelContext === 'undefined') {
    console.warn('[ACCEDA] WebMCP not available in this browser. Use Chrome with AI Overviews or Edge Copilot.');
    return;
  }

  const tools = ${JSON.stringify(ACCEDA_WEBMCP_TOOLS, null, 2)};

  for (const tool of tools) {
    await navigator.modelContext.registerTool(tool.name, {
      description: tool.description,
      inputSchema: tool.inputSchema,
      invoke: async (args) => {
        const response = await fetch(endpoint + '/webmcp/' + tool.name, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args)
        });
        return response.json();
      }
    });
    console.debug('[ACCEDA] Registered WebMCP tool:', tool.name);
  }

  console.info('[ACCEDA] ' + tools.length + ' WebMCP tools registered at', endpoint);
})('${workerEndpoint}');
  `.trim();
}
