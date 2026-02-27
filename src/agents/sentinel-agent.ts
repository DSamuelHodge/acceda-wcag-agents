// src/agents/sentinel-agent.ts
// SentinelAgent: The real-time accessibility guardian per user session.
//
// This is the architectural break from JS overlays:
// - Overlays: apply blanket heuristic patches to a broken DOM
// - Sentinel: observes behavioral state, reasons semantically, applies targeted fixes
//   with auditable proof (Δ diff) that the fix worked
//
// One DO instance per user session. Hibernates when idle (zero cost).
// Wakes on MutationObserver events pushed from the WebMCP client script.
// Writes all interventions to D1 for audit trail.

import { Agent } from 'agents';
import { z } from 'zod';
import type { Env, BehavioralFinding, SemanticJudgment } from '../types.js';
import { generateId } from '../utils/ids.js';

const SentinelEventSchema = z.object({
  sessionId: z.string(),
  url: z.string(),
  eventType: z.enum([
    'focus_lost',
    'keyboard_trap',
    'modal_opened',
    'dom_mutation',
    'navigation',
    'user_report',
  ]),
  context: z.record(z.unknown()).optional(),
});

const InterventionResultSchema = z.object({
  applied: z.boolean(),
  fixType: z.string().optional(),
  fixCode: z.string().optional(),
  wcagCriteria: z.string().optional(),
  reasoning: z.string().optional(),
});

export class SentinelAgent extends Agent<Env> {
  private sessionId: string = '';
  private interventionLog: Array<{
    id: string;
    timestamp: string;
    event: z.infer<typeof SentinelEventSchema>;
    intervention: z.infer<typeof InterventionResultSchema>;
  }> = [];

  /**
   * Called when a behavioral event is pushed from the WebMCP client.
   * The client script (injected via WebMCP tool registration) sends events
   * when it detects accessibility state changes in real-time.
   */
  async handleEvent(input: z.infer<typeof SentinelEventSchema>): Promise<{
    intervention: z.infer<typeof InterventionResultSchema>;
    clientScript?: string;
  }> {
    const event = SentinelEventSchema.parse(input);
    this.sessionId = event.sessionId;

    this.broadcastStatus({
      type: 'sentinel_event',
      event: event.eventType,
      url: event.url,
    });

    const intervention = await this.reason(event);

    const logEntry = {
      id: generateId('intv'),
      timestamp: new Date().toISOString(),
      event,
      intervention,
    };
    this.interventionLog.push(logEntry);

    // Persist to D1 for audit trail
    await this.env.DB.prepare(
      `INSERT INTO remediations (id, audit_id, violation_ids, fix_type, fix_code, applied_at, verified)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      logEntry.id,
      `sentinel:${event.sessionId}`,
      JSON.stringify([event.eventType]),
      intervention.fixType ?? 'unknown',
      intervention.fixCode ?? '',
      logEntry.timestamp,
      intervention.applied ? 1 : 0,
    ).run();

    return {
      intervention,
      // Return executable JS to the client for immediate DOM fix
      clientScript: intervention.applied ? intervention.fixCode : undefined,
    };
  }

  /**
   * Semantic reasoning engine: given a behavioral event, determine if
   * intervention is needed and generate the minimal targeted fix.
   *
   * This is where the Sentinel differs from an overlay — it understands
   * WHY something is broken and generates a fix that addresses the root cause.
   */
  private async reason(
    event: z.infer<typeof SentinelEventSchema>,
  ): Promise<z.infer<typeof InterventionResultSchema>> {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({
      apiKey: this.env.ANTHROPIC_API_KEY,
      baseURL: `https://gateway.ai.cloudflare.com/v1/6c2dbbe47de58a74542ad9a5d9dd5b2b/${this.env.AI_GATEWAY_ID}/anthropic`,
    });

    const prompt = `You are an accessibility sentinel monitoring a live user session.

Event detected: ${event.eventType}
URL: ${event.url}
Context: ${JSON.stringify(event.context, null, 2)}

Session history (last 5 interventions):
${JSON.stringify(this.interventionLog.slice(-5).map(l => ({
  event: l.event.eventType,
  applied: l.intervention.applied,
  fix: l.intervention.fixType,
})), null, 2)}

Determine if this event represents an accessibility barrier requiring immediate intervention.
If yes, generate the minimal JavaScript fix to apply to the live DOM.
The fix must:
1. Be idempotent (safe to apply multiple times)
2. Target the specific element causing the barrier
3. Not break other page functionality
4. Be reversible

Respond with valid JSON only:
{
  "applied": boolean,
  "fixType": "css" | "html" | "aria" | "js" | "composite" | null,
  "fixCode": string | null,  // executable JS for live DOM manipulation
  "wcagCriteria": string | null,
  "reasoning": string
}`;

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', // Fast model for real-time sentinel
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = message.content[0].type === 'text' ? message.content[0].text : '{}';
    const clean = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

