// src/tools/semantic-resolve.ts
// Phase 3: Claude-powered semantic resolution of the 43% incomplete/undetermined items.
// Routes through Cloudflare AI Gateway for observability, caching, and rate limiting.
// Key reframe: Claude reasons about ROOT CAUSES and MINIMAL INTERVENTIONS,
// not item-by-item classification.

import Anthropic from '@anthropic-ai/sdk';
import type {
  AxeViolation,
  BehavioralScanResult,
  SemanticAnalysis,
  WCAGLevel,
} from '../types.js';

const SYSTEM_PROMPT = `You are a WCAG 2.2 accessibility expert and assistive technology specialist with deep knowledge of ARIA, screen reader behavior (NVDA, JAWS, VoiceOver), and keyboard navigation patterns.

You receive:
1. axe-core CONFIRMED violations (57% the tool can auto-determine)
2. axe-core INCOMPLETE items (the 43% requiring semantic judgment)
3. Behavioral findings from Playwright keyboard simulation

Your tasks:
(1) CONFIRM or DISMISS each incomplete item with precise reasoning and WCAG 2.2 SC citation.
(2) Identify ROOT CAUSES — multiple violations likely share a single origin (missing CSS rule, wrong ARIA pattern). Name the root cause, not just the symptom.
(3) Generate a PRIORITIZED FIX LIST ordered by: (a) user impact severity, (b) number of violations resolved per fix. Prefer the single fix that resolves the most violations.
(4) For each top fix, provide concrete, production-ready remediation code (HTML/CSS/ARIA).

Output ONLY valid JSON matching this exact schema:
{
  "judgments": [
    {
      "axeRuleId": string,
      "judgment": "confirmed" | "dismissed",
      "wcagCriteria": string,  // e.g. "1.4.3, 2.4.7"
      "reasoning": string,
      "remediationHtml": string | null,
      "remediationCss": string | null,
      "remediationAria": string | null
    }
  ],
  "prioritizedFixes": [
    {
      "rank": number,
      "violationIds": string[],
      "impactSummary": string,
      "fixType": "css" | "html" | "aria" | "js" | "composite",
      "fixCode": string,
      "affectedUserGroups": string[]
    }
  ],
  "rootCauseSummary": string
}`;

function buildPrompt(
  url: string,
  pageTitle: string,
  wcagLevel: WCAGLevel,
  confirmed: AxeViolation[],
  undetermined: AxeViolation[],
  behavioral: BehavioralScanResult,
): string {
  const trimNode = (nodes: AxeViolation['nodes'], n = 3) =>
    nodes.slice(0, n).map(nd => ({
      html: nd.html?.slice(0, 200),
      issue: nd.failureSummary,
      target: nd.target?.[0],
    }));

  const confirmedSummary = confirmed.map(v => ({
    id: v.id,
    impact: v.impact,
    description: v.description,
    wcag: v.tags.filter(t => t.includes('wcag')),
    nodes: trimNode(v.nodes),
  }));

  const undeterminedSummary = undetermined.map(v => ({
    id: v.id,
    description: v.description,
    wcag: v.tags.filter(t => t.includes('wcag')),
    nodes: trimNode(v.nodes),
  }));

  // Aggregate behavioral for root cause analysis
  const behavioralAgg = {
    total_findings: behavioral.findings.length,
    focus_not_visible_count: behavioral.findings.filter(f => f.type === 'focus_not_visible').length,
    focus_order_issues: behavioral.findings.filter(f => f.type === 'focus_order_mismatch').length,
    modal_issues: behavioral.findings.filter(f => f.type.startsWith('modal')).length,
    findings: behavioral.findings,
  };

  return `## Accessibility Audit — ${pageTitle}
URL: ${url}
WCAG Level: ${wcagLevel.toUpperCase()}

### CONFIRMED VIOLATIONS (${confirmed.length}) — axe-core certain
${JSON.stringify(confirmedSummary, null, 2)}

### NEEDS SEMANTIC JUDGMENT (${undetermined.length}) — the 43% axe cannot auto-determine
${JSON.stringify(undeterminedSummary, null, 2)}

### BEHAVIORAL FINDINGS (${behavioral.findings.length}) — Playwright keyboard simulation
${JSON.stringify(behavioralAgg, null, 2)}

---
Analyze the above. Identify root causes. Confirm or dismiss each incomplete item.
Generate the minimal set of fixes that maximally reduces user impact.
Respond with valid JSON only.`;
}

/**
 * Call Claude via Cloudflare AI Gateway for observability + caching.
 * The gateway URL pattern: https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/anthropic
 */
export async function resolveSemantics(
  apiKey: string,
  accountId: string,
  gatewayId: string,
  params: {
    url: string;
    pageTitle: string;
    wcagLevel: WCAGLevel;
    confirmed: AxeViolation[];
    undetermined: AxeViolation[];
    behavioral: BehavioralScanResult;
    model?: string;
  },
): Promise<SemanticAnalysis> {
  const client = new Anthropic({
    apiKey,
    baseURL: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/anthropic`,
  });

  const prompt = buildPrompt(
    params.url,
    params.pageTitle,
    params.wcagLevel,
    params.confirmed,
    params.undetermined,
    params.behavioral,
  );

  const message = await client.messages.create({
    model: params.model ?? 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = message.content[0].type === 'text' ? message.content[0].text : '';

  // Strip markdown fences if present
  const clean = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  try {
    const parsed = JSON.parse(clean) as SemanticAnalysis;
    return parsed;
  } catch {
    // Graceful degradation: return empty analysis with error note
    return {
      judgments: [],
      prioritizedFixes: [],
      rootCauseSummary: `Semantic analysis unavailable — JSON parse failed. Raw response: ${raw.slice(0, 500)}`,
    };
  }
}
