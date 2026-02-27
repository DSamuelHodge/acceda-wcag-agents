// src/agents/audit-agent.ts
// AuditAgent: Cloudflare Durable Object (via @cloudflare/agents) that owns
// the full WCAG audit lifecycle for a single URL.
//
// State machine:
//   pending → scanning (Phase 0+1+2) → analyzing (Phase 3) → complete | failed
//
// This agent persists across the async phases, holds browser session state via
// Playwright MCP, and writes final results to D1 + R2.
//
// Each audit gets its own DO instance — namespaced by audit ID.
// Multiple concurrent audits never share state.

import { Agent } from 'agents';
import { z } from 'zod';
import type {
  AuditConfig,
  AuditResult,
  AuditStatus,
  AxeResult,
  BehavioralFinding,
  BehavioralScanResult,
  Env,
  TabOrderElement,
} from '../types.js';
import { buildAxeScript, partitionAxeResults } from '../tools/static-scan.js';
import {
  FOCUS_VISIBILITY_SCRIPT,
  MODAL_STATE_SCRIPT,
  MODAL_TRIGGERS_SCRIPT,
  SKIP_LINK_SCRIPT,
  TAB_ORDER_SCRIPT,
  assembleBehavioralResult,
} from '../tools/behavioral-scan.js';
import { resolveSemantics } from '../tools/semantic-resolve.js';
import {
  A11Y_TREE_CAPTURE_SCRIPT,
  buildAuditDiff,
  hashA11yTree,
  storeSnapshot,
} from '../tools/snapshot.js';
import { generateId } from '../utils/ids.js';
import { persistSession, persistViolations, persistBehavioralFindings, persistJudgments, persistSnapshot, persistDiff } from '../db/persist.js';

// ── Input Schemas ─────────────────────────────────────────────────────────

const StartAuditSchema = z.object({
  auditId: z.string(),
  config: z.object({
    url: z.string().url(),
    mode: z.enum(['ci', 'webmcp', 'sentinel']),
    wcagLevel: z.enum(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).default('wcag2aa'),
    maxElements: z.number().int().min(1).max(100).default(30),
    triggeredBy: z.string().optional(),
  }),
});

const VerifyRemediationSchema = z.object({
  auditId: z.string(),
  url: z.string().url(),
});

// ── Agent ─────────────────────────────────────────────────────────────────

export class AuditAgent extends Agent<Env> {
  // Agent internal state (persisted in DO SQL via @cloudflare/agents)
  private auditId: string = '';
  private status: AuditStatus = 'pending';
  private config: AuditConfig | null = null;
  private result: Partial<AuditResult> = {};

  // ── Tool Definitions (exposed via MCP tool protocol) ─────────────────────

  async runAudit(input: z.infer<typeof StartAuditSchema>): Promise<AuditResult> {
    const { auditId, config } = StartAuditSchema.parse(input);
    this.auditId = auditId;
    this.config = config;
    this.status = 'scanning';

    await this.updateStatus('scanning');
    this.broadcastStatus({ phase: 'scanning', message: `Starting audit for ${config.url}` });

    // ── Phase 0: Baseline Snapshot ────────────────────────────────────────
    this.broadcastStatus({ phase: 'snapshot', message: 'Capturing baseline a11y tree...' });
    const { tree: baselineTree, pageTitle } = await this.captureA11yTree(config.url);
    const baselineHash = await hashA11yTree(baselineTree);
    const { treeKey: baselineKey, screenshotKey: baselineScreenshot } = await storeSnapshot(
      this.env.SNAPSHOTS,
      auditId,
      'baseline',
      baselineTree,
    );

    const snapshotId = generateId('snap');
    await persistSnapshot(this.env.DB, {
      id: snapshotId,
      auditId,
      phase: 'baseline',
      r2Key: baselineKey,
      a11yTreeHash: baselineHash,
      screenshotR2Key: baselineScreenshot,
    });

    // ── Phase 1: Static axe-core Scan (57%) ──────────────────────────────
    this.broadcastStatus({ phase: 'static', message: 'Running axe-core static scan...' });
    const axeResult = await this.runAxeScan(config.url, config.wcagLevel);
    const { confirmed, undetermined } = partitionAxeResults(axeResult);

    await persistViolations(this.env.DB, auditId, confirmed, 'axe', 'static');

    this.broadcastStatus({
      phase: 'static',
      message: `axe: ${confirmed.length} confirmed, ${undetermined.length} undetermined`,
    });

    // ── Phase 2: Behavioral Scan (43%) ────────────────────────────────────
    this.broadcastStatus({ phase: 'behavioral', message: 'Running behavioral keyboard simulation...' });
    const behavioral = await this.runBehavioralScan(config.url, config.maxElements);

    await persistBehavioralFindings(this.env.DB, auditId, behavioral.findings);

    this.broadcastStatus({
      phase: 'behavioral',
      message: `Behavioral: ${behavioral.findings.length} findings across ${behavioral.tabOrder.length} elements`,
    });

    // ── Phase 3: Semantic Resolution ──────────────────────────────────────
    this.status = 'analyzing';
    await this.updateStatus('analyzing');
    this.broadcastStatus({ phase: 'semantic', message: 'Claude resolving the 43% undetermined...' });

    const semantic = await resolveSemantics(
      this.env.ANTHROPIC_API_KEY,
      '6c2dbbe47de58a74542ad9a5d9dd5b2b',
      this.env.AI_GATEWAY_ID,
      {
        url: config.url,
        pageTitle,
        wcagLevel: config.wcagLevel,
        confirmed,
        undetermined,
        behavioral,
      },
    );

    await persistJudgments(this.env.DB, auditId, semantic.judgments);

    this.result = {
      session: {
        id: auditId,
        config,
        status: 'complete',
        createdAt: new Date().toISOString(),
      },
      snapshot: {
        id: snapshotId,
        auditId,
        phase: 'baseline',
        r2Key: baselineKey,
        a11yTreeHash: baselineHash,
        screenshotR2Key: baselineScreenshot,
        capturedAt: new Date().toISOString(),
      },
      axe: axeResult,
      behavioral,
      semantic,
    };

    this.status = 'complete';
    await this.updateStatus('complete');
    this.broadcastStatus({ phase: 'complete', message: 'Audit complete.' });

    // Close browser session — frees Browser Rendering resources
    await this.closeBrowserSession(config.url);

    return this.result as AuditResult;
  }

