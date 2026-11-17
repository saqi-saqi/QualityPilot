/**
 * test/reporting-markdown.test.js — CI job-summary markdown (Phase 6).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toMarkdown } from '../src/reporting/markdown.js';

const run = {
  runId: 'run_matrix_test',
  url: 'https://example.com',
  score: 42,
  findings: [
    { title: 'Missing or invalid content-security-policy header', severity: 'high', ruleId: 'header-content-security-policy', pageUrl: 'https://example.com' },
    { title: 'a11y: Images must have alternative text', severity: 'critical', ruleId: 'axe-image-alt', pageUrl: 'https://example.com/article' },
    { title: 'Broken link | with pipe', severity: 'low', ruleId: 'link-broken', pageUrl: 'https://example.com/a|b' },
  ],
};

const diff = {
  baselineRunId: 'run_matrix_base',
  summary: '1 new, 2 resolved, 2 persistent finding(s) · score 40 → 42 (+2)',
  scoreDelta: 2,
  newFindings: [{ title: 'New CSP issue', severity: 'high', ruleId: 'header-content-security-policy', pageUrl: 'https://example.com/new-page' }],
  resolvedFindings: [{ title: 'Fixed thing', severity: 'low' }, { title: 'Fixed thing 2', severity: 'info' }],
  persistentFindings: [{ title: 'persistent' }, { title: 'persistent 2' }],
};

describe('toMarkdown', () => {
  it('renders header, verdict, severity table and top rules', () => {
    const md = toMarkdown(run, { gate: { failed: true, reason: 'FAIL: findings at or above medium severity threshold' } });
    assert.match(md, /^## QualityPilot QA gate — https:\/\/example\.com/m);
    assert.match(md, /\*\*❌ FAIL\*\* · score \*\*42\/100\*\* · 3 finding\(s\)/);
    assert.match(md, /\| Severity \| Count \|/);
    assert.match(md, /\| critical \| 1 \|/);
    assert.match(md, /\| high \| 1 \|/);
    assert.match(md, /\| low \| 1 \|/);
    assert.match(md, /### Top rules/);
    assert.match(md, /`axe-image-alt`/);
    assert.match(md, /run `run_matrix_test` · FAIL: findings at or above medium/);
  });

  it('marks PASS and omits the diff section without a baseline', () => {
    const md = toMarkdown({ ...run, findings: [] }, { gate: { failed: false, reason: 'PASS: gate satisfied' } });
    assert.match(md, /\*\*✅ PASS\*\*/);
    assert.doesNotMatch(md, /vs baseline/);
  });

  it('adds the baseline section with new findings', () => {
    const md = toMarkdown(run, { diff, gate: { failed: true, reason: 'FAIL: 1 new finding(s) vs baseline run_matrix_base' } });
    assert.match(md, /### vs baseline `run_matrix_base`/);
    assert.match(md, /\*\*1 new\*\* · 2 resolved · 2 persistent/);
    assert.match(md, /\| New finding \| Severity \| Page \|/);
    assert.match(md, /New CSP issue/);
  });

  it('escapes pipes in titles and URLs so tables do not break', () => {
    const md = toMarkdown(run, {
      diff: {
        ...diff,
        newFindings: [{ title: 'Broken link | with pipe', severity: 'low', ruleId: 'link-broken', pageUrl: 'https://example.com/a|b' }],
      },
    });
    assert.match(md, /Broken link \\\| with pipe/);
    assert.match(md, /a\\\|b/);
  });

  it('shows an em dash when the score is missing', () => {
    const md = toMarkdown({ ...run, score: null }, {});
    assert.match(md, /\*\*—\/100\*\*|score \*\*—\*\*/);
  });
});
