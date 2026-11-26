/**
 * services/compliance.js — WCAG 2.x conformance scoring (zero LLM, pure code).
 *
 * Turns the run's axe-core findings into a compliance statement:
 *   { conformancePct, criteria[], blockers[], levels{A,AA,bestPractice}, partial }
 *
 * Mapping: each axe rule used by the accessibility executor maps to a WCAG
 * 2.x success criterion (or "best practice" — axe rules with no SC, which
 * are reported but NOT counted in the conformance percentage, matching how
 * WCAG conformance is actually claimed).
 *
 * The default rule universe is ALL axe-core rules tagged wcag2a, wcag2aa,
 * wcag21a or wcag21aa (embedded from axe-core 4.13; the a11y executor can
 * also fetch the live list from axe.getRules() inside the page). Conformance
 * is computed over THAT universe, not just the executed subset: when the
 * run's plan only executed part of the universe, the percentage is marked
 * `partial: true` with an explanatory note.
 */

// axe rule id (without the `axe-` prefix) → WCAG 2.x success criterion.
// `criterion: null` = W3C/axe "best practice" rule — valuable, but not a
// WCAG success criterion, so excluded from the conformance percentage.
export const AXE_RULE_WCAG_MAP = {
  'image-alt':             { criterion: '1.1.1', title: 'Non-text Content',              level: 'A'  },
  'bypass':                { criterion: '2.4.1', title: 'Bypass Blocks',                 level: 'A'  },
  'document-title':        { criterion: '2.4.2', title: 'Page Titled',                   level: 'A'  },
  'tabindex':              { criterion: '2.4.3', title: 'Focus Order',                   level: 'A'  },
  'html-has-lang':         { criterion: '3.1.1', title: 'Language of Page',              level: 'A'  },
  'label':                 { criterion: '3.3.2', title: 'Labels or Instructions',        level: 'A'  },
  'button-name':           { criterion: '4.1.2', title: 'Name, Role, Value',             level: 'A'  },
  'link-name':             { criterion: '4.1.2', title: 'Name, Role, Value',             level: 'A'  },
  'nested-interactive':    { criterion: '4.1.2', title: 'Name, Role, Value',             level: 'A'  },
  'aria-required-attr':    { criterion: '4.1.2', title: 'Name, Role, Value',             level: 'A'  },
  'aria-valid-attr':       { criterion: '4.1.2', title: 'Name, Role, Value',             level: 'A'  },
  'aria-roles':            { criterion: '4.1.2', title: 'Name, Role, Value',             level: 'A'  },
  'color-contrast':        { criterion: '1.4.3', title: 'Contrast (Minimum)',            level: 'AA' },
  'valid-lang':            { criterion: '3.1.2', title: 'Language of Parts',             level: 'AA' },
  // Best practices — reported, excluded from the WCAG percentage
  'heading-order':         { criterion: null, title: 'Heading levels increase by one' },
  'page-has-heading-one':  { criterion: null, title: 'Page has a level-one heading' },
  'landmark-one-main':     { criterion: null, title: 'Document has one main landmark' },
  'region':                { criterion: null, title: 'All content in landmarks' },
  'focus-order-semantics': { criterion: null, title: 'Focusable elements have sensible semantics' },
  // ── Full WCAG-tagged universe (axe-core 4.13, tags wcag2a/2aa/21a/21aa) ──
  // Primary criterion = first wcagNNN tag axe reports for the rule.
  'area-alt':                  { criterion: '2.4.4', title: 'Link Purpose (In Context)',        level: 'A'  },
  'aria-allowed-attr':         { criterion: '4.1.2', title: 'Name, Role, Value',             level: 'A'  },
  'aria-braille-equivalent':   { criterion: '4.1.2', title: 'Name, Role, Value',             level: 'A'  },
  'aria-command-name':         { criterion: '4.1.2', title: 'Name, Role, Value',             level: 'A'  },
  'aria-conditional-attr':     { criterion: '4.1.2', title: 'Name, Role, Value',             level: 'A'  },
  'aria-deprecated-role':      { criterion: '4.1.2', title: 'Name, Role, Value',             level: 'A'  },
  'aria-hidden-body':          { criterion: '1.3.1', title: 'Info and Relationships',        level: 'A'  },
  'aria-hidden-focus':         { criterion: '4.1.2', title: 'Name, Role, Value',             level: 'A'  },
  'aria-input-field-name':     { criterion: '4.1.2', title: 'Name, Role, Value',             level: 'A'  },
  'aria-meter-name':           { criterion: '1.1.1', title: 'Non-text Content',              level: 'A'  },
  'aria-progressbar-name':     { criterion: '1.1.1', title: 'Non-text Content',              level: 'A'  },
  'aria-prohibited-attr':      { criterion: '4.1.2', title: 'Name, Role, Value',             level: 'A'  },
  'aria-required-children':    { criterion: '1.3.1', title: 'Info and Relationships',        level: 'A'  },
  'aria-required-parent':      { criterion: '1.3.1', title: 'Info and Relationships',        level: 'A'  },
  'aria-roledescription':      { criterion: '4.1.2', title: 'Name, Role, Value',             level: 'A'  },
  'aria-tab-name':             { criterion: '4.1.2', title: 'Name, Role, Value',             level: 'A'  },
  'aria-toggle-field-name':    { criterion: '4.1.2', title: 'Name, Role, Value',             level: 'A'  },
  'aria-tooltip-name':         { criterion: '4.1.2', title: 'Name, Role, Value',             level: 'A'  },
  'aria-valid-attr-value':     { criterion: '4.1.2', title: 'Name, Role, Value',             level: 'A'  },
  'audio-caption':             { criterion: '1.2.1', title: 'Audio-only and Video-only (Prerecorded)', level: 'A' },
  'autocomplete-valid':        { criterion: '1.3.5', title: 'Identify Input Purpose',        level: 'AA' },
  'avoid-inline-spacing':      { criterion: '1.4.12', title: 'Text Spacing',                 level: 'AA' },
  'blink':                     { criterion: '2.2.2', title: 'Pause, Stop, Hide',             level: 'A'  },
  'definition-list':           { criterion: '1.3.1', title: 'Info and Relationships',        level: 'A'  },
  'dlitem':                    { criterion: '1.3.1', title: 'Info and Relationships',        level: 'A'  },
  'duplicate-id-aria':         { criterion: '4.1.2', title: 'Name, Role, Value',             level: 'A'  },
  'form-field-multiple-labels':{ criterion: '3.3.2', title: 'Labels or Instructions',        level: 'A'  },
  'frame-focusable-content':   { criterion: '2.1.1', title: 'Keyboard',                      level: 'A'  },
  'frame-title':               { criterion: '4.1.2', title: 'Name, Role, Value',             level: 'A'  },
  'frame-title-unique':        { criterion: '4.1.2', title: 'Name, Role, Value',             level: 'A'  },
  'html-lang-valid':           { criterion: '3.1.1', title: 'Language of Page',              level: 'A'  },
  'html-xml-lang-mismatch':    { criterion: '3.1.1', title: 'Language of Page',              level: 'A'  },
  'input-button-name':         { criterion: '4.1.2', title: 'Name, Role, Value',             level: 'A'  },
  'input-image-alt':           { criterion: '1.1.1', title: 'Non-text Content',              level: 'A'  },
  'label-content-name-mismatch': { criterion: '2.5.3', title: 'Label in Name',               level: 'A'  },
  'link-in-text-block':        { criterion: '1.4.1', title: 'Use of Color',                  level: 'A'  },
  'list':                      { criterion: '1.3.1', title: 'Info and Relationships',        level: 'A'  },
  'listitem':                  { criterion: '1.3.1', title: 'Info and Relationships',        level: 'A'  },
  'marquee':                   { criterion: '2.2.2', title: 'Pause, Stop, Hide',             level: 'A'  },
  'meta-refresh':              { criterion: '2.2.1', title: 'Timing Adjustable',             level: 'A'  },
  'meta-viewport':             { criterion: '1.4.4', title: 'Resize Text',                   level: 'AA' },
  'no-autoplay-audio':         { criterion: '1.4.2', title: 'Audio Control',                 level: 'A'  },
  'object-alt':                { criterion: '1.1.1', title: 'Non-text Content',              level: 'A'  },
  'p-as-heading':              { criterion: '1.3.1', title: 'Info and Relationships',        level: 'A'  },
  'role-img-alt':              { criterion: '1.1.1', title: 'Non-text Content',              level: 'A'  },
  'scrollable-region-focusable': { criterion: '2.1.1', title: 'Keyboard',                    level: 'A'  },
  'select-name':               { criterion: '4.1.2', title: 'Name, Role, Value',             level: 'A'  },
  'server-side-image-map':     { criterion: '2.1.1', title: 'Keyboard',                      level: 'A'  },
  'svg-img-alt':               { criterion: '1.1.1', title: 'Non-text Content',              level: 'A'  },
  'summary-name':              { criterion: '4.1.2', title: 'Name, Role, Value',             level: 'A'  },
  'table-fake-caption':        { criterion: '1.3.1', title: 'Info and Relationships',        level: 'A'  },
  'td-has-header':             { criterion: '1.3.1', title: 'Info and Relationships',        level: 'A'  },
  'td-headers-attr':           { criterion: '1.3.1', title: 'Info and Relationships',        level: 'A'  },
  'th-has-data-cells':         { criterion: '1.3.1', title: 'Info and Relationships',        level: 'A'  },
  'video-caption':             { criterion: '1.2.2', title: 'Captions (Prerecorded)',        level: 'A'  },
  'css-orientation-lock':      { criterion: '1.3.4', title: 'Orientation',                   level: 'AA' },
};