  /**
   * Phase 4: Verify remediation by capturing S1 and diffing against S0.
   * Called after developer applies fixes.
   */
  async verifyRemediation(input: z.infer<typeof VerifyRemediationSchema>): Promise<AuditDiff> {
    const { auditId, url } = VerifyRemediationSchema.parse(input);

    this.broadcastStatus({ phase: 'verification', message: 'Capturing post-remediation snapshot...' });

    // Capture S1
    const { tree: postTree } = await this.captureA11yTree(url);
    const postHash = await hashA11yTree(postTree);
    const { treeKey: postKey } = await storeSnapshot(this.env.SNAPSHOTS, auditId, 'post_remediation', postTree);

    const postSnapshotId = generateId('snap');
    await persistSnapshot(this.env.DB, {
      id: postSnapshotId,
      auditId,
      phase: 'post_remediation',
      r2Key: postKey,
      a11yTreeHash: postHash,
    });

    // Re-run axe for violation count
    const postAxe = await this.runAxeScan(url, this.config!.wcagLevel);
    const postBehavioral = await this.runBehavioralScan(url, this.config!.maxElements);

    // Load S0 for diff (from stored result)
    const baselineSnapshot = this.result.snapshot!;
    const baselineAxeCount = this.result.axe!.violations.length;
    const baselineBehavCount = this.result.behavioral!.findings.length;

    // Fetch both trees from R2 for structural diff
    const s0Obj = await this.env.SNAPSHOTS.get(baselineSnapshot.r2Key);
    const s0Tree = s0Obj ? await s0Obj.json<Record<string, unknown>>() : {};
    const s1Tree = postTree as Record<string, unknown>;

    const diff = buildAuditDiff({
      auditId,
      snapshotBeforeId: baselineSnapshot.id,
      snapshotAfterId: postSnapshotId,
      treesBefore: s0Tree,
      treesAfter: s1Tree,
      violationsBefore: baselineAxeCount,
      violationsAfter: postAxe.violations.length,
      behavioralBefore: baselineBehavCount,
      behavioralAfter: postBehavioral.findings.length,
    });

    const diffId = generateId('diff');
    await persistDiff(this.env.DB, { id: diffId, ...diff });

    this.broadcastStatus({
      phase: 'verification',
      message: `Δ violations: ${diff.deltaViolations} (${diff.verified ? 'IMPROVED ✓' : 'NOT RESOLVED ✗'})`,
    });

    return { id: diffId, ...diff };
  }

  // ── Private: Browser Interaction via Playwright MCP ─────────────────────

  private async captureA11yTree(url: string): Promise<{ tree: unknown; pageTitle: string }> {
    // In production: delegate to @cloudflare/playwright-mcp Worker binding
    // The binding executes page.evaluate(A11Y_TREE_CAPTURE_SCRIPT) in a Container
    // For now: return mock structure — replace with actual MCP call
    const response = await this.callPlaywrightMCP('evaluate', {
      url,
      script: A11Y_TREE_CAPTURE_SCRIPT,
    });
    return {
      tree: response.result,
      pageTitle: (response.result as { title?: string }).title ?? url,
    };
  }

  private async runAxeScan(url: string, wcagLevel: string): Promise<AxeResult> {
    const script = buildAxeScript(wcagLevel as 'wcag2a' | 'wcag2aa' | 'wcag21aa' | 'wcag22aa');
    const response = await this.callPlaywrightMCP('evaluate', { url, script });
    return response.result as AxeResult;
  }

