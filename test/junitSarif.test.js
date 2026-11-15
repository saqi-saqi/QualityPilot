import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toJUnitXml } from '../src/reporting/junit.js';
import { toSarif } from '../src/reporting/sarif.js';

// Fixture shaped like the run objects in test/report.test.js
const sampleRun = {
  runId: 'run_test_123',
  url: 'https://example.com',
  status: 'completed',
  startedAt: '2025-01-01T00:00:00.000Z',
  completedAt: '2025-01-01T00:01:00.000Z',
  options: { maxPages: 5, maxDepth: 2 },
  score: 78,
  pages: [{ url: 'https://example.com/' }],
  findings: [
    {
      id: 'LINK-001',
      title: 'Broken link',
      severity: 'high',
      confidence: 'confirmed',
      category: 'links',
      findingType: 'bug',
      ruleId: 'broken-link',
      pageUrl: 'https://example.com/',
      description: 'Returns 404',
      evidence: 'HTTP 404 on /missing',
      occurrences: 1,
      screenshot: null,
    },
    {
      id: 'A11Y-001',
      title: 'Low contrast text <script>alert("x")</script>',
      severity: 'medium',
      confidence: 'confirmed',
      category: 'accessibility',
      findingType: 'bug',
      ruleId: 'axe-color-contrast',
      pageUrl: 'https://example.com/pricing',
      description: "Contrast ratio 2.1 < 4.5 & fails WCAG AA",
      evidence: 'button.submit',
      occurrences: 2,
      screenshot: 'run_test_123_a11y.png',
    },
    {
      id: 'API-009',
      title: 'Contract drift (suspected)',
      severity: 'high',
      confidence: 'suspected',
      category: 'network',
      findingType: 'bug',
      ruleId: 'api-status-drift',
      pageUrl: 'https://example.com/api',
      description: 'Anonymous replay returned 401',
      occurrences: 1,
      screenshot: null,
    },
    {
      id: 'COV-001',
      title: 'Page load failed: https://example.com/slow',
      severity: 'info',
      confidence: 'high',
      category: 'Scan Coverage',
      findingType: 'coverage-failure',
      ruleId: 'page-load-failure',
      pageUrl: 'https://example.com/slow',
      description: 'Page failed to load (timeout)',
      occurrences: 1,
      screenshot: null,
    },
  ],
};

// Tiny tag-balance check: every opened tag is closed in the right order.
function assertXmlWellFormed(xml) {
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/, 'has XML declaration');
  const tags = xml.match(/<\/?[A-Za-z][A-Za-z0-9_-]*(\s[^>]*?)?(\/)?>/g) || [];
  const stack = [];
  for (const tag of tags) {
    if (tag.startsWith('<?') || tag.startsWith('<!')) continue;
    if (tag.endsWith('/>')) continue; // self-closing
    const name = tag.match(/^<\/?([A-Za-z][A-Za-z0-9_-]*)/)[1];
    if (tag.startsWith('</')) {
      const top = stack.pop();
      assert.equal(top, name, `tag <${top}> closed by </${name}>`);
    } else {
      stack.push(name);
    }
  }
  assert.deepEqual(stack, [], 'all tags closed');
}

// ─── toJUnitXml ──────────────────────────────────────────────────────

describe('toJUnitXml', () => {
  it('produces well-formed XML with a declaration and testsuites root', () => {
    const xml = toJUnitXml(sampleRun);
    assertXmlWellFormed(xml);
    assert.ok(xml.includes('<testsuites'));
    assert.ok(xml.includes('tests="4"'));
    assert.ok(xml.includes('failures="2"'));
    assert.ok(xml.includes('skipped="2"'));
  });

  it('creates one testsuite per category group', () => {
    const xml = toJUnitXml(sampleRun);
    assert.ok(xml.includes('<testsuite name="links"'));
    assert.ok(xml.includes('<testsuite name="accessibility"'));
    assert.ok(xml.includes('<testsuite name="network"'));
    assert.ok(xml.includes('<testsuite name="Scan Coverage"'));
  });

  it('names testcases after ruleId + pageUrl', () => {
    const xml = toJUnitXml(sampleRun);
    assert.ok(xml.includes('name="broken-link on https://example.com/"'));
    assert.ok(xml.includes('name="axe-color-contrast on https://example.com/pricing"'));
  });

  it('renders confirmed findings as <failure> with a severity attribute', () => {
    const xml = toJUnitXml(sampleRun);
    assert.ok(xml.includes('<failure message="Broken link" severity="high">'));
    assert.ok(xml.includes('severity="medium"'));
    assert.ok(xml.includes('Returns 404'));
  });

  it('renders suspected findings as <skipped type="suspected">', () => {
    const xml = toJUnitXml(sampleRun);
    assert.match(xml, /<skipped message="Contract drift \(suspected\)" type="suspected"\/>/);
  });

  it('renders coverage failures as <skipped type="coverage-failure">', () => {
    const xml = toJUnitXml(sampleRun);
    assert.match(xml, /<skipped message="Page load failed: https:\/\/example.com\/slow" type="coverage-failure"\/>/);
  });

  it('includes the score in a <properties> block per suite', () => {
    const xml = toJUnitXml(sampleRun);
    assert.match(xml, /<property name="score" value="78"\/>/);
    assert.match(xml, /<property name="runId" value="run_test_123"\/>/);
  });

  it('escapes <, >, &, quotes and apostrophes in messages', () => {
    const xml = toJUnitXml(sampleRun);
    assert.ok(!xml.includes('<script>'), 'raw script tag must not appear');
    assert.ok(xml.includes('&lt;script&gt;'), 'angle brackets escaped');
    assert.ok(!xml.includes('2.1 < 4.5'), 'raw < in text must not appear');
    assert.ok(xml.includes('2.1 &lt; 4.5 &amp; fails WCAG AA'));
  });

  it('handles empty findings gracefully', () => {
    const xml = toJUnitXml({ runId: 'r1', score: 100, findings: [] });
    assertXmlWellFormed(xml);
    assert.match(xml, /<testsuite name="qualitypilot" tests="0" failures="0" skipped="0"/);
  });

  it('handles null/undefined report', () => {
    const xml = toJUnitXml(null);
    assertXmlWellFormed(xml);
    assert.match(xml, /tests="0"/);
  });

  it('disambiguates duplicate ruleId+pageUrl testcase names', () => {
    const run = {
      runId: 'r2',
      findings: [
        { ruleId: 'dup', pageUrl: 'https://x.com/', severity: 'low', title: 'one', category: 'links' },
        { ruleId: 'dup', pageUrl: 'https://x.com/', severity: 'low', title: 'two', category: 'links' },
      ],
    };
    const xml = toJUnitXml(run);
    assert.ok(xml.includes('name="dup on https://x.com/"'));
    assert.ok(xml.includes('name="dup on https://x.com/ #2"'));
  });
});

