/**
 * services/findingRollup.js — collapse page-scoped findings into one
 * finding per (rule, origin).
 *
 * Some defects are properties of the SITE or the DOCUMENT TEMPLATE, not of an
 * individual page: a missing CSP header is one fix for the whole origin; an
 * <html> element without lang is one template edit. Reported per page they
 * multiply noise — the Phase F Conduit triage measured 80 findings for 8
 * site-wide header rules (10 pages × 8 rules).
 *
 * Contract:
 *   • `shouldRollup(finding)` decides membership; everything else passes
 *     through untouched (and keeps its position).
 *   • Group key = ruleId + URL origin (falls back to the raw pageUrl when the
 *     URL cannot be parsed; findings without pageUrl always pass through).
 *   • Representative = the alphabetically-first pageUrl in the group, so the
 *     (ruleId, pageUrl) identity used by run-to-run diffing (`runDiff`) stays
 *     stable between runs regardless of crawl order.
 *   • occurrences are summed, affectedPages are unioned, the worst severity
 *     wins; all other fields come from the representative.
 *
 * Pure function: returns a new array, never mutates inputs.
 */

const SEVERITY_RANK = { info: 0, low: 1, medium: 2, high: 3, critical: 4, serious: 2.5 };

function worstSeverity(a, b) {
  return (SEVERITY_RANK[b] || 0) > (SEVERITY_RANK[a] || 0) ? b : a;
}

function originOf(pageUrl) {
  if (!pageUrl) return null;
  try {
    return new URL(pageUrl).origin;
  } catch {
    return String(pageUrl);
  }
}

/**
 * @param {object[]} findings        — findings already produced by createFinding()
 * @param {(f: object) => boolean} shouldRollup — group membership predicate
 * @returns {object[]} new array; one merged finding per (ruleId, origin) group,
 *                     position-stable at the group's first occurrence
 */
export function rollupAcrossPages(findings, shouldRollup) {
  if (!Array.isArray(findings) || findings.length === 0) return [];
  if (typeof shouldRollup !== 'function') throw new Error('rollupAcrossPages requires a shouldRollup predicate');

  const groups = new Map(); // groupKey → merged finding
  const sequence = [];      // ordered output: passthrough findings + merged groups

  for (const finding of findings) {
    if (!finding || typeof finding !== 'object') continue;

    const ruleId = finding.ruleId ? String(finding.ruleId) : '';
    const pageUrl = typeof finding.pageUrl === 'string' ? finding.pageUrl : '';
    const origin = originOf(pageUrl);
    const eligible = Boolean(ruleId && origin && shouldRollup(finding));

    if (!eligible) {
      sequence.push(finding);
      continue;
    }

    const key = `${ruleId}::${origin}`;
    const merged = groups.get(key);
    if (!merged) {
      const first = {
        ...finding,
        occurrences: finding.occurrences || 1,
        affectedPages: [...new Set(finding.affectedPages || (pageUrl ? [pageUrl] : []))],
      };
      groups.set(key, first);
      sequence.push(first);
      continue;
    }

    merged.occurrences = (merged.occurrences || 1) + (finding.occurrences || 1);
    const pages = new Set(merged.affectedPages || []);
    for (const p of (finding.affectedPages || (pageUrl ? [pageUrl] : []))) {
      if (p) pages.add(p);
    }
    merged.affectedPages = [...pages];
    merged.severity = worstSeverity(merged.severity, finding.severity);
    if (finding.screenshot && !merged.screenshot) merged.screenshot = finding.screenshot;
    // Keep the alphabetically-first pageUrl as the stable identity (runDiff).
    if (pageUrl && merged.pageUrl && pageUrl < merged.pageUrl) {
      merged.pageUrl = pageUrl;
    }
  }

  return sequence;
}