  private async runBehavioralScan(url: string, maxElements: number): Promise<BehavioralScanResult> {
    // Execute behavioral scripts sequentially via Playwright MCP
    const [tabOrderRaw, focusFailuresRaw, skipLinkRaw, triggersRaw] = await Promise.all([
      this.callPlaywrightMCP('evaluate', {
        url,
        script: TAB_ORDER_SCRIPT,
        args: [maxElements],
      }),
      this.callPlaywrightMCP('evaluate', {
        url,
        script: FOCUS_VISIBILITY_SCRIPT,
        args: [maxElements],
      }),
      this.callPlaywrightMCP('evaluate', { url, script: SKIP_LINK_SCRIPT }),
      this.callPlaywrightMCP('evaluate', { url, script: MODAL_TRIGGERS_SCRIPT }),
    ]);

    const tabOrder = tabOrderRaw.result as TabOrderElement[];
    const focusFailures = focusFailuresRaw.result as Array<{
      tag: string; text: string; id: string | null; outline: string; role: string | null;
    }>;
    const skipLinkResult = skipLinkRaw.result as { present: boolean; count: number };
    const triggers = triggersRaw.result as Array<{ text: string; id: string | null; tag: string }>;

    // Modal focus trap testing — sequential, each trigger opens/closes
    const modalFindings: BehavioralFinding[] = [];
    for (const trigger of triggers) {
      const stateResp = await this.callPlaywrightMCP('click_and_evaluate', {
        url,
        selector: trigger.id ? `#${trigger.id}` : trigger.tag,
        script: MODAL_STATE_SCRIPT,
      });
      const state = stateResp.result as {
        dialogExists: boolean;
        focusInDialog: boolean;
        dialogLabeled: boolean | null;
      };

      if (state.dialogExists) {
        if (!state.focusInDialog) {
          modalFindings.push({
            type: 'modal_focus_not_trapped',
            severity: 'critical',
            issue: `Modal from "${trigger.text}" opened but focus stayed outside (WCAG 2.4.3)`,
            elementTag: trigger.tag,
            elementText: trigger.text,
            elementId: trigger.id ?? undefined,
          });
        }
        if (state.dialogLabeled === false) {
          modalFindings.push({
            type: 'modal_missing_label',
            severity: 'serious',
            issue: `Modal from "${trigger.text}" has no aria-label/labelledby (WCAG 4.1.2)`,
            elementTag: trigger.tag,
            elementText: trigger.text,
          });
        }
      }
    }

    return assembleBehavioralResult(tabOrder, focusFailures, skipLinkResult, modalFindings);
  }

  /**
   * Calls acceda-playwright-mcp Worker via Service binding.
   * POST /tool  →  { tool, params }  →  { result }
   *
   * The Worker runs @cloudflare/playwright-mcp backed by Browser Rendering.
   * Each unique URL gets its own Durable Object session — context isolation
   * means concurrent audits never share browser state.
   */
  private async callPlaywrightMCP(
    tool: string,
    params: Record<string, unknown>,
  ): Promise<{ result: unknown }> {
    const response = await this.env.PLAYWRIGHT_MCP.fetch(
      new Request('https://acceda-playwright-mcp.internal/tool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool, params }),
      }),
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Playwright MCP [${tool}] failed ${response.status}: ${body}`);
    }

    return response.json() as Promise<{ result: unknown }>;
  }

  /**
   * Explicitly close the browser session for this URL after audit completes.
   * Keeps Browser Rendering resource usage clean — DO hibernates after close.
   */
  private async closeBrowserSession(url: string): Promise<void> {
    try {
      await this.callPlaywrightMCP('close', { url });
    } catch {
      // Non-fatal — session will GC eventually
    }
  }

  // ── WebSocket: Real-time progress streaming ───────────────────────────

  private broadcastStatus(event: { phase: string; message: string }) {
    // Broadcast to all connected WebSocket clients
    // @cloudflare/agents handles the WS connection management
    this.broadcast(JSON.stringify({
      type: 'audit_progress',
      auditId: this.auditId,
      ...event,
      timestamp: new Date().toISOString(),
    }));
  }

  private async updateStatus(status: AuditStatus) {
    this.status = status;
    await this.env.AUDIT_KV.put(
      `status:${this.auditId}`,
      JSON.stringify({ status, updatedAt: new Date().toISOString() }),
      { expirationTtl: 86400 },
    );
  }

  // ── HTTP Handler ──────────────────────────────────────────────────────

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/audit' && request.method === 'POST') {
      const body = await request.json() as z.infer<typeof StartAuditSchema>;
      const result = await this.runAudit(body);
      return Response.json(result);
    }

    if (url.pathname === '/verify' && request.method === 'POST') {
      const body = await request.json() as z.infer<typeof VerifyRemediationSchema>;
      const diff = await this.verifyRemediation(body);
      return Response.json(diff);
    }

    if (url.pathname === '/status') {
      return Response.json({ auditId: this.auditId, status: this.status });
    }

    return new Response('Not Found', { status: 404 });
  }
}

// Re-export type for wrangler binding resolution
import type { AuditDiff } from '../types.js';
