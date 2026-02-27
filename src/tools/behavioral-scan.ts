// src/tools/behavioral-scan.ts
// Phase 2: Behavioral WCAG scan — the 43% axe cannot auto-determine.
// Runs inside the browser context via Playwright MCP evaluate calls.
// Tests: focus visibility (incl. :focus-visible), tab order, modal focus traps.

import type { BehavioralFinding, BehavioralScanResult, TabOrderElement } from '../types.js';

export const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="option"]',
].join(', ');

/**
 * Script 1: Tab order + DOM/visual order mismatch detection.
 * WCAG 1.3.2, 2.4.3
 */
export const TAB_ORDER_SCRIPT = `
  (args) => {
    const [sel, maxN] = args;
    return Array.from(document.querySelectorAll(sel))
      .slice(0, maxN)
      .map((el, i) => ({
        index: i,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || el.tagName.toLowerCase(),
        text: (el.textContent || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 60),
        top: el.getBoundingClientRect().top,
        id: el.id || null,
        tabIndex: el.tabIndex
      }));
  }
`;

/**
 * Script 2: Focus visibility — detects missing focus indicators.
 * Checks outline, box-shadow, AND :focus-visible pseudo-class via getComputedStyle.
 * WCAG 2.4.7, 2.4.11
 *
 * Note: We force focus and then re-query computed styles. This catches
 * :focus-visible patterns that static axe misses entirely.
 */
export const FOCUS_VISIBILITY_SCRIPT = `
  (args) => {
    const [sel, maxN] = args;
    const failures = [];
    const saved = document.activeElement;

    for (const el of Array.from(document.querySelectorAll(sel)).slice(0, maxN)) {
      el.focus();
      const s = window.getComputedStyle(el);

      // Check all known focus indicator patterns
      const hasOutline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
      const hasBoxShadow = s.boxShadow && s.boxShadow !== 'none';

      // Check parent for focus-within styles (common pattern)
      const parent = el.parentElement;
      const parentStyle = parent ? window.getComputedStyle(parent, ':focus-within') : null;
      const parentHasFocusWithin = parentStyle && parentStyle.outline !== 'none';

      // Check ::before / ::after pseudo focus rings (CSS-only custom focus)
      const beforeStyle = window.getComputedStyle(el, '::before');
      const hasPseudoRing = beforeStyle.content !== 'none' && beforeStyle.boxShadow !== 'none';

      if (!hasOutline && !hasBoxShadow && !parentHasFocusWithin && !hasPseudoRing) {
        failures.push({
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().slice(0, 60),
          id: el.id || null,
          outline: s.outline,
          role: el.getAttribute('role') || null
        });
      }
    }

    if (saved && saved.focus) saved.focus();
    return failures;
  }
`;

/**
 * Script 3: Skip link presence.
 * WCAG 2.4.1
 */
export const SKIP_LINK_SCRIPT = `
  () => {
    const skipLinks = Array.from(document.querySelectorAll('a[href^="#"]'))
      .filter(a => {
        const text = (a.textContent || '').toLowerCase();
        return text.includes('skip') || text.includes('jump') || text.includes('main');
      });
    return { present: skipLinks.length > 0, count: skipLinks.length };
  }
`;

/**
 * Script 4: Modal focus trap testing.
 * WCAG 2.4.3, 4.1.2
 */
export const MODAL_TRIGGERS_SCRIPT = `
  () => Array.from(document.querySelectorAll(
    'button, [role="button"], [aria-haspopup="dialog"], [data-bs-toggle="modal"]'
  )).slice(0, 8).map(el => ({
    text: (el.textContent || '').trim().slice(0, 40),
    id: el.id || null,
    tag: el.tagName.toLowerCase()
  }))
`;

export const MODAL_STATE_SCRIPT = `
  () => {
    const active = document.activeElement;
    const dlg = document.querySelector('[role="dialog"], [aria-modal="true"], dialog[open]');
    return {
      dialogExists: !!dlg,
      focusInDialog: dlg ? dlg.contains(active) : false,
      dialogLabeled: dlg
        ? !!(dlg.getAttribute('aria-label') || dlg.getAttribute('aria-labelledby'))
        : null
    };
  }
`;

/**
 * Synthesize tab order array into focus_order_mismatch findings.
 * Pure function — no DOM access needed.
 */
export function detectFocusOrderMismatches(tabOrder: TabOrderElement[]): BehavioralFinding[] {
  const findings: BehavioralFinding[] = [];
  let prevTop = -1;

  for (const el of tabOrder) {
    if (el.top < prevTop - 50) {
      findings.push({
        type: 'focus_order_mismatch',
        severity: 'serious',
        issue: `Element #${el.index} <${el.tag}> "${el.text}" appears visually above previous focusable element — likely CSS flex/grid reorder violating WCAG 1.3.2, 2.4.3`,
        elementTag: el.tag,
        elementText: el.text,
        elementId: el.id ?? undefined,
      });
    }
    prevTop = el.top;
  }

  return findings;
}

/**
 * Convert raw focus failure objects into typed BehavioralFindings.
 */
export function mapFocusFailures(rawFailures: Array<{
  tag: string; text: string; id: string | null; outline: string; role: string | null;
}>): BehavioralFinding[] {
  return rawFailures.map(el => ({
    type: 'focus_not_visible' as const,
    severity: 'serious' as const,
    issue: `No visible focus indicator on <${el.tag}> "${el.text}" (WCAG 2.4.7, 2.4.11). Computed outline: "${el.outline}". Check :focus-visible, box-shadow, and pseudo-element rings.`,
    elementTag: el.tag,
    elementText: el.text,
    elementId: el.id ?? undefined,
  }));
}

/**
 * Generate the full BehavioralScanResult from collected script outputs.
 * Called from the AuditAgent after it executes each script via Playwright MCP.
 */
export function assembleBehavioralResult(
  tabOrder: TabOrderElement[],
  focusFailures: Array<{ tag: string; text: string; id: string | null; outline: string; role: string | null }>,
  skipLinkResult: { present: boolean; count: number },
  modalFindings: BehavioralFinding[],
): BehavioralScanResult {
  const findings: BehavioralFinding[] = [
    ...detectFocusOrderMismatches(tabOrder),
    ...mapFocusFailures(focusFailures),
    ...modalFindings,
  ];

  if (!skipLinkResult.present) {
    findings.push({
      type: 'skip_link_missing',
      severity: 'moderate',
      issue: 'No skip navigation link found. Keyboard users must tab through all navigation on every page. Violates WCAG 2.4.1.',
    });
  }

  return { tabOrder, findings };
}
