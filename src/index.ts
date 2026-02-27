// src/index.ts
// ACCEDA Worker — main entry point.
// Routes across three modes: CI/CD webhook, WebMCP tool calls, Sentinel events.
// All heavy lifting delegated to AuditAgent DO or SentinelAgent DO.

import type { Env } from './types.js';
import { generateId, generateAuditId } from './utils/ids.js';
import { getAuditSummary } from './db/persist.js';
import { ACCEDA_WEBMCP_TOOLS, buildWebMCPRegistrationScript } from './tools/webmcp-registry.js';

export { AuditAgent } from './agents/audit-agent.js';
export { SentinelAgent } from './agents/sentinel-agent.js';
export { AuditWorkflow, RemediationWorkflow } from './workflows/audit-workflow.js';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // ── CORS ──────────────────────────────────────────────────────────────
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-GitHub-Event, X-Hub-Signature-256',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const json = (data: unknown, status = 200) =>
      Response.json(data, { status, headers: corsHeaders });

    try {
      // ── Health ────────────────────────────────────────────────────────
      if (pathname === '/') {
        return json({ service: 'ACCEDA Agents', version: '0.1.0', status: 'ok' });
      }

      // ── CI/CD: GitHub Webhook ─────────────────────────────────────────
      if (pathname === '/webhook/github' && request.method === 'POST') {
        return handleGitHubWebhook(request, env, ctx, json);
      }

      // ── WebMCP: Tool invocation endpoints ─────────────────────────────
      if (pathname.startsWith('/webmcp/')) {
        return handleWebMCP(request, env, pathname, json);
      }

      // ── Sentinel: Event receiver ──────────────────────────────────────
      if (pathname.startsWith('/sentinel/')) {
        return handleSentinel(request, env, pathname, json);
      }

      // ── Direct Audit API ──────────────────────────────────────────────
      if (pathname === '/api/audit' && request.method === 'POST') {
        const body = await request.json() as {
          url: string;
          mode?: string;
          wcagLevel?: string;
          maxElements?: number;
        };

        const auditId = generateAuditId(body.url);
        const workflowId = generateId('wf');

        await env.AUDIT_WORKFLOW.create({
          id: workflowId,
          params: {
            url: body.url,
            mode: (body.mode as 'ci' | 'webmcp' | 'sentinel') ?? 'webmcp',
            wcagLevel: body.wcagLevel ?? 'wcag2aa',
            maxElements: body.maxElements ?? 30,
            triggeredBy: 'api',
          },
        });

        return json({ auditId, workflowId, status: 'started' });
      }

      // ── Report retrieval ──────────────────────────────────────────────
      if (pathname.startsWith('/api/audit/') && request.method === 'GET') {
        const auditId = pathname.split('/')[3];
        const summary = await getAuditSummary(env.DB, auditId);
        return json(summary);
      }

      // ── WebMCP Tool Registry (public) ─────────────────────────────────
      if (pathname === '/webmcp/tools') {
        return json(ACCEDA_WEBMCP_TOOLS);
      }

      // ── WebMCP Client Registration Script ─────────────────────────────
      if (pathname === '/webmcp/register.js') {
        const script = buildWebMCPRegistrationScript(`https://${request.headers.get('host')}`);
        return new Response(script, {
          headers: { 'Content-Type': 'application/javascript', ...corsHeaders },
        });
      }

      return json({ error: 'Not Found' }, 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('[ACCEDA] Unhandled error:', message);
      return json({ error: message }, 500);
    }
  },
};

// ── GitHub Webhook Handler ────────────────────────────────────────────────

