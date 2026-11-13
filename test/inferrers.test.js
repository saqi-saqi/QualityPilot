import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inferA11yRules } from '../src/explorer/a11yInferrer.js';
import { inferPerfBudgets } from '../src/explorer/perfInferrer.js';
import { inferVisualBaselines, inferViewports } from '../src/explorer/visualInferrer.js';
import { inferFuzzTargets } from '../src/explorer/fuzzInferrer.js';
import {
  computeCompliance,
  buildEvidenceReport,
  AXE_RULE_WCAG_MAP,
  WCAG_AXE_RULE_UNIVERSE,
} from '../src/services/compliance.js';

const samplePages = [
  {
    url: 'https://example.com/',
    title: 'Home',
    forms: 1,
    buttons: 3,
    inputs: 2,
    meta: { viewport: 'width=device-width, initial-scale=1' },
    imageDetails: [{ src: 'logo.png', alt: 'Logo' }],
    loadTime: 1200,
    apiCalls: [
      { method: 'GET', url: 'https://api.example.com/users/123', status: 200 },
      { method: 'POST', url: 'https://api.example.com/login', status: 200,
        requestBody: { email: 'a@b.com', password: 'x' } },
    ],
  },
  {
    url: 'https://example.com/about',
    title: 'About',
    forms: 0,
    buttons: 1,
    inputs: 0,
    meta: { viewport: 'width=device-width, initial-scale=1' },
    imageDetails: [],
    loadTime: 800,
    apiCalls: [],
  },
];

describe('a11yInferrer', () => {
  it('returns a non-empty list of axe-core rules', () => {
    const rules = inferA11yRules({ pages: samplePages });
    assert.ok(rules.length >= 15);
    assert.ok(rules.every(r => r.rule && r.level));
  });

  it('includes color-contrast + image-alt when images are present', () => {
    const rules = inferA11yRules({ pages: samplePages });
    const ruleNames = rules.map(r => r.rule);
    assert.ok(ruleNames.includes('color-contrast'));
    assert.ok(ruleNames.includes('image-alt'));
  });

  it('keeps label rule when forms are present', () => {
    const rules = inferA11yRules({ pages: samplePages });
    assert.ok(rules.some(r => r.rule === 'label'));
  });

  it('drops label rule when no forms are present anywhere', () => {
    const pages = [{ ...samplePages[0], forms: 0, inputs: 0 }];
    const rules = inferA11yRules({ pages });
    assert.ok(!rules.some(r => r.rule === 'label'));
  });

  it('drops image-alt rule when no images are present', () => {
    const pages = [{ ...samplePages[0], imageDetails: [] }];
    const rules = inferA11yRules({ pages });
    assert.ok(!rules.some(r => r.rule === 'image-alt'));
  });

  it('all rules have valid severity levels', () => {
    const rules = inferA11yRules({ pages: samplePages });
    const validLevels = ['minor', 'moderate', 'serious', 'critical'];
    assert.ok(rules.every(r => validLevels.includes(r.level)));
  });

  it('handles empty pages input', () => {
    const rules = inferA11yRules({ pages: [] });
    // Default rules minus image-alt + label (no images/forms)
    assert.ok(rules.length > 0);
    assert.ok(!rules.some(r => r.rule === 'image-alt'));
    assert.ok(!rules.some(r => r.rule === 'label'));
  });

  it('handles null pages input', () => {
    const rules = inferA11yRules({ pages: null });
    assert.ok(rules.length > 0);
  });

  it('defaults to the FULL wcag-tagged axe universe (not a fast subset)', async () => {
    const rules = inferA11yRules({ pages: samplePages });
    assert.ok(rules.length >= WCAG_AXE_RULE_UNIVERSE.length - 15, 'full universe (with content pruning) applied by default');
    const universeIds = new Set(WCAG_AXE_RULE_UNIVERSE.map(r => r.rule));
    assert.ok(rules.every(r => universeIds.has(r.rule)), 'every default rule maps to a WCAG criterion');
  });

  it('keeps the fast subset ONLY behind fast: true', async () => {
    const rules = inferA11yRules({ pages: samplePages, fast: true });
    assert.ok(rules.length > 0 && rules.length <= 10, 'fast subset is small');
    assert.ok(rules.some(r => r.rule === 'color-contrast'));
    assert.ok(!rules.some(r => r.rule === 'aria-hidden-focus'), 'fast subset is not the full universe');
  });
});

