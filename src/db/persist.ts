// src/db/persist.ts
// D1 persistence helpers — typed wrappers over raw SQL.
// All writes are idempotent (INSERT OR IGNORE / INSERT OR REPLACE).

import type {
  A11ySnapshot,
  AuditDiff,
  AxeViolation,
  BehavioralFinding,
  SemanticJudgmentResult,
} from '../types.js';
import { generateId } from '../utils/ids.js';

export async function persistSession(
  db: D1Database,
  session: {
    id: string;
    url: string;
    mode: string;
    wcagLevel: string;
    triggeredBy?: string;
  },
): Promise<void> {
  await db.prepare(
    `INSERT OR IGNORE INTO audit_sessions (id, url, mode, wcag_level, status, triggered_by)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
  ).bind(session.id, session.url, session.mode, session.wcagLevel, session.triggeredBy ?? null).run();
}

export async function persistViolations(
  db: D1Database,
  auditId: string,
  violations: AxeViolation[],
  source: 'axe' | 'behavioral' | 'semantic',
  phase: 'static' | 'behavioral' | 'semantic',
): Promise<void> {
  const stmts = violations.map(v =>
    db.prepare(
      `INSERT OR IGNORE INTO violations
       (id, audit_id, source, phase, violation_id, impact, wcag_criteria, description, element_html, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
    ).bind(
      generateId('viol'),
      auditId,
      source,
      phase,
      v.id,
      v.impact,
      v.tags.filter(t => t.includes('wcag')).join(', '),
      v.description,
      v.nodes[0]?.html?.slice(0, 500) ?? null,
    ),
  );

  if (stmts.length > 0) {
    await db.batch(stmts);
  }
}

export async function persistBehavioralFindings(
  db: D1Database,
  auditId: string,
  findings: BehavioralFinding[],
): Promise<void> {
  const stmts = findings.map(f =>
    db.prepare(
      `INSERT OR IGNORE INTO behavioral_findings
       (id, audit_id, type, severity, issue, element_tag, element_text, element_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      generateId('beh'),
      auditId,
      f.type,
      f.severity,
      f.issue,
      f.elementTag ?? null,
      f.elementText ?? null,
      f.elementId ?? null,
    ),
  );

  if (stmts.length > 0) {
    await db.batch(stmts);
  }
}

export async function persistJudgments(
  db: D1Database,
  auditId: string,
  judgments: SemanticJudgmentResult[],
): Promise<void> {
  const stmts = judgments.map(j =>
    db.prepare(
      `INSERT OR IGNORE INTO semantic_judgments
       (id, audit_id, axe_rule_id, judgment, wcag_criteria, reasoning, remediation_html, remediation_css, remediation_aria, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      generateId('judg'),
      auditId,
      j.axeRuleId,
      j.judgment,
      j.wcagCriteria,
      j.reasoning,
      j.remediationHtml ?? null,
      j.remediationCss ?? null,
      j.remediationAria ?? null,
      'claude-sonnet-4-6',
    ),
  );

  if (stmts.length > 0) {
    await db.batch(stmts);
  }
}

export async function persistSnapshot(
  db: D1Database,
  snapshot: Omit<A11ySnapshot, 'capturedAt'>,
): Promise<void> {
  await db.prepare(
    `INSERT OR IGNORE INTO snapshots
     (id, audit_id, phase, r2_key, a11y_tree_hash, screenshot_r2_key)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    snapshot.id,
    snapshot.auditId,
    snapshot.phase,
    snapshot.r2Key,
    snapshot.a11yTreeHash,
    snapshot.screenshotR2Key ?? null,
  ).run();
}

export async function persistDiff(
  db: D1Database,
  diff: AuditDiff,
): Promise<void> {
  await db.prepare(
    `INSERT OR IGNORE INTO audit_diffs
     (id, audit_id, snapshot_before, snapshot_after, violations_before, violations_after,
      delta_violations, behavioral_before, behavioral_after, verified, diff_detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    diff.id,
    diff.auditId,
    diff.snapshotBefore,
    diff.snapshotAfter,
    diff.violationsBefore,
    diff.violationsAfter,
    diff.deltaViolations,
    diff.behavioralBefore,
    diff.behavioralAfter,
    diff.verified ? 1 : 0,
    JSON.stringify(diff.diffDetail ?? []),
  ).run();
}

export async function getAuditSummary(db: D1Database, auditId: string) {
  const [session, violations, behavioral, judgments] = await db.batch([
    db.prepare('SELECT * FROM audit_sessions WHERE id = ?').bind(auditId),
    db.prepare('SELECT impact, COUNT(*) as count FROM violations WHERE audit_id = ? GROUP BY impact').bind(auditId),
    db.prepare('SELECT severity, COUNT(*) as count FROM behavioral_findings WHERE audit_id = ? GROUP BY severity').bind(auditId),
    db.prepare('SELECT judgment, COUNT(*) as count FROM semantic_judgments WHERE audit_id = ? GROUP BY judgment').bind(auditId),
  ]);

  return {
    session: session.results[0],
    violations: violations.results,
    behavioral: behavioral.results,
    judgments: judgments.results,
  };
}