async function handleGitHubWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  json: (data: unknown, status?: number) => Response,
): Promise<Response> {
  const event = request.headers.get('X-GitHub-Event');

  // Only process pull_request events
  if (event !== 'pull_request') {
    return json({ skipped: true, reason: `Event ${event} not handled` });
  }

  const payload = await request.json() as {
    action: string;
    pull_request: {
      head: { sha: string };
      number: number;
      html_url: string;
    };
    repository: { full_name: string };
  };

  // Trigger on opened, synchronize, or reopened
  if (!['opened', 'synchronize', 'reopened'].includes(payload.action)) {
    return json({ skipped: true, reason: `Action ${payload.action} not handled` });
  }

  const pr = payload.pull_request;
  const repo = payload.repository.full_name;

  // Extract deployment URL from PR (assumes preview URL in PR description or env)
  // In real usage: parse from deployment webhook or PR body
  const auditUrl = pr.html_url; // Replace with actual preview URL

  const workflowId = generateId('ci');
  ctx.waitUntil(
    env.AUDIT_WORKFLOW.create({
      id: workflowId,
      params: {
        url: auditUrl,
        mode: 'ci',
        wcagLevel: 'wcag2aa',
        triggeredBy: `github:${pr.head.sha}`,
        githubPR: {
          repo,
          prNumber: pr.number,
          sha: pr.head.sha,
          commentUrl: `https://api.github.com/repos/${repo}/issues/${pr.number}/comments`,
        },
      },
    }),
  );

  return json({ received: true, workflowId });
}

// ── WebMCP Tool Router ────────────────────────────────────────────────────

async function handleWebMCP(
  request: Request,
  env: Env,
  pathname: string,
  json: (data: unknown, status?: number) => Response,
): Promise<Response> {
  const toolName = pathname.replace('/webmcp/', '');
  const body = request.method === 'POST' ? await request.json() as Record<string, unknown> : {};

  switch (toolName) {
    case 'acceda_audit': {
      const url = body.url as string;
      const auditId = generateAuditId(url);
      const workflowId = generateId('wf');

      await env.AUDIT_WORKFLOW.create({
        id: workflowId,
        params: {
          url,
          mode: 'webmcp',
          wcagLevel: (body.wcag_level as string) ?? 'wcag2aa',
          maxElements: (body.max_elements as number) ?? 30,
          triggeredBy: 'webmcp',
        },
      });

      return json({ auditId, workflowId, status: 'started', message: `Audit started for ${url}` });
    }

    case 'acceda_verify': {
      const workflowId = generateId('verify');
      await env.REMEDIATION_WORKFLOW.create({
        id: workflowId,
        params: {
          auditId: body.audit_id as string,
          url: body.url as string,
          mode: 'webmcp',
        },
      });
      return json({ workflowId, status: 'started' });
    }

    case 'acceda_sentinel_inject': {
      const sessionId = (body.session_id as string) ?? generateId('sess');
      const sentinelId = env.SENTINEL_AGENT.idFromName(sessionId);
      const sentinel = env.SENTINEL_AGENT.get(sentinelId);
      const scriptResp = await sentinel.fetch(
        new Request(`https://sentinel.internal/client-script?sessionId=${sessionId}`),
      );
      const script = await scriptResp.text();
      return json({ sessionId, clientScript: script, status: 'ready' });
    }

    case 'acceda_get_report': {
      const summary = await getAuditSummary(env.DB, body.audit_id as string);
      return json(summary);
    }

    case 'tools':
      return json(ACCEDA_WEBMCP_TOOLS);

    default:
      return json({ error: `Unknown WebMCP tool: ${toolName}` }, 404);
  }
}

// ── Sentinel Event Router ─────────────────────────────────────────────────

async function handleSentinel(
  request: Request,
  env: Env,
  pathname: string,
  json: (data: unknown, status?: number) => Response,
): Promise<Response> {
  // /sentinel/{sessionId}/event
  const parts = pathname.split('/');
  const sessionId = parts[2];
  const action = parts[3];

  if (!sessionId) return json({ error: 'Session ID required' }, 400);

  const sentinelId = env.SENTINEL_AGENT.idFromName(sessionId);
  const sentinel = env.SENTINEL_AGENT.get(sentinelId);

  const agentRequest = new Request(`https://sentinel.internal/${action}`, {
    method: request.method,
    headers: request.headers,
    body: request.method !== 'GET' ? request.body : undefined,
  });

  return sentinel.fetch(agentRequest);
}