// ─── compliance: universe-based conformance + buildEvidenceReport ────

describe('compliance (wcag-universe conformance)', () => {
  function axeFinding(ruleId, { severity = 'critical', pageUrl = 'https://x.com/', selector = '#el' } = {}) {
    return {
      title: `a11y: ${(AXE_RULE_WCAG_MAP[ruleId] || {}).title || 'Problem'} (${ruleId})`,
      severity,
      confidence: 'confirmed',
      category: 'accessibility',
      findingType: 'bug',
      ruleId: `axe-${ruleId}`,
      pageUrl,
      selector,
      occurrences: 1,
      affectedPages: [pageUrl],
    };
  }

  it('computes conformance over the full universe even when the plan executed a subset', () => {
    const run = {
      findings: [],
      plan: { a11yRules: [{ rule: 'image-alt' }, { rule: 'label' }] },
    };
    const c = computeCompliance(run);
    assert.equal(c.partial, true, 'subset execution must be flagged partial');
    assert.match(c.partialNote, /universe/);
    assert.ok(c.universe.criteriaTotal > 10);
    assert.equal(c.conformancePct, Math.round((c.universe.criteriaCovered / c.universe.criteriaTotal) * 100));
  });

  it('marks partial:false when no plan is given (universe assumed executed)', () => {
    const c = computeCompliance({ findings: [] });
    assert.equal(c.partial, false);
    assert.equal(c.conformancePct, 100);
  });

  it('counts a violated executed criterion against the universe percentage', () => {
    const run = {
      findings: [axeFinding('image-alt')],
      plan: { a11yRules: [{ rule: 'image-alt' }] },
    };
    const c = computeCompliance(run);
    assert.equal(c.partial, true);
    assert.ok(c.conformancePct < 100);
    const crit = c.criteria.find(x => x.criterion === '1.1.1');
    assert.equal(crit.status, 'fail');
  });

  it('exposes automatedPassRate and universeCoverage distinctly', () => {
    const run = {
      findings: [],
      plan: { a11yRules: [{ rule: 'image-alt' }] },
    };
    const c = computeCompliance(run);
    assert.equal(c.automatedPassRate, 100);
    assert.ok(c.universeCoverage > 0 && c.universeCoverage < 100);
    assert.equal(c.universe.coveragePct, c.universeCoverage);
    assert.equal(c.universe.passRatePct, c.automatedPassRate);
  });
});