/**
 * The WCAG-tagged rule universe: every mapped axe rule that carries a WCAG
 * success criterion (i.e. tagged wcag2a/2aa/21a/21aa in axe-core). This is
 * the denominator for conformance claims.
 */
export const WCAG_AXE_RULE_UNIVERSE = Object.entries(AXE_RULE_WCAG_MAP)
  .filter(([, m]) => m.criterion)
  .map(([rule, m]) => ({ rule, criterion: m.criterion, level: m.level, title: m.title }));

const SEV_RANK = { info: 0, low: 1, medium: 2, serious: 2.5, high: 3, critical: 4 };

/**
 * Compute the WCAG conformance statement for a run.
 *
 * @param {object} run — a run object (findings + optional plan.a11yRules)
 * @returns {object} { conformancePct, criteria, blockers, levels, checkedCount,
 *                     violatedCount, partial, partialNote, universe }
 */
export function computeCompliance(run) {
  const findings = run?.findings || [];
  const a11yFindings = findings.filter(f =>
    typeof f.ruleId === 'string' && f.ruleId.startsWith('axe-') &&
    f.findingType !== 'informational' && f.findingType !== 'environmental' &&
    f.confidence !== 'suspected'
  );

  // Which axe rules actually ran? Prefer the plan (it reflects the rules
  // used for THIS run); fall back to the full default map.
  const ranRules = (run?.plan?.a11yRules || []).map(r => r.rule).filter(Boolean);
  const ruleIds = ranRules.length ? ranRules : Object.keys(AXE_RULE_WCAG_MAP);

  // Violated rules: axe rule ids with confirmed findings
  const violatedRules = new Map(); // ruleId (bare) → { worstSeverity, occurrences, pages }
  for (const f of a11yFindings) {
    const bare = f.ruleId.replace(/^axe-/, '');
    if (!AXE_RULE_WCAG_MAP[bare]) continue; // unknown rule — ignore
    const existing = violatedRules.get(bare);
    const occurrences = f.occurrences || 1;
    if (!existing) {
      violatedRules.set(bare, { worstSeverity: f.severity, occurrences, pages: new Set(f.affectedPages?.length ? f.affectedPages : [f.pageUrl].filter(Boolean)) });
    } else {
      existing.occurrences += occurrences;
      for (const p of (f.affectedPages?.length ? f.affectedPages : [f.pageUrl].filter(Boolean))) existing.pages.add(p);
      if ((SEV_RANK[f.severity] || 0) > (SEV_RANK[existing.worstSeverity] || 0)) existing.worstSeverity = f.severity;
    }
  }

  // Build per-criterion status for every mapped rule that ran
  const criteriaMap = new Map(); // criterion → entry
  const bestPractice = [];
  for (const ruleId of ruleIds) {
    const mapping = AXE_RULE_WCAG_MAP[ruleId];
    if (!mapping) continue;
    const violation = violatedRules.get(ruleId) || null;

    if (!mapping.criterion) {
      bestPractice.push({
        rule: ruleId,
        title: mapping.title,
        status: violation ? 'fail' : 'pass',
        severity: violation?.worstSeverity || null,
        occurrences: violation?.occurrences || 0,
      });
      continue;
    }

    if (!criteriaMap.has(mapping.criterion)) {
      criteriaMap.set(mapping.criterion, {
        criterion: mapping.criterion,
        title: mapping.title,
        level: mapping.level,
        rules: [],
        status: 'pass',
        severity: null,
        occurrences: 0,
        pages: new Set(),
      });
    }
    const entry = criteriaMap.get(mapping.criterion);
    entry.rules.push(ruleId);
    if (violation) {
      entry.status = 'fail';
      entry.occurrences += violation.occurrences;
      for (const p of violation.pages) entry.pages.add(p);
      if (!entry.severity || (SEV_RANK[violation.worstSeverity] || 0) > (SEV_RANK[entry.severity] || 0)) {
        entry.severity = violation.worstSeverity;
      }
    }
  }

  const criteria = Array.from(criteriaMap.values())
    .map(c => ({ ...c, pages: [...c.pages] }))
    .sort((a, b) => a.criterion.localeCompare(b.criterion));

  const levels = { A: { checked: 0, violated: 0 }, AA: { checked: 0, violated: 0 } };
  const blockers = [];
  for (const c of criteria) {
    levels[c.level].checked++;
    if (c.status === 'fail') {
      levels[c.level].violated++;
      if (c.severity === 'critical' || c.severity === 'serious' || c.severity === 'high') {
        blockers.push(c);
      }
    }
  }

  const checkedCount = levels.A.checked + levels.AA.checked;
  const violatedCount = levels.A.violated + levels.AA.violated;

  // ── Conformance over the FULL WCAG-tagged rule universe ─────────────
  // Denominator: every criterion covered by the universe (not just what the
  // plan executed). Criteria whose rules were never executed count as
  // not-covered and drag the percentage down — disclosed via partial/note.
  const universeRuleIds = WCAG_AXE_RULE_UNIVERSE.map(r => r.rule);
  const universeCriteriaTotal = new Set(WCAG_AXE_RULE_UNIVERSE.map(r => r.criterion)).size;
  const executedWcagRules = ruleIds.filter(id => AXE_RULE_WCAG_MAP[id]?.criterion);
  const executedCriteria = new Set(executedWcagRules.map(id => AXE_RULE_WCAG_MAP[id].criterion));
  const violatedCriteria = new Set(
    [...violatedRules.keys()]
      .map(id => AXE_RULE_WCAG_MAP[id]?.criterion)
      .filter(Boolean)
  );
  const passedCriteria = executedCriteria.size - [...violatedCriteria].filter(c => executedCriteria.has(c)).length;
  const notCoveredCriteria = universeCriteriaTotal - executedCriteria.size;
  const conformancePct = universeCriteriaTotal === 0
    ? 100
    : Math.round((passedCriteria / universeCriteriaTotal) * 100);

  const testedCriteria = executedCriteria.size;
  const automatedPassRate = testedCriteria === 0 ? null : Math.round((passedCriteria / testedCriteria) * 100);
  const universeCoverage = universeCriteriaTotal === 0 ? 0 : Math.round((testedCriteria / universeCriteriaTotal) * 100);

  // Partial when the run's executed rule set is smaller than the universe.
  const partial = ranRules.length > 0 && executedWcagRules.length < universeRuleIds.length;
  const partialNote = partial
    ? `Conformance is computed over the full WCAG 2.x A/AA axe-rule universe (${universeRuleIds.length} rules → ${universeCriteriaTotal} criteria), but only ${executedWcagRules.length} rule(s) were configured for this run (${executedCriteria.size}/${universeCriteriaTotal} criteria covered, ${notCoveredCriteria} not tested). The percentage reflects that coverage gap. ${AUTOMATED_LIMITATION}`
    : AUTOMATED_LIMITATION;

  const bpFailed = bestPractice.filter(b => b.status === 'fail');

  return {
    conformancePct,
    automatedPassRate,
    universeCoverage,
    checkedCount,
    violatedCount,
    levels: {
      A: { ...levels.A, pct: levels.A.checked ? Math.round(((levels.A.checked - levels.A.violated) / levels.A.checked) * 100) : 100 },
      AA: { ...levels.AA, pct: levels.AA.checked ? Math.round(((levels.AA.checked - levels.AA.violated) / levels.AA.checked) * 100) : 100 },
      bestPractice: { checked: bestPractice.length, violated: bpFailed.length },
    },
    criteria,
    bestPractice,
    blockers: blockers.map(b => ({ ...b, pages: [...b.pages] })),
    partial,
    partialNote,
    universe: {
      rulesTotal: universeRuleIds.length,
      criteriaTotal: universeCriteriaTotal,
      rulesExecuted: executedWcagRules.length,
      criteriaCovered: executedCriteria.size,
      criteriaNotCovered: notCoveredCriteria,
      coveragePct: universeCoverage,
      passRatePct: automatedPassRate,
    },
    // Honest limitation note — automated a11y testing catches only a subset
    limitation: AUTOMATED_LIMITATION,
  };
}

