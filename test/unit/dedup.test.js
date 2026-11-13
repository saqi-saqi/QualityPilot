import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dedupFindings, getNodeSignature } from '../../src/matrix/matrixRunner.js';

describe('Unit Tests: Deduplication Logic (No Browser)', () => {
  it('merges two findings with identical ruleId, selector, and URL from different matrix cells into one with correct occurrence count', () => {
    const findingCell1 = {
      id: 'A11Y-001',
      title: 'Images must have alternate text',
      severity: 'medium',
      confidence: 'confirmed',
      category: 'accessibility',
      findingType: 'bug',
      ruleId: 'axe-image-alt',
      selector: '#hero-img',
      pageUrl: 'https://example.com/about',
      occurrences: 2,
      matrixCell: { cellId: 'chromium:desktop:anon' },
      affectedPages: ['https://example.com/about'],
    };

    const findingCell2 = {
      id: 'A11Y-002',
      title: 'Images must have alternate text',
      severity: 'critical', // more severe
      confidence: 'confirmed',
      category: 'accessibility',
      findingType: 'bug',
      ruleId: 'axe-image-alt',
      selector: '#hero-img',
      pageUrl: 'https://example.com/about',
      occurrences: 3,
      matrixCell: { cellId: 'firefox:mobile:user' },
      affectedPages: ['https://example.com/about'],
    };

    const merged = dedupFindings([findingCell1, findingCell2]);

    assert.equal(merged.length, 1, 'Two duplicate findings from different cells must merge into 1');
    const result = merged[0];
    assert.equal(result.ruleId, 'axe-image-alt');
    assert.equal(result.selector, '#hero-img');
    assert.equal(result.pageUrl, 'https://example.com/about');
    assert.equal(result.occurrences, 5, 'Occurrences must sum (2 + 3 = 5)');
    assert.equal(result.severity, 'critical', 'Severity must pick worst severity (critical > medium)');
    assert.deepEqual(
      result.matrixCells.sort(),
      ['chromium:desktop:anon', 'firefox:mobile:user'].sort(),
      'matrixCells must contain union of cell IDs'
    );
  });

  it('does NOT merge findings with identical ruleId but DIFFERENT selectors', () => {
    const f1 = {
      ruleId: 'axe-image-alt',
      selector: '#img-header',
      pageUrl: 'https://example.com/home',
      occurrences: 1,
    };
    const f2 = {
      ruleId: 'axe-image-alt',
      selector: '#img-footer',
      pageUrl: 'https://example.com/home',
      occurrences: 1,
    };

    const merged = dedupFindings([f1, f2]);
    assert.equal(merged.length, 2, 'Findings with different selectors must remain distinct');
  });

  it('does NOT merge findings with identical ruleId and selector but DIFFERENT URLs', () => {
    const f1 = {
      ruleId: 'axe-image-alt',
      selector: '#logo',
      pageUrl: 'https://example.com/page-1',
      occurrences: 1,
    };
    const f2 = {
      ruleId: 'axe-image-alt',
      selector: '#logo',
      pageUrl: 'https://example.com/page-2',
      occurrences: 1,
    };

    const merged = dedupFindings([f1, f2]);
    assert.equal(merged.length, 2, 'Findings on different URLs must not merge across pages');
  });

  it('normalizes URLs so tracking query parameters and fragments do not cause duplicate findings', () => {
    const f1 = {
      ruleId: 'axe-color-contrast',
      selector: 'button.submit',
      pageUrl: 'https://example.com/login?utm_source=newsletter&utm_medium=email#top',
      occurrences: 1,
    };
    const f2 = {
      ruleId: 'axe-color-contrast',
      selector: 'button.submit',
      pageUrl: 'https://example.com/login',
      occurrences: 1,
    };

    const merged = dedupFindings([f1, f2]);
    assert.equal(merged.length, 1, 'URLs differing only by tracking parameters/fragments should dedup');
    assert.equal(merged[0].occurrences, 2);
  });

  it('extracts stable node signature correctly from finding.selector, finding.target, or finding.evidence', () => {
    const fromSelector = { selector: 'div.header > nav' };
    assert.equal(getNodeSignature(fromSelector), 'div.header > nav');

    const fromTargetArray = { target: ['div#nav', 'ul.menu'] };
    assert.equal(getNodeSignature(fromTargetArray), 'div#nav ul.menu');

    const fromEvidence = { evidence: 'Target: input#search\nSome other log line\nTarget: span.icon' };
    assert.equal(getNodeSignature(fromEvidence), 'input#search; span.icon');
  });

  it('findings with no selector/target fall back to a hash of title + first 120 chars of evidence', () => {
    const f1 = { title: 'Broken link on checkout', evidence: 'GET https://example.com/pay returned 500' };
    const sig1 = getNodeSignature(f1);
    assert.ok(sig1 && sig1.length > 0, 'signature must never be empty-string anymore');

    // Same title + evidence → same signature (dedups across cells)
    const f1Clone = { title: 'Broken link on checkout', evidence: 'GET https://example.com/pay returned 500' };
    assert.equal(getNodeSignature(f1Clone), sig1);

    // Different title → different signature (no false merge)
    const f2 = { title: 'Different finding entirely', evidence: 'GET https://example.com/pay returned 500' };
    assert.notEqual(getNodeSignature(f2), sig1);

    // Evidence beyond 120 chars does not change the signature
    const f3 = { title: 'Broken link on checkout', evidence: `${'x'.repeat(500)}` };
    const f3Clone = { title: 'Broken link on checkout', evidence: `${'x'.repeat(120)}${'y'.repeat(380)}` };
    assert.equal(getNodeSignature(f3), getNodeSignature(f3Clone));
  });

  it('merges two no-selector findings that share title + evidence prefix across cells', () => {
    const f1 = {
      ruleId: 'e2e-flow-failed',
      title: 'Checkout flow failed at step 2',
      evidence: 'Timeout waiting for .cart',
      pageUrl: 'https://example.com/checkout',
      matrixCell: { cellId: 'chromium:desktop:anon' },
    };
    const f2 = {
      ruleId: 'e2e-flow-failed',
      title: 'Checkout flow failed at step 2',
      evidence: 'Timeout waiting for .cart',
      pageUrl: 'https://example.com/checkout',
      matrixCell: { cellId: 'firefox:mobile:anon' },
    };
    const merged = dedupFindings([f1, f2]);
    assert.equal(merged.length, 1, 'identical no-selector findings must merge');
    assert.equal(merged[0].occurrences, 2);
    assert.deepEqual(merged[0].matrixCells.sort(), ['chromium:desktop:anon', 'firefox:mobile:anon'].sort());
    // affectedPages seeded with the finding's own pageUrl even though the executor passed none
    assert.deepEqual(merged[0].affectedPages, ['https://example.com/checkout']);
  });

  it('does NOT merge no-selector findings that have different titles on the same page', () => {
    const f1 = { ruleId: 'gen', title: 'Issue A', evidence: '', pageUrl: 'https://example.com/x' };
    const f2 = { ruleId: 'gen', title: 'Issue B', evidence: '', pageUrl: 'https://example.com/x' };
    assert.equal(dedupFindings([f1, f2]).length, 2);
  });
});