describe('buildEvidenceReport (dashboard evidence export)', () => {
  function axeFinding(ruleId, selector = '#el') {
    return {
      title: `a11y: ${(AXE_RULE_WCAG_MAP[ruleId] || {}).title || 'Problem'} (${ruleId})`,
      severity: 'critical',
      confidence: 'confirmed',
      findingType: 'bug',
      ruleId: `axe-${ruleId}`,
      pageUrl: 'https://x.com/',
      selector,
      occurrences: 1,
      affectedPages: ['https://x.com/'],
    };
  }

  it('emits the documented shape: generatedAt, tool, criteria[], summary', () => {
    const run = {
      findings: [axeFinding('image-alt', '#hero-img')],
      plan: { a11yRules: [{ rule: 'image-alt' }] },
    };
    const report = buildEvidenceReport(run, { axeVersion: '4.13.0', now: '2026-01-01T00:00:00.000Z' });

    assert.equal(report.generatedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(report.tool.name, 'TestFlow');
    assert.equal(report.tool.versions.node, process.version);
    assert.equal(report.tool.versions.axe, '4.13.0');

    assert.ok(Array.isArray(report.criteria) && report.criteria.length > 10, 'criteria cover the universe');
    for (const c of report.criteria) {
      assert.ok(['pass', 'fail', 'not-tested'].includes(c.status));
      assert.ok(['A', 'AA'].includes(c.level));
      assert.ok(Array.isArray(c.rules) && c.rules.length > 0);
      assert.ok(Array.isArray(c.failures));
    }

    const crit111 = report.criteria.find(c => c.criterion === '1.1.1');
    assert.equal(crit111.status, 'fail');
    assert.deepEqual(crit111.failures, [{ ruleId: 'image-alt', help: 'Non-text Content', nodes: ['#hero-img'] }]);

    assert.equal(typeof report.summary.passed, 'number');
    assert.equal(report.summary.failed >= 1, true);
    assert.equal(report.summary.passed + report.summary.failed + report.summary.notTested, report.criteria.length);
    assert.equal(typeof report.summary.conformancePct, 'number');
  });

  it('marks unexecuted criteria not-tested', () => {
    const run = { findings: [], plan: { a11yRules: [{ rule: 'image-alt' }] } };
    const report = buildEvidenceReport(run);
    const tested = report.criteria.filter(c => c.status !== 'not-tested');
    assert.equal(tested.length, 1, 'only 1.1.1 was executed');
    assert.equal(tested[0].criterion, '1.1.1');
    assert.equal(tested[0].status, 'pass');
  });

  it('ignores suspected/environmental findings (same policy as computeCompliance)', () => {
    const run = {
      findings: [{ ...axeFinding('image-alt'), confidence: 'suspected' }],
      plan: { a11yRules: [{ rule: 'image-alt' }] },
    };
    const report = buildEvidenceReport(run);
    assert.equal(report.criteria.find(c => c.criterion === '1.1.1').status, 'pass');
  });
});

describe('perfInferrer', () => {
  it('returns Core Web Vitals budgets by default', () => {
    const budgets = inferPerfBudgets({ pages: samplePages });
    const metrics = budgets.map(b => b.metric);
    assert.ok(metrics.includes('LCP'));
    assert.ok(metrics.includes('CLS'));
    assert.ok(metrics.includes('TBT'));
    assert.ok(metrics.includes('FCP'));
    assert.ok(metrics.includes('TTFB'));
  });

  it('sets sensible thresholds (LCP <= 2500)', () => {
    const budgets = inferPerfBudgets({ pages: samplePages });
    const lcp = budgets.find(b => b.metric === 'LCP');
    assert.ok(lcp.threshold <= 2500);
  });

  it('escalates TBT severity to high when a slow page is observed', () => {
    const slowPages = [{ ...samplePages[0], loadTime: 8000 }];
    const budgets = inferPerfBudgets({ pages: slowPages });
    const tbt = budgets.find(b => b.metric === 'TBT');
    assert.equal(tbt.severity, 'high');
  });

  it('keeps TBT at medium when pages are fast', () => {
    const fastPages = [{ ...samplePages[0], loadTime: 200 }];
    const budgets = inferPerfBudgets({ pages: fastPages });
    const tbt = budgets.find(b => b.metric === 'TBT');
    assert.equal(tbt.severity, 'medium');
  });

  it('handles empty pages', () => {
    const budgets = inferPerfBudgets({ pages: [] });
    assert.ok(budgets.length >= 5);  // defaults still apply
  });

  it('all budgets have valid severity', () => {
    const budgets = inferPerfBudgets({ pages: samplePages });
    const validSev = ['critical', 'high', 'medium', 'low', 'info'];
    assert.ok(budgets.every(b => validSev.includes(b.severity)));
  });
});

describe('visualInferrer — inferViewports', () => {
  it('returns desktop + mobile viewports when responsive meta is present', () => {
    const vps = inferViewports({ pages: samplePages });
    assert.equal(vps.length, 2);
    const names = vps.map(v => v.name);
    assert.ok(names.includes('desktop'));
    assert.ok(names.includes('mobile'));
  });

  it('returns only desktop when no responsive meta', () => {
    const pages = [{ ...samplePages[0], meta: { viewport: null } }];
    const vps = inferViewports({ pages });
    assert.equal(vps.length, 1);
    assert.equal(vps[0].name, 'desktop');
  });

  it('mobile viewport has isMobile + hasTouch flags', () => {
    const vps = inferViewports({ pages: samplePages });
    const mobile = vps.find(v => v.name === 'mobile');
    assert.equal(mobile.isMobile, true);
    assert.equal(mobile.hasTouch, true);
  });
});

describe('visualInferrer — inferVisualBaselines', () => {
  it('creates one baseline per page × viewport', () => {
    const vps = inferViewports({ pages: samplePages });
    const baselines = inferVisualBaselines({ pages: samplePages, viewports: vps });
    // 2 pages × 2 viewports = 4 baselines
    assert.equal(baselines.length, 4);
  });

  it('uses default 1% threshold', () => {
    const baselines = inferVisualBaselines({ pages: samplePages });
    assert.equal(baselines[0].threshold, 0.01);
  });

  it('defaults maskSelectors to empty array', () => {
    const baselines = inferVisualBaselines({ pages: samplePages });
    assert.deepEqual(baselines[0].maskSelectors, []);
  });

  it('handles empty pages', () => {
    const baselines = inferVisualBaselines({ pages: [] });
    assert.equal(baselines.length, 0);
  });
});

describe('fuzzInferrer', () => {
  it('creates a per-page fuzz target when inputs are present', () => {
    const targets = inferFuzzTargets({ pages: samplePages, endpoints: [] });
    // Only the first page has inputs (2 inputs)
    assert.ok(targets.length >= 1);
    const homeTarget = targets.find(t => t.pageUrl === 'https://example.com/');
    assert.ok(homeTarget);
    assert.equal(homeTarget.formSelector, 'form');
    assert.equal(homeTarget.fieldSelector, 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="password"]), textarea');
  });

  it('skips pages with zero inputs', () => {
    const targets = inferFuzzTargets({ pages: samplePages, endpoints: [] });
    // /about has 0 inputs — should NOT be in targets
    assert.ok(!targets.some(t => t.pageUrl === 'https://example.com/about'));
  });

  it('uses crawler input details for field-specific targets', () => {
    const targets = inferFuzzTargets({
      pages: [{
        url: 'https://example.com/sign-up',
        inputs: 1,
        inputDetails: [{
          selector: '#age', formSelector: '#sign-up', tag: 'input', type: 'number', disabled: false,
        }],
      }],
      endpoints: [],
    });
    assert.equal(targets.length, 1);
    assert.equal(targets[0].fieldSelector, '#age');
    assert.deepEqual(targets[0].generators, ['empty', 'numeric-overflow', 'negative', 'null-byte']);
  });

  it('creates per-field API fuzz targets when endpoints have requestSchemas', () => {
    const endpoints = [
      {
        method: 'POST',
        path: '/api/login',
        requestSchema: { email: 'string', password: 'string' },
      },
      {
        method: 'GET',
        path: '/api/users',
        requestSchema: null,
      },
    ];
    const targets = inferFuzzTargets({ pages: [], endpoints });
    // /api/login has 2 fields → 2 targets. /api/users has no body → 0.
    assert.equal(targets.length, 2);
    assert.ok(targets.every(t => t.apiEndpointRef === '/api/login'));
    assert.ok(targets.some(t => t.field === 'email'));
    assert.ok(targets.some(t => t.field === 'password'));
  });

  it('uses default generators (empty, oversize, unicode, sql, xss)', () => {
    const targets = inferFuzzTargets({ pages: samplePages, endpoints: [] });
    assert.deepEqual(targets[0].generators, ['empty', 'oversize', 'unicode', 'sql', 'xss']);
  });

  it('caps iterations at a reasonable number (≤ 50)', () => {
    const targets = inferFuzzTargets({ pages: samplePages, endpoints: [] });
    assert.ok(targets.every(t => t.iterations <= 50));
  });
});