const AUTOMATED_LIMITATION = 'Automated testing covers a subset of WCAG criteria. Manual testing (keyboard, screen reader, cognition) is required for full conformance claims.';

/**
 * Build a WCAG evidence report for the dashboard:
 * every criterion in the universe with an explicit pass/fail/not-tested
 * status, the failures behind each fail, and the conformance summary.
 *
 * @param {object} run  — run object ({ findings, plan? })
 * @param {object} [opts] — { axeVersion?, now? }
 * @returns {{
 *   generatedAt: string,
 *   tool: { name: 'QualityPilot', versions: { node: string, axe: string|null } },
 *   criteria: Array<{ criterion, level, status: 'pass'|'fail'|'not-tested',
 *                     rules: string[], failures: Array<{ ruleId, help, nodes: string[] }> }>,
 *   summary: { passed, failed, notTested, conformancePct }
 * }}
 */
export function buildEvidenceReport(run, opts = {}) {
  const compliance = computeCompliance(run);

  // Confirmed a11y findings grouped by bare axe rule id
  const findingsByRule = new Map();
  for (const f of run?.findings || []) {
    if (typeof f.ruleId !== 'string' || !f.ruleId.startsWith('axe-')) continue;
    if (f.findingType === 'informational' || f.findingType === 'environmental') continue;
    if (f.confidence === 'suspected') continue;
    const bare = f.ruleId.replace(/^axe-/, '');
    if (!AXE_RULE_WCAG_MAP[bare]) continue;
    if (!findingsByRule.has(bare)) findingsByRule.set(bare, []);
    findingsByRule.get(bare).push(f);
  }

  // Which rules were executed for this run (defaults to the universe)?
  const ranRules = (run?.plan?.a11yRules || []).map(r => r.rule).filter(Boolean);
  const executedSet = new Set(ranRules.length ? ranRules : Object.keys(AXE_RULE_WCAG_MAP));

  // Group universe rules by criterion
  const byCriterion = new Map();
  for (const { rule, criterion, level, title } of WCAG_AXE_RULE_UNIVERSE) {
    if (!byCriterion.has(criterion)) {
      byCriterion.set(criterion, { criterion, level, title, rules: [] });
    }
    byCriterion.get(criterion).rules.push(rule);
  }

  const helpFromFinding = (f) => {
    // Finding titles look like: "a11y: <help> (<ruleId>)"
    const m = typeof f.title === 'string' ? f.title.match(/^a11y:\s*(.*?)\s*\(([a-z0-9-]+)\)$/i) : null;
    return m?.[1] || f.title || AXE_RULE_WCAG_MAP[f.ruleId?.replace(/^axe-/, '')]?.title || 'Accessibility violation';
  };
  const nodesFromFinding = (f) => {
    if (typeof f.selector === 'string' && f.selector.trim()) {
      return f.selector.split(';').map(s => s.trim()).filter(Boolean);
    }
    return [];
  };

  const criteria = [];
  for (const entry of byCriterion.values()) {
    const executedRules = entry.rules.filter(r => executedSet.has(r));
    const failures = [];
    let failed = false;
    for (const rule of entry.rules) {
      const ruleFindings = findingsByRule.get(rule);
      if (ruleFindings?.length) {
        failed = true;
        for (const f of ruleFindings) {
          failures.push({
            ruleId: rule,
            help: helpFromFinding(f),
            nodes: nodesFromFinding(f),
          });
        }
      }
    }
    criteria.push({
      criterion: entry.criterion,
      level: entry.level,
      status: failed ? 'fail' : (executedRules.length > 0 ? 'pass' : 'not-tested'),
      rules: entry.rules,
      failures,
    });
  }

  criteria.sort((a, b) => a.criterion.localeCompare(b.criterion));

  const passed = criteria.filter(c => c.status === 'pass').length;
  const failed = criteria.filter(c => c.status === 'fail').length;
  const notTested = criteria.filter(c => c.status === 'not-tested').length;

  return {
    generatedAt: opts.now || new Date().toISOString(),
    tool: {
      name: 'Testigator',
      versions: {
        node: process.version,
        axe: opts.axeVersion ?? run?.axeVersion ?? null,
      },
    },
    criteria,
    summary: {
      passed,
      failed,
      notTested,
      conformancePct: compliance.conformancePct,
      automatedPassRate: compliance.automatedPassRate,
      universeCoverage: compliance.universeCoverage,
    },
  };
}
