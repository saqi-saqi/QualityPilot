/**
 * test/reporting-html.test.js — Phase 10 standalone HTML report.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toHtml } from '../src/reporting/html.js';

const run = {
  runId: 'run_matrix_test',
  url: 'https://example.com',
  score: 42,
  timestamp: '2026-11-17T12:00:00.000Z',
  findings: [
    { title: 'Missing CSP', severity: 'high', ruleId: 'header-content-security-policy', pageUrl: 'https://example.com', occurrences: 3 },
    { title: 'XSS with <script> in title', severity: 'critical', ruleId: 'axe-image-alt', pageUrl: 'https://example.com/p' },
  ],
  compliance: { conformancePct: 87, checkedCount: 20, violatedCount: 2, partial: true },
};

describe('toHtml', () => {
  it('produces a standalone document: no scripts, no external assets', () => {
    const html = toHtml(run, {});
    assert.match(html, /^<!DOCTYPE html>/);
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /<link /i);
    assert.doesNotMatch(html, /src="https?:/i);
    assert.match(html, /<style>/);
  });

  it('renders the verdict, score, severity table and findings', () => {
    const html = toHtml(run, { gate: { failed: true, reason: 'FAIL: findings at or above medium severity threshold' } });
    assert.match(html, /❌ FAIL/);
    assert.match(html, /42\/100/);
    assert.match(html, /class="sev high">high</);
    assert.match(html, /Missing CSP/);
    assert.match(html, /WCAG conformance/);
    assert.match(html, /87% conformance/);
    assert.match(html, /partial coverage/);
  });

  it('escapes HTML in finding titles (XSS-in-report protection)', () => {
    const html = toHtml(run, {});
    assert.match(html, /XSS with &lt;script&gt; in title/);
    assert.doesNotMatch(html, /<script> in title/);
  });

  it('renders the baseline diff section and waived findings', () => {
    const waiverResult = {
      waived: [{ title: 'Waived finding', ruleId: 'header-strict-transport-security', pageUrl: 'https://example.com' }],
      warnings: ['EXPIRED WAIVER: stale'],
      kept: [],
    };
    const html = toHtml(run, {
      diff: {
        baselineRunId: 'run_base',
        summary: '1 new, 0 resolved, 1 persistent finding(s)',
        newFindings: [{ title: 'New thing', severity: 'medium', pageUrl: 'https://example.com/x' }],
        resolvedFindings: [],
        persistentFindings: [],
      },
      waiverResult,
    });
    assert.match(html, /Baseline diff — run_base/);
    assert.match(html, /New thing/);
    assert.match(html, /Waived \(1\)/);
    assert.match(html, /⚠ EXPIRED WAIVER/);
  });
});
