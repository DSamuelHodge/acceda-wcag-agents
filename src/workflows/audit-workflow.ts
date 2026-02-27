// src/workflows/audit-workflow.ts
// Cloudflare Workflow for durable, retryable audit execution.
// Workflows survive process restarts — each step is checkpointed.
// The AuditAgent handles state; the Workflow handles durability + retries.
//
// This is the CI/CD mode entry point: triggered by GitHub Actions webhook,
// runs the full 4-phase pipeline, and posts results back to the PR.

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import type { Env } from '../types.js';
import { generateId } from '../utils/ids.js';

interface AuditWorkflowPayload {
  url: string;
  mode: 'ci' | 'webmcp' | 'sentinel';
  wcagLevel?: string;
  maxElements?: number;
  triggeredBy?: string;
  githubPR?: {
    repo: string;
    prNumber: number;
    sha: string;
    commentUrl: string;
  };
}

export class AuditWorkflow extends WorkflowEntrypoint<Env, AuditWorkflowPayload> {
  async run(event: WorkflowEvent<AuditWorkflowPayload>, step: WorkflowStep) {
    const { url, mode, wcagLevel = 'wcag2aa', maxElements = 30, triggeredBy, githubPR } = event.payload;

    // ── Step 1: Initialize audit session in D1 ──────────────────────────
    const auditId = await step.do('initialize-session', async () => {
      const id = generateId('audit');
      await this.env.DB.prepare(
        `INSERT INTO audit_sessions (id, url, mode, wcag_level, status, triggered_by)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      ).bind(id, url, mode, wcagLevel, triggeredBy ?? null).run();
      return id;
    });

    // ── Step 2: Route to AuditAgent DO ──────────────────────────────────
    const result = await step.do('run-audit-agent', { retries: { limit: 2, delay: '5 seconds' } }, async () => {
      const agentId = this.env.AUDIT_AGENT.idFromName(auditId);
      const agent = this.env.AUDIT_AGENT.get(agentId);

      const response = await agent.fetch(new Request('https://agent.internal/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auditId,
          config: { url, mode, wcagLevel, maxElements, triggeredBy },
        }),
      }));

      if (!response.ok) {
        throw new Error(`AuditAgent failed: ${response.status} ${await response.text()}`);
      }

      return response.json();
    });

    // ── Step 3: Update D1 session to complete ───────────────────────────
    await step.do('finalize-session', async () => {
      await this.env.DB.prepare(
        `UPDATE audit_sessions SET status = 'complete', completed_at = datetime('now') WHERE id = ?`,
      ).bind(auditId).run();
    });

    // ── Step 4 (CI mode): Post results to GitHub PR ─────────────────────
    if (mode === 'ci' && githubPR) {
      await step.do('post-github-comment', { retries: { limit: 3, delay: '2 seconds' } }, async () => {
        const comment = buildGitHubComment(auditId, url, result);
        await postGitHubComment(this.env.GITHUB_TOKEN, githubPR, comment);
      });

      // Step 5: Gate the PR if critical violations found
      await step.do('set-commit-status', async () => {
        const criticalCount = (result.axe?.violations ?? []).filter(
          (v: { impact: string }) => v.impact === 'critical',
        ).length;
        const sentinelCount = result.semantic?.judgments?.filter(
          (j: { judgment: string }) => j.judgment === 'confirmed',
        ).length ?? 0;

        const state = criticalCount > 0 ? 'failure' : 'success';
        const description = criticalCount > 0
          ? `ACCEDA: ${criticalCount} critical violations — PR blocked`
          : `ACCEDA: ${sentinelCount} semantic issues confirmed — PR approved`;

        await postCommitStatus(this.env.GITHUB_TOKEN, githubPR, state, description, auditId);
      });
    }

    return { auditId, status: 'complete', url };
  }
}

// ── Remediation Verification Workflow ─────────────────────────────────────

interface RemediationWorkflowPayload {
  auditId: string;
  url: string;
  mode: 'ci' | 'webmcp' | 'sentinel';
  githubPR?: {
    repo: string;
    prNumber: number;
    sha: string;
  };
}

export class RemediationWorkflow extends WorkflowEntrypoint<Env, RemediationWorkflowPayload> {
  async run(event: WorkflowEvent<RemediationWorkflowPayload>, step: WorkflowStep) {
    const { auditId, url, mode, githubPR } = event.payload;

    const diff = await step.do('verify-remediation', { retries: { limit: 2, delay: '5 seconds' } }, async () => {
      const agentId = this.env.AUDIT_AGENT.idFromName(auditId);
      const agent = this.env.AUDIT_AGENT.get(agentId);

      const response = await agent.fetch(new Request('https://agent.internal/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auditId, url }),
      }));

      if (!response.ok) throw new Error(`Verification failed: ${response.status}`);
      return response.json();
    });

    if (mode === 'ci' && githubPR) {
      await step.do('post-verification-comment', async () => {
        const comment = buildVerificationComment(diff);
        await postGitHubComment(this.env.GITHUB_TOKEN, githubPR, comment);
      });
    }

    return { auditId, diff, verified: diff.verified };
  }
}

// ── GitHub Integration Helpers ────────────────────────────────────────────

function buildGitHubComment(auditId: string, url: string, result: Record<string, unknown>): string {
  const axe = result.axe as { violations?: Array<{ impact: string; id: string; description: string }> } | undefined;
  const semantic = result.semantic as {
    judgments?: Array<{ judgment: string; axeRuleId: string; wcagCriteria: string }>;
    rootCauseSummary?: string;
    prioritizedFixes?: Array<{ rank: number; impactSummary: string; fixCode: string }>;
  } | undefined;
  const behavioral = result.behavioral as { findings?: Array<{ type: string; severity: string }> } | undefined;

  const violations = axe?.violations ?? [];
  const critical = violations.filter(v => v.impact === 'critical');
  const serious = violations.filter(v => v.impact === 'serious');
  const confirmed = semantic?.judgments?.filter(j => j.judgment === 'confirmed') ?? [];

  const statusEmoji = critical.length > 0 ? '🔴' : serious.length > 0 ? '🟡' : '🟢';

  return `## ${statusEmoji} ACCEDA Accessibility Audit
**URL:** ${url}
**Audit ID:** \`${auditId}\`

| Metric | Count |
|--------|-------|
| 🔴 Critical Violations | **${critical.length}** |
| 🟡 Serious Violations | **${serious.length}** |
| 🔵 Semantic (Claude) Confirmed | **${confirmed.length}** |
| ⌨️ Behavioral Findings | **${behavioral?.findings?.length ?? 0}** |

### Root Cause Analysis
${semantic?.rootCauseSummary ?? 'N/A'}

### Top Prioritized Fix
${semantic?.prioritizedFixes?.[0]
  ? `**${semantic.prioritizedFixes[0].impactSummary}**\n\`\`\`\n${semantic.prioritizedFixes[0].fixCode}\n\`\`\``
  : 'No fixes generated.'
}

${critical.length > 0 ? '> ⛔ **PR blocked** — critical violations must be resolved before merge.' : '> ✅ No critical violations. Review semantic findings above.'}

<sub>ACCEDA • axe-core + Behavioral + Claude Semantic • [View full report](#)</sub>`;
}

function buildVerificationComment(diff: Record<string, unknown>): string {
  const delta = diff.deltaViolations as number;
  const verified = diff.verified as boolean;
  const emoji = verified ? '✅' : '❌';

  return `## ${emoji} ACCEDA Remediation Verification

| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| Violations | ${diff.violationsBefore} | ${diff.violationsAfter} | **${delta > 0 ? '+' : ''}${delta}** |
| Behavioral | ${diff.behavioralBefore} | ${diff.behavioralAfter} | **${(diff.behavioralAfter as number) - (diff.behavioralBefore as number)}** |

${verified
  ? '> ✅ Remediation verified — accessibility tree diff confirms improvement.'
  : '> ❌ Remediation unverified — violation count unchanged or increased.'}`;
}

async function postGitHubComment(
  token: string,
  pr: { repo: string; prNumber: number },
  body: string,
): Promise<void> {
  await fetch(`https://api.github.com/repos/${pr.repo}/issues/${pr.prNumber}/comments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'ACCEDA-Agent/1.0',
    },
    body: JSON.stringify({ body }),
  });
}

async function postCommitStatus(
  token: string,
  pr: { repo: string; sha: string },
  state: 'success' | 'failure' | 'pending',
  description: string,
  auditId: string,
): Promise<void> {
  await fetch(`https://api.github.com/repos/${pr.repo}/statuses/${pr.sha}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'ACCEDA-Agent/1.0',
    },
    body: JSON.stringify({
      state,
      description,
      context: 'ACCEDA / accessibility',
      target_url: `https://acceda.dev/audits/${auditId}`,
    }),
  });
}