// ─── toSarif ─────────────────────────────────────────────────────────

describe('toSarif', () => {
  it('emits the SARIF 2.1.0 envelope and QualityPilot driver', () => {
    const sarif = toSarif(sampleRun);
    assert.equal(sarif.version, '2.1.0');
    assert.equal(sarif.$schema, 'https://json.sarif.org/schema/2.1.0/sarif-schema.json');
    assert.equal(sarif.runs.length, 1);
    assert.equal(sarif.runs[0].tool.driver.name, 'QualityPilot');
    assert.equal(sarif.runs[0].tool.driver.informationUri, 'https://github.com/saqi-saqi/SQA_Agent');
  });

  it('maps every finding to a result with locations and fingerprints', () => {
    const sarif = toSarif(sampleRun);
    const results = sarif.runs[0].results;
    assert.equal(results.length, sampleRun.findings.length);

    const first = results[0];
    assert.equal(first.ruleId, 'broken-link');
    assert.equal(first.locations[0].physicalLocation.artifactLocation.uri, 'https://example.com/');
    assert.ok(first.partialFingerprints.signature, 'has a stable signature');
    assert.match(first.message.text, /Broken link/);
  });

  it('maps severity → level (critical/high→error, medium→warning, low/info→note)', () => {
    const sarif = toSarif({
      runId: 'r',
      findings: [
        { ruleId: 'a', severity: 'critical', title: 'A', pageUrl: 'https://x.com/' },
        { ruleId: 'b', severity: 'high', title: 'B', pageUrl: 'https://x.com/' },
        { ruleId: 'c', severity: 'medium', title: 'C', pageUrl: 'https://x.com/' },
        { ruleId: 'd', severity: 'low', title: 'D', pageUrl: 'https://x.com/' },
        { ruleId: 'e', severity: 'info', title: 'E', pageUrl: 'https://x.com/' },
      ],
    });
    const byRule = Object.fromEntries(sarif.runs[0].results.map((r) => [r.ruleId, r.level]));
    assert.equal(byRule.a, 'error');
    assert.equal(byRule.b, 'error');
    assert.equal(byRule.c, 'warning');
    assert.equal(byRule.d, 'note');
    assert.equal(byRule.e, 'note');
  });

  it('collects one rule entry per distinct ruleId', () => {
    const sarif = toSarif(sampleRun);
    const ruleIds = sarif.runs[0].tool.driver.rules.map((r) => r.id);
    assert.ok(ruleIds.includes('broken-link'));
    assert.ok(ruleIds.includes('axe-color-contrast'));
    assert.equal(new Set(ruleIds).size, ruleIds.length, 'rule ids are unique');
    const contrast = sarif.runs[0].tool.driver.rules.find((r) => r.id === 'axe-color-contrast');
    assert.equal(contrast.shortDescription.text, 'Low contrast text <script>alert("x")</script>');
  });

  it('uses the fine-grained signature for partialFingerprints', () => {
    const sarif = toSarif(sampleRun);
    const r = sarif.runs[0].results[1]; // axe-color-contrast
    assert.match(r.partialFingerprints.signature, /^axe-color-contrast::https:\/\/example\.com\/pricing::/);
  });

  it('serializes to JSON cleanly (JSON round-trip)', () => {
    const sarif = toSarif(sampleRun);
    const round = JSON.parse(JSON.stringify(sarif));
    assert.deepEqual(round, sarif);
  });

  it('omits locations when a finding has no pageUrl and tolerates null report', () => {
    const sarif = toSarif({ runId: 'r', findings: [{ ruleId: 'x', severity: 'low', title: 'X' }] });
    assert.equal(sarif.runs[0].results[0].locations, undefined);
    assert.equal(toSarif(null).runs[0].results.length, 0);
  });
});
