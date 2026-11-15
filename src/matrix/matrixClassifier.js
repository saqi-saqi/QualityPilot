/**
 * matrix/matrixClassifier.js — matrix-level failure classification.
 *
 * BUILD_PLAN classification steps 2–4 (Rev 3), applied AFTER signature-level
 * classification (Phase 0) and AFTER cross-cell dedup. This module is the G1
 * research contribution: matrix-variance flaky detection.
 *
 *   Step 2 — Page-scope agreement: does the failure span pages?
 *     Timeout on ONE covered page while others load fine → likely a hanging
 *     page = application problem (promote to a suspected bug).
 *     Timeouts on EVERY covered page → environmental (network/server down).
 *   Step 3 — Cross-cell agreement: how reliable is the signal?
 *     Consistent across cells → keep confidence.
 *     Confirmed-but-single-cell nondeterministic findings → demote to
 *     suspected (flaky candidate).
 *   Step 4 — Retry-before-confirm (reconciliation): an application candidate
 *     that passes on retry → flaky (demote); fails again → confirmed.
 *     Environmental candidates are never retried.
 *
 * Design constraints:
 *   • Pure functions over findings — no I/O, no LLM.
 *   • Deterministic executors (a11y, visual baselines, security headers) are
 *     NEVER demoted by cross-cell disagreement: a chromium-only a11y
 *     violation is a real browser-specific finding, not noise.
 *   • Retry-confirmed findings (`retriedConfirmed`) are exempt from
 *     cross-cell demotion — reproduction under retry outranks cell-count.
 */

// Rule IDs whose outcome depends on server timing / network state — the only
// ones eligible for retry and cross-cell demotion. Deterministic executors
// (a11y/visual/security-header scanners) are deliberately excluded.
export const NONDETERMINISTIC_RULES = new Set([
  'api-status-mismatch',
  'api-error',
  'api-timeout',
  'api-unreachable',
  'fuzz-failure',
  'fuzz-environmental',
  'e2e-flow-failure',
  'e2e-flow-selector-timeout',
]);

// Environmental rules produced by Phase 0 signature-level classification —
// the inputs for page-scope agreement.
export const ENV_RULES = new Set(['api-timeout', 'api-unreachable', 'fuzz-environmental']);

export const RETRIABLE_RULE_PREFIXES = ['api-', 'fuzz-', 'e2e-flow'];

export function isRetriableFinding(finding) {
  const ruleId = String(finding?.ruleId || '');
  return RETRIABLE_RULE_PREFIXES.some((p) => ruleId.startsWith(p));
}

const normUrl = (u) => {
  try {
    return new URL(u).toString();
  } catch {
    return u;
  }
};

/**
 * Step 2 — Page-scope agreement over environmental FINDINGS.
 *
 * Environmental candidates (timeouts/unreachable, already suspected from
 * signature-level classification) are re-judged against the set of covered
 * pages: an isolated failure amid healthy pages is promoted to a suspected
 * BUG (findingType 'bug', pageScoped: true — likely a hanging page/route);
 * failures spanning every covered page stay environmental (site down).
 *
 * No-op when coveredPages is unknown (nothing to agree against) or when
 * `options.pageScopeAgreement === false`.
 *
 * @returns {{ findings: Array, promoted: Array }} — promoted findings were
 *          flipped to findingType 'bug' in place.
 */
export function pageScopeAgreement({ findings, coveredPages = [], options = {} } = {}) {
  const promoted = [];
  if (options?.pageScopeAgreement === false || !Array.isArray(findings)) {
    return { findings: findings || [], promoted };
  }
  const covered = [...new Set((coveredPages || []).map(normUrl))].filter(Boolean);
  if (covered.length === 0) return { findings, promoted };

  const envFindings = findings.filter(
    (f) => f.findingType === 'environmental' && ENV_RULES.has(f.ruleId) && f.pageUrl,
  );
  const failingUrls = new Set(envFindings.map((f) => normUrl(f.pageUrl)));
  if (failingUrls.size === 0) return { findings, promoted };

  const healthy = covered.filter((u) => !failingUrls.has(u));
  if (healthy.length === 0) return { findings, promoted }; // site-wide — stays environmental

  for (const f of envFindings) {
    if (f.findingType !== 'environmental') continue;
    f.findingType = 'bug';
    f.pageScoped = true;
    f.description = `${f.description} [page-scope: ${healthy.length} other covered page(s) loaded fine — this isolated failure looks like an app problem, not the environment.]`;
    promoted.push(f);
  }
  return { findings, promoted };
}

/**
 * Step 2 (coverage variant) — promote isolated page-LOAD failures into
 * suspected bug findings. Guardrails: requires ≥3 covered pages, at least
 * one healthy page, and failing pages must be a minority (≤ healthy count).
 * Site-wide load failures stay coverage-failure records (environment down).
 *
 * Disabled when `options.pageScopePromotion === false`.
 *
 * @returns {{ promoted: Array }} — newly created findings (the original
 *          coverage-failure records are kept for coverage honesty).
 */
