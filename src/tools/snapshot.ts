// src/tools/snapshot.ts
// Phase 0 & 4: A11y tree snapshot capture and S0→S1 diff computation.
// Snapshots stored in R2. Hashes stored in D1 for fast comparison.
// The diff Δ = S1 - S0 is the remediation verification signal.

import type { A11ySnapshot, AuditDiff, ElementDiff, SnapshotPhase } from '../types.js';

/**
 * Script to capture the full accessibility tree as a structured JSON object.
 * Used by Playwright MCP's evaluate / take_snapshot equivalent.
 * Returns a serializable representation of the a11y tree.
 */
export const A11Y_TREE_CAPTURE_SCRIPT = `
  () => {
    function captureNode(el, depth = 0) {
      if (depth > 10) return null;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return null;

      const node = {
        tag: el.tagName?.toLowerCase(),
        role: el.getAttribute('role') || el.tagName?.toLowerCase(),
        id: el.id || null,
        name: el.getAttribute('aria-label')
          || el.getAttribute('aria-labelledby')
          || (el.textContent || '').trim().slice(0, 80),
        hidden: el.getAttribute('aria-hidden') === 'true',
        disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
        expanded: el.getAttribute('aria-expanded'),
        selected: el.getAttribute('aria-selected'),
        checked: el.getAttribute('aria-checked') || el.checked,
        required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
        level: el.getAttribute('aria-level'),
        tabIndex: el.tabIndex,
        focusable: el.tabIndex >= 0,
        children: []
      };

      for (const child of el.children) {
        const childNode = captureNode(child, depth + 1);
        if (childNode) node.children.push(childNode);
      }

      return node;
    }

    return {
      url: window.location.href,
      title: document.title,
      timestamp: new Date().toISOString(),
      tree: captureNode(document.body)
    };
  }
`;

/**
 * Compute SHA-256 hash of the serialized a11y tree.
 * Used for fast equality checks before doing full diff.
 */
export async function hashA11yTree(tree: unknown): Promise<string> {
  const serialized = JSON.stringify(tree);
  const encoder = new TextEncoder();
  const data = encoder.encode(serialized);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Store snapshot in R2. Returns the R2 key.
 * Key pattern: audits/{auditId}/{phase}/{timestamp}.json
 */
export async function storeSnapshot(
  bucket: R2Bucket,
  auditId: string,
  phase: SnapshotPhase,
  tree: unknown,
  screenshot?: ArrayBuffer,
): Promise<{ treeKey: string; screenshotKey?: string }> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const treeKey = `audits/${auditId}/${phase}/${timestamp}-tree.json`;

  await bucket.put(treeKey, JSON.stringify(tree), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { auditId, phase, timestamp },
  });

  let screenshotKey: string | undefined;
  if (screenshot) {
    screenshotKey = `audits/${auditId}/${phase}/${timestamp}-screenshot.png`;
    await bucket.put(screenshotKey, screenshot, {
      httpMetadata: { contentType: 'image/png' },
      customMetadata: { auditId, phase, timestamp },
    });
  }

  return { treeKey, screenshotKey };
}

/**
 * Retrieve and parse a snapshot from R2.
 */
export async function loadSnapshot(bucket: R2Bucket, r2Key: string): Promise<unknown> {
  const obj = await bucket.get(r2Key);
  if (!obj) throw new Error(`Snapshot not found in R2: ${r2Key}`);
  return obj.json();
}

/**
 * Compute structural diff between S0 and S1 a11y trees.
 * Returns element-level changes for the diff table in D1.
 *
 * Abstraction note: we're doing a simplified structural diff here —
 * a proper Myers diff over the serialized tree would be more precise
 * but the signal we need (did this element's a11y properties change?)
 * is captured by the flat map comparison below.
 */
export function diffA11yTrees(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): ElementDiff[] {
  const diffs: ElementDiff[] = [];

  function flattenTree(node: Record<string, unknown>, path = 'body'): Map<string, string> {
    const map = new Map<string, string>();
    if (!node) return map;

    const { children, ...attrs } = node as { children?: unknown[]; [key: string]: unknown };
    const key = `${path}[${attrs.tag}${attrs.id ? '#' + attrs.id : ''}]`;
    map.set(key, JSON.stringify(attrs));

    if (Array.isArray(children)) {
      children.forEach((child, i) => {
        const childMap = flattenTree(child as Record<string, unknown>, `${key}>${i}`);
        childMap.forEach((v, k) => map.set(k, v));
      });
    }

    return map;
  }

  const beforeMap = flattenTree((before as { tree: Record<string, unknown> }).tree);
  const afterMap = flattenTree((after as { tree: Record<string, unknown> }).tree);

  // Detect removed nodes
  for (const [xpath, beforeVal] of beforeMap) {
    if (!afterMap.has(xpath)) {
      diffs.push({ xpath, before: beforeVal, after: '', changeType: 'removed' });
    } else if (afterMap.get(xpath) !== beforeVal) {
      diffs.push({ xpath, before: beforeVal, after: afterMap.get(xpath)!, changeType: 'modified' });
    }
  }

  // Detect added nodes
  for (const [xpath, afterVal] of afterMap) {
    if (!beforeMap.has(xpath)) {
      diffs.push({ xpath, before: '', after: afterVal, changeType: 'added' });
    }
  }

  return diffs;
}

/**
 * Build the AuditDiff record from two snapshots and their violation counts.
 */
export function buildAuditDiff(params: {
  auditId: string;
  snapshotBeforeId: string;
  snapshotAfterId: string;
  treesBefore: Record<string, unknown>;
  treesAfter: Record<string, unknown>;
  violationsBefore: number;
  violationsAfter: number;
  behavioralBefore: number;
  behavioralAfter: number;
}): Omit<AuditDiff, 'id'> {
  const diffDetail = diffA11yTrees(params.treesBefore, params.treesAfter);

  return {
    auditId: params.auditId,
    snapshotBefore: params.snapshotBeforeId,
    snapshotAfter: params.snapshotAfterId,
    violationsBefore: params.violationsBefore,
    violationsAfter: params.violationsAfter,
    deltaViolations: params.violationsAfter - params.violationsBefore,
    behavioralBefore: params.behavioralBefore,
    behavioralAfter: params.behavioralAfter,
    verified: params.violationsAfter < params.violationsBefore,
    diffDetail,
  };
}