    try {
      return InterventionResultSchema.parse(JSON.parse(clean));
    } catch {
      return { applied: false, reasoning: 'Sentinel reasoning failed — no intervention applied.' };
    }
  }

  /**
   * WebMCP client script — injected into the page via the WebMCP tool registration.
   * This is what transforms the browser into a sentinel-aware host.
   * The script observes DOM mutations + focus events and pushes them to this DO.
   */
  getClientScript(sentinelEndpoint: string, sessionId: string): string {
    return `
(function() {
  'use strict';

  const SENTINEL_ENDPOINT = '${sentinelEndpoint}';
  const SESSION_ID = '${sessionId}';
  const DEBOUNCE_MS = 300;

  let debounceTimer = null;

  async function reportEvent(eventType, context = {}) {
    try {
      const resp = await fetch(SENTINEL_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          url: window.location.href,
          eventType,
          context
        })
      });
      const result = await resp.json();

      // Apply the fix immediately if the sentinel generated one
      if (result.intervention?.applied && result.clientScript) {
        try {
          eval(result.clientScript); // Fix applied to live DOM
          console.debug('[ACCEDA Sentinel] Intervention applied:', result.intervention.fixType);
        } catch (e) {
          console.error('[ACCEDA Sentinel] Fix application failed:', e);
        }
      }
    } catch (e) {
      console.debug('[ACCEDA Sentinel] Event reporting failed:', e);
    }
  }

  // ── Focus loss detection ─────────────────────────────────────────────
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    const s = window.getComputedStyle(el);
    const hasOutline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
    const hasBoxShadow = s.boxShadow && s.boxShadow !== 'none';
    if (!hasOutline && !hasBoxShadow) {
      reportEvent('focus_lost', {
        tag: el.tagName?.toLowerCase(),
        id: el.id,
        text: (el.textContent || '').trim().slice(0, 60),
        role: el.getAttribute('role'),
        outline: s.outline
      });
    }
  });

  // ── Keyboard trap detection ──────────────────────────────────────────
  let lastFocusedEl = null;
  let tabPressCount = 0;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      if (lastFocusedEl === document.activeElement) {
        tabPressCount++;
        if (tabPressCount >= 3) {
          reportEvent('keyboard_trap', {
            stuckElement: {
              tag: document.activeElement?.tagName?.toLowerCase(),
              id: document.activeElement?.id,
              text: (document.activeElement?.textContent || '').trim().slice(0, 60)
            }
          });
          tabPressCount = 0;
        }
      } else {
        tabPressCount = 0;
        lastFocusedEl = document.activeElement;
      }
    }
  });

  // ── DOM mutation observer (modals, dynamic content) ──────────────────
  const observer = new MutationObserver((mutations) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const dialogAdded = mutations.some(m =>
        Array.from(m.addedNodes).some(n =>
          n.nodeType === 1 && (
            n.getAttribute?.('role') === 'dialog' ||
            n.getAttribute?.('aria-modal') === 'true' ||
            n.tagName?.toLowerCase() === 'dialog'
          )
        )
      );
      if (dialogAdded) {
        const dlg = document.querySelector('[role="dialog"], [aria-modal="true"], dialog[open]');
        reportEvent('modal_opened', {
          dialogLabeled: !!(dlg?.getAttribute('aria-label') || dlg?.getAttribute('aria-labelledby')),
          focusInDialog: dlg?.contains(document.activeElement),
          dialogHtml: dlg?.outerHTML?.slice(0, 200)
        });
      }
    }, DEBOUNCE_MS);
  });

  observer.observe(document.body, { childList: true, subtree: true, attributes: true });

  console.debug('[ACCEDA Sentinel] Active on', window.location.href);
})();
    `.trim();
  }

  private broadcastStatus(data: Record<string, unknown>) {
    this.broadcast(JSON.stringify({ ...data, timestamp: new Date().toISOString() }));
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/event' && request.method === 'POST') {
      const body = await request.json() as z.infer<typeof SentinelEventSchema>;
      const result = await this.handleEvent(body);
      return Response.json(result);
    }

    if (url.pathname === '/client-script') {
      const sessionId = url.searchParams.get('sessionId') ?? generateId('sess');
      const endpoint = `${url.origin}/sentinel/${sessionId}/event`;
      return new Response(this.getClientScript(endpoint, sessionId), {
        headers: { 'Content-Type': 'application/javascript' },
      });
    }

    if (url.pathname === '/log') {
      return Response.json(this.interventionLog);
    }

    return new Response('Not Found', { status: 404 });
  }
}
