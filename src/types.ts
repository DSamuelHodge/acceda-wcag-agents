// src/types.ts
// Central type definitions for the ACCEDA agent system

export interface Env {
  // Durable Objects
  AUDIT_AGENT: DurableObjectNamespace;
  SENTINEL_AGENT: DurableObjectNamespace;

  // Workflows
  AUDIT_WORKFLOW: Workflow;
  REMEDIATION_WORKFLOW: Workflow;

  // KV
  ACCEDA_CACHE: KVNamespace;
  AUDIT_KV: KVNamespace;
  ACCEDA_SESSIONS: KVNamespace;

  // D1
  DB: D1Database;

  // R2
  SNAPSHOTS: R2Bucket;

  // AI (Workers AI / AI Gateway)
  AI: Ai;

  // Secrets
  ANTHROPIC_API_KEY: string;
  GITHUB_TOKEN: string;
  WEBHOOK_SECRET: string;

  // Vars
  WCAG_LEVEL: string;
  MAX_ELEMENTS: string;
  ENVIRONMENT: string;
  AI_GATEWAY_ID: string;
  AXE_CDN: string;
}

// ── Audit ─────────────────────────────────────────────────────────────────

export type AuditMode = 'ci' | 'webmcp' | 'sentinel';
export type WCAGLevel = 'wcag2a' | 'wcag2aa' | 'wcag21aa' | 'wcag22aa';
export type ImpactLevel = 'critical' | 'serious' | 'moderate' | 'minor';
export type AuditStatus = 'pending' | 'scanning' | 'analyzing' | 'complete' | 'failed';
export type ViolationStatus = 'open' | 'confirmed' | 'dismissed' | 'fixed';
export type SemanticJudgment = 'confirmed' | 'dismissed';
export type SnapshotPhase = 'baseline' | 'post_remediation';

export interface AuditConfig {
  url: string;
  mode: AuditMode;
  wcagLevel: WCAGLevel;
  maxElements: number;
  triggeredBy?: string;
}

export interface AuditSession {
  id: string;
  config: AuditConfig;
  status: AuditStatus;
  createdAt: string;
  completedAt?: string;
}

// ── Phase 1: Static (axe-core) ────────────────────────────────────────────

export interface AxeViolation {
  id: string;
  impact: ImpactLevel;
  description: string;
  tags: string[];
  nodes: AxeNode[];
}

export interface AxeNode {
  html: string;
  failureSummary?: string;
  target?: string[];
}

export interface AxeResult {
  violations: AxeViolation[];
  incomplete: AxeViolation[];
  passes: AxeViolation[];
  inapplicable: AxeViolation[];
  url: string;
  timestamp: string;
}

// ── Phase 2: Behavioral ───────────────────────────────────────────────────

export type BehavioralFindingType =
  | 'focus_not_visible'
  | 'focus_order_mismatch'
  | 'modal_focus_not_trapped'
  | 'modal_missing_label'
  | 'keyboard_trap'
  | 'skip_link_missing';

export interface BehavioralFinding {
  type: BehavioralFindingType;
  severity: ImpactLevel;
  issue: string;
  elementTag?: string;
  elementText?: string;
  elementId?: string;
}

export interface TabOrderElement {
  index: number;
  tag: string;
  role: string;
  text: string;
  top: number;
  id?: string;
}

export interface BehavioralScanResult {
  tabOrder: TabOrderElement[];
  findings: BehavioralFinding[];
}

// ── Phase 3: Semantic ─────────────────────────────────────────────────────

export interface SemanticJudgmentResult {
  axeRuleId: string;
  judgment: SemanticJudgment;
  wcagCriteria: string;
  reasoning: string;
  remediationHtml?: string;
  remediationCss?: string;
  remediationAria?: string;
}

export interface SemanticAnalysis {
  judgments: SemanticJudgmentResult[];
  prioritizedFixes: PrioritizedFix[];
  rootCauseSummary: string;
}

export interface PrioritizedFix {
  rank: number;
  violationIds: string[];
  impactSummary: string;
  fixType: 'css' | 'html' | 'aria' | 'js' | 'composite';
  fixCode: string;
  affectedUserGroups: string[];
}

// ── Phase 4: Snapshot & Diff ──────────────────────────────────────────────

export interface A11ySnapshot {
  id: string;
  auditId: string;
  phase: SnapshotPhase;
  r2Key: string;
  a11yTreeHash: string;
  screenshotR2Key?: string;
  capturedAt: string;
}

export interface AuditDiff {
  id: string;
  auditId: string;
  snapshotBefore: string;
  snapshotAfter: string;
  violationsBefore: number;
  violationsAfter: number;
  deltaViolations: number;
  behavioralBefore: number;
  behavioralAfter: number;
  verified: boolean;
  diffDetail?: ElementDiff[];
}

export interface ElementDiff {
  xpath: string;
  before: string;
  after: string;
  changeType: 'added' | 'removed' | 'modified';
}

// ── Full Audit Result ─────────────────────────────────────────────────────

export interface AuditResult {
  session: AuditSession;
  snapshot: A11ySnapshot;
  axe: AxeResult;
  behavioral: BehavioralScanResult;
  semantic: SemanticAnalysis;
  diff?: AuditDiff;
}

// ── MCP Tool Schemas (WebMCP contract) ────────────────────────────────────

export interface WCAGAuditToolInput {
  url: string;
  wcag_level?: WCAGLevel;
  max_elements?: number;
  mode?: AuditMode;
}

export interface WCAGVerifyToolInput {
  audit_id: string;
  url: string;
}

export interface WCAGSentinelToolInput {
  url: string;
  session_id: string;
  user_context?: string;
}