export function promotePageLoadFailures({ pageFailures = [], coveredPages = [], createFinding, options = {} } = {}) {
  const promoted = [];
  if (options?.pageScopePromotion === false || typeof createFinding !== 'function') {
    return { promoted };
  }
  const covered = [...new Set(coveredPages || [])];
  const failedUrls = [...new Set((pageFailures || []).map((p) => p.url).filter(Boolean))];
  if (covered.length < 3 || failedUrls.length === 0) return { promoted };
  const healthy = covered.filter((u) => !failedUrls.includes(u));
  if (healthy.length < failedUrls.length) return { promoted }; // site-wide, not per-page

  for (const pf of pageFailures) {
    promoted.push(createFinding({
      title: `Page hangs while other targets load: ${pf.url}`,
      severity: 'medium',
      confidence: 'suspected',
      category: 'network',
      findingType: 'bug',
      origin: 'first-party',
      ruleId: 'page-unresponsive',
      pageUrl: pf.url,
      description: `This page failed to load while ${healthy.length} other covered page(s) loaded fine. Page-scope agreement points at an app-level problem on this page (hanging render or route) rather than the environment. The coverage-failure record for this page is kept separately.`,
      evidence: pf.error || '',
      occurrences: 1,
      affectedPages: [pf.url],
    }));
  }
  return { promoted };
}

/**
 * Step 3 — Cross-cell agreement over DEDUPED findings.
 *
 * A nondeterministic finding CONFIRMED but observed in only one cell of a
 * multi-cell matrix is demoted to suspected + flagged as a flaky candidate.
 * Deterministic executors and retry-confirmed findings are exempt.
 *
 * @param {Array} findings — deduped findings (matrixCells populated by dedupFindings)
 * @param {number} cellsTotal — total cells in the matrix
 * @param {object} [options] — { crossCellAgreement: false } disables
 * @returns {Array} the demoted findings
 */
export function crossCellAgreement(findings, cellsTotal, options = {}) {
  const demoted = [];
  if (!Array.isArray(findings) || cellsTotal <= 1 || options?.crossCellAgreement === false) {
    return demoted;
  }
  for (const f of findings) {
    if (f.retriedConfirmed) continue; // retry evidence outranks cell count
    if (!NONDETERMINISTIC_RULES.has(f.ruleId)) continue;
    if (!Array.isArray(f.matrixCells) || f.matrixCells.length !== 1) continue;
    if (f.confidence !== 'confirmed') continue;
    f.confidence = 'suspected';
    f.flakyCandidate = true;
    f.singleCell = true;
    f.description = `${f.description} [cross-cell: observed in only 1 of ${cellsTotal} matrix cells — demoted as a flaky candidate (G1).]`;
    demoted.push(f);
  }
  return demoted;
}

/**
 * Step 4 — Retry reconciliation: compare run-1 findings with the retry run.
 *
 * A retriable APPLICATION candidate that was confirmed in run 1 but does NOT
 * reproduce in run 2 → demoted to suspected + flakyRetried. One that
 * reproduces → confirmed and marked `retriedConfirmed` (exempt from
 * cross-cell demotion). Environmental candidates are never retried.
 *
 * Mutates run-1 findings in place; returns the demoted list.
 */
export function retryReconcile(run1Findings, run2Findings, options = {}) {
  const demoted = [];
  if (options?.retryBeforeConfirm === false || !Array.isArray(run1Findings)) {
    return demoted;
  }
  const run2Keys = new Set((run2Findings || []).map(retryKey));
  for (const f of run1Findings) {
    if (!isRetriableFinding(f)) continue;
    if (f.findingType === 'environmental') continue; // retrying a dead network proves nothing
    const k = retryKey(f);
    if (f.confidence === 'confirmed' && !run2Keys.has(k)) {
      f.confidence = 'suspected';
      f.flakyCandidate = true;
      f.flakyRetried = true;
      f.description = `${f.description} [retry: did not reproduce on a second run — demoted as flaky (G1).]`;
      demoted.push(f);
    } else if (f.confidence === 'confirmed' && run2Keys.has(k)) {
      f.retriedConfirmed = true;
    }
  }
  return demoted;
}

function retryKey(finding) {
  // Same key shape dedupFindings uses: ruleId + node signature + page URL.
  const ruleId = finding.ruleId || 'gen';
  const selector = String(finding.selector || finding.target || (finding.evidence || '').slice(0, 120) || '');
  const url = (() => {
    try {
      return new URL(finding.pageUrl || finding.url || '').toString();
    } catch {
      return finding.pageUrl || finding.url || '';
    }
  })();
  return `${ruleId}::${selector}::${url}`;
}
