// src/tools/static-scan.ts
// Phase 1: axe-core static WCAG scan
// Injected into the page via Playwright MCP / Browser Rendering
// Returns the raw AxeResult which feeds directly into Phase 3 (incomplete items)

import type { AxeResult, WCAGLevel } from '../types.js';

export const AXE_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.9.1/axe.min.js';

/**
 * The JS payload injected into the browser context via Playwright MCP.
 * Returns serializable AxeResult.
 */
export function buildAxeScript(wcagLevel: WCAGLevel): string {
  return `
    async () => {
      // Inject axe-core if not present
      if (typeof window.axe === 'undefined') {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = '${AXE_CDN}';
          s.onload = resolve;
          s.onerror = reject;
          document.head.appendChild(s);
        });
        // Wait for axe to be ready
        await new Promise(r => setTimeout(r, 500));
      }
      return await window.axe.run(document, {
        runOnly: { type: 'tag', values: ['${wcagLevel}', 'best-practice'] },
        resultTypes: ['violations', 'incomplete', 'inapplicable'],
        reporter: 'v2'
      });
    }
  `;
}

/**
 * Partition axe results into the 57% (confirmed) and 43% (incomplete/undetermined).
 * The incomplete set is the precise input to Phase 2 + Phase 3.
 */
export function partitionAxeResults(axe: AxeResult): {
  confirmed: AxeResult['violations'];
  undetermined: AxeResult['violations'];
} {
  return {
    confirmed: axe.violations,
    undetermined: axe.incomplete,
  };
}

/**
 * Summarize for logging / KV caching
 */
export function summarizeAxeResult(axe: AxeResult) {
  const byImpact = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const v of axe.violations) {
    byImpact[v.impact] = (byImpact[v.impact] || 0) + 1;
  }
  return {
    total_violations: axe.violations.length,
    total_incomplete: axe.incomplete.length,
    by_impact: byImpact,
    url: axe.url,
    timestamp: axe.timestamp,
  };
}
