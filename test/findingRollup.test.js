/**
 * test/findingRollup.test.js — cross-page rollup utility + a11y document-scope
 * predicate (Phase 6).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rollupAcrossPages } from '../src/services/findingRollup.js';
import { createFindingFactory } from '../src/services/findingFactory.js';
import { isDocumentScopedAxeFinding, DOCUMENT_SCOPED_AXE_RULES } from '../src/executors/a11yDeep.js';

const makeFinding = createFindingFactory();

function headerFinding(ruleId, pageUrl, overrides = {}) {
  return makeFinding({
    title: `Missing ${ruleId}`,
    severity: 'high',
    category: 'network',
    ruleId,
    pageUrl,
    ...overrides,
  });
}

describe('rollupAcrossPages', () => {
  it('merges same rule across pages of one origin: occurrences summed, pages unioned, stable pageUrl', () => {
    const findings = [
      headerFinding('header-content-security-policy', 'https://example.com/about'),
      headerFinding('header-content-security-policy', 'https://example.com/'),
      headerFinding('header-content-security-policy', 'https://example.com/pricing'),
    ];
    const rolled = rollupAcrossPages(findings, f => f.ruleId === 'header-content-security-policy');
    assert.equal(rolled.length, 1);
    assert.equal(rolled[0].occurrences, 3);
    assert.deepEqual([...rolled[0].affectedPages].sort(), [
      'https://example.com/',
      'https://example.com/about',
      'https://example.com/pricing',
    ]);
    assert.equal(rolled[0].pageUrl, 'https://example.com/');
  });

  it('keeps different rules separate and preserves non-matching findings untouched', () => {
    const findings = [
      headerFinding('header-content-security-policy', 'https://example.com/a'),
      headerFinding('header-referrer-policy', 'https://example.com/a'),
      headerFinding('mixed-content-active', 'https://example.com/a'),
      headerFinding('mixed-content-active', 'https://example.com/b'),
    ];
    const rolled = rollupAcrossPages(findings, f => f.ruleId.startsWith('header-'));
    assert.equal(rolled.length, 4);
    // mixed content untouched (two findings, distinct pageUrls)
    assert.equal(rolled.filter(f => f.ruleId === 'mixed-content-active').length, 2);
  });

  it('does not merge the same rule across different origins', () => {
    const findings = [
      headerFinding('header-content-security-policy', 'https://a.example.com/'),
      headerFinding('header-content-security-policy', 'https://b.example.com/'),
    ];
    const rolled = rollupAcrossPages(findings, () => true);
    assert.equal(rolled.length, 2);
  });

  it('keeps the worst severity inside a merged group', () => {
    const findings = [
      headerFinding('header-x-frame-options', 'https://example.com/a', { severity: 'medium' }),
      headerFinding('header-x-frame-options', 'https://example.com/b', { severity: 'high' }),
    ];
    const rolled = rollupAcrossPages(findings, () => true);
    assert.equal(rolled[0].severity, 'high');
  });

  it('passes findings without pageUrl or ruleId through untouched', () => {
    const noPage = makeFinding({ title: 'Environment', severity: 'info', category: 'network', ruleId: null, pageUrl: null });
    const noRule = makeFinding({ title: 'Mystery', severity: 'low', category: 'network', pageUrl: 'https://example.com/x' });
    const rolled = rollupAcrossPages([noPage, noRule], () => true);
    assert.equal(rolled.length, 2);
    assert.equal(rolled[0], noPage);
  });

  it('is a pure function — inputs are not mutated', () => {
    const a = headerFinding('header-content-security-policy', 'https://example.com/a');
    const before = JSON.parse(JSON.stringify(a));
    rollupAcrossPages([a, headerFinding('header-content-security-policy', 'https://example.com/b')], () => true);
    assert.deepEqual(JSON.parse(JSON.stringify(a)), before);
  });

  it('returns a new array for empty input and throws without a predicate', () => {
    assert.deepEqual(rollupAcrossPages([], () => true), []);
    assert.deepEqual(rollupAcrossPages(null, () => true), []);
    assert.throws(() => rollupAcrossPages([headerFinding('x', 'https://e.com/')], null), /shouldRollup/);
  });
});

describe('a11y document-scoped rollup', () => {
  it('predicate matches only document-scoped axe rules', () => {
    assert.equal(isDocumentScopedAxeFinding({ ruleId: 'axe-html-has-lang' }), true);
    assert.equal(isDocumentScopedAxeFinding({ ruleId: 'axe-document-title' }), true);
    assert.equal(isDocumentScopedAxeFinding({ ruleId: 'axe-image-alt' }), false);
    assert.equal(isDocumentScopedAxeFinding({ ruleId: 'header-content-security-policy' }), false);
    assert.equal(isDocumentScopedAxeFinding({ ruleId: null }), false);
    assert.ok(DOCUMENT_SCOPED_AXE_RULES.has('html-has-lang'));
    assert.ok(!DOCUMENT_SCOPED_AXE_RULES.has('color-contrast'));
  });

  it('rolls <html lang> up across pages but keeps image-alt page-scoped', () => {
    const findings = [
      makeFinding({ title: 'a11y: html-has-lang', severity: 'serious', category: 'accessibility', ruleId: 'axe-html-has-lang', pageUrl: 'https://c.example.com/', occurrences: 1 }),
      makeFinding({ title: 'a11y: html-has-lang', severity: 'serious', category: 'accessibility', ruleId: 'axe-html-has-lang', pageUrl: 'https://c.example.com/login', occurrences: 1 }),
      makeFinding({ title: 'a11y: html-has-lang', severity: 'serious', category: 'accessibility', ruleId: 'axe-html-has-lang', pageUrl: 'https://c.example.com/register', occurrences: 1 }),
      makeFinding({ title: 'a11y: image-alt', severity: 'critical', category: 'accessibility', ruleId: 'axe-image-alt', pageUrl: 'https://c.example.com/', occurrences: 4 }),
    ];
    const rolled = rollupAcrossPages(findings, isDocumentScopedAxeFinding);
    const lang = rolled.filter(f => f.ruleId === 'axe-html-has-lang');
    assert.equal(lang.length, 1);
    assert.equal(lang[0].occurrences, 3);
    assert.equal(lang[0].affectedPages.length, 3);
    const imgs = rolled.filter(f => f.ruleId === 'axe-image-alt');
    assert.equal(imgs.length, 1);
    assert.equal(imgs[0].occurrences, 4, 'node count preserved for page-scoped rules');
  });
});
