-- ACCEDA D1 Schema
-- Relational model for the full audit lifecycle: baseline → violations → remediation → verification

-- ── Audit Sessions ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_sessions (
  id            TEXT PRIMARY KEY,          -- uuid
  url           TEXT NOT NULL,
  mode          TEXT NOT NULL,             -- 'ci' | 'webmcp' | 'sentinel'
  wcag_level    TEXT NOT NULL DEFAULT 'wcag2aa',
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | scanning | analyzing | complete | failed
  triggered_by  TEXT,                      -- github sha, user id, or session id
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at  TEXT
);

-- ── Snapshots (A11y tree state, stored ref in R2) ─────────────────────────
CREATE TABLE IF NOT EXISTS snapshots (
  id            TEXT PRIMARY KEY,
  audit_id      TEXT NOT NULL REFERENCES audit_sessions(id),
  phase         TEXT NOT NULL,             -- 'baseline' | 'post_remediation'
  r2_key        TEXT NOT NULL,             -- key in SNAPSHOTS R2 bucket
  a11y_tree_hash TEXT NOT NULL,            -- sha256 of serialized a11y tree for fast diff
  screenshot_r2_key TEXT,
  captured_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Violations ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS violations (
  id            TEXT PRIMARY KEY,
  audit_id      TEXT NOT NULL REFERENCES audit_sessions(id),
  source        TEXT NOT NULL,             -- 'axe' | 'behavioral' | 'semantic'
  phase         TEXT NOT NULL,             -- 'static' | 'behavioral' | 'semantic'
  violation_id  TEXT NOT NULL,             -- axe rule id or custom id
  impact        TEXT,                      -- 'critical' | 'serious' | 'moderate' | 'minor'
  wcag_criteria TEXT,                      -- e.g. '1.4.3, 2.4.7'
  description   TEXT NOT NULL,
  element_html  TEXT,                      -- truncated offending element
  element_xpath TEXT,
  status        TEXT NOT NULL DEFAULT 'open', -- 'open' | 'confirmed' | 'dismissed' | 'fixed'
  confidence    REAL,                      -- 0-1, for semantic layer judgments
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Behavioral Findings ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS behavioral_findings (
  id            TEXT PRIMARY KEY,
  audit_id      TEXT NOT NULL REFERENCES audit_sessions(id),
  type          TEXT NOT NULL,             -- 'focus_not_visible' | 'focus_order_mismatch' | 'modal_focus_not_trapped' | ...
  severity      TEXT NOT NULL,
  issue         TEXT NOT NULL,
  element_tag   TEXT,
  element_text  TEXT,
  element_id    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Semantic Judgments (Claude's resolution of incomplete items) ───────────
CREATE TABLE IF NOT EXISTS semantic_judgments (
  id            TEXT PRIMARY KEY,
  audit_id      TEXT NOT NULL REFERENCES audit_sessions(id),
  violation_id  TEXT REFERENCES violations(id),
  axe_rule_id   TEXT NOT NULL,
  judgment      TEXT NOT NULL,             -- 'confirmed' | 'dismissed'
  wcag_criteria TEXT,
  reasoning     TEXT NOT NULL,
  remediation_html TEXT,
  remediation_css  TEXT,
  remediation_aria TEXT,
  model         TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Remediations ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS remediations (
  id            TEXT PRIMARY KEY,
  audit_id      TEXT NOT NULL REFERENCES audit_sessions(id),
  violation_ids TEXT NOT NULL,             -- JSON array of violation ids this fix addresses
  fix_type      TEXT NOT NULL,             -- 'css' | 'html' | 'aria' | 'js' | 'composite'
  fix_code      TEXT NOT NULL,
  applied_at    TEXT,
  verified      INTEGER DEFAULT 0,         -- 0 | 1
  delta_summary TEXT,                      -- JSON diff summary S0 → S1
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Diffs (S0 → S1 verification records) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_diffs (
  id              TEXT PRIMARY KEY,
  audit_id        TEXT NOT NULL REFERENCES audit_sessions(id),
  snapshot_before TEXT NOT NULL REFERENCES snapshots(id),
  snapshot_after  TEXT NOT NULL REFERENCES snapshots(id),
  violations_before INTEGER NOT NULL,
  violations_after  INTEGER NOT NULL,
  delta_violations  INTEGER NOT NULL,      -- negative = improvement
  behavioral_before INTEGER NOT NULL,
  behavioral_after  INTEGER NOT NULL,
  verified        INTEGER NOT NULL DEFAULT 0,
  diff_detail     TEXT,                    -- JSON: element-level changes
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Indices ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_violations_audit  ON violations(audit_id);
CREATE INDEX IF NOT EXISTS idx_violations_status ON violations(status);
CREATE INDEX IF NOT EXISTS idx_snapshots_audit   ON snapshots(audit_id);
CREATE INDEX IF NOT EXISTS idx_sessions_url      ON audit_sessions(url);
CREATE INDEX IF NOT EXISTS idx_sessions_mode     ON audit_sessions(mode);
