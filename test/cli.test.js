import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseArgs,
  evaluateGate,
  evaluateBaselineGate,
  loadBaselineRun,
  shouldFail,
  writeReportFiles,
} from '../src/cli/check.js';

// ─── parseArgs ───────────────────────────────────────────────────────

describe('check parseArgs', () => {
  it('keeps existing defaults for a bare URL', () => {
    const opts = parseArgs(['node', 'check', 'https://example.com']);
    assert.equal(opts.url, 'https://example.com');
    assert.equal(opts.failOn, 'none');
    assert.equal(opts.timeout, 120000);
    assert.equal(opts.maxPages, 10);
    assert.equal(opts.maxDepth, 1);
    assert.equal(opts.json, false);
    assert.equal(opts.strict, false);
    assert.equal(opts.minScore, null);
    assert.equal(opts.junitPath, null);
    assert.equal(opts.sarifPath, null);
    assert.equal(opts.format, null);
  });

  it('keeps existing flags working', () => {
    const opts = parseArgs([
      'node', 'check', 'https://example.com',
      '-f', 'medium', '-t', '5000', '-p', '3', '-d', '2', '--json', '--strict',
    ]);
    assert.equal(opts.failOn, 'medium');
    assert.equal(opts.timeout, 5000);
    assert.equal(opts.maxPages, 3);
    assert.equal(opts.maxDepth, 2);
    assert.equal(opts.json, true);
    assert.equal(opts.strict, true);
  });

  it('parses --fail-on as a comma list', () => {
    const opts = parseArgs(['node', 'check', 'https://x.com', '--fail-on', 'critical,high']);
    assert.equal(opts.failOn, 'critical,high');
    assert.deepEqual(opts.failOnParsed, { mode: 'list', severities: ['critical', 'high'] });
  });

  it('parses --fail-on as a single threshold', () => {
    const opts = parseArgs(['node', 'check', 'https://x.com', '--fail-on', 'high']);
    assert.deepEqual(opts.failOnParsed, { mode: 'threshold', value: 'high' });
  });

  it('rejects invalid --fail-on values (single and list items)', () => {
    assert.throws(() => parseArgs(['node', 'check', 'https://x.com', '--fail-on', 'bogus']), /Invalid --fail-on value/);
    assert.throws(() => parseArgs(['node', 'check', 'https://x.com', '--fail-on', 'critical,bogus']), /Invalid --fail-on severity: bogus/);
  });

  it('parses --min-score', () => {
    const opts = parseArgs(['node', 'check', 'https://x.com', '--min-score', '80']);
    assert.equal(opts.minScore, 80);
  });

  it('rejects invalid --min-score values', () => {
    assert.throws(() => parseArgs(['node', 'check', 'https://x.com', '--min-score', 'abc']), /Invalid --min-score/);
    assert.throws(() => parseArgs(['node', 'check', 'https://x.com', '--min-score', '180']), /Invalid --min-score/);
  });

  it('parses --junit and --sarif file paths', () => {
    const opts = parseArgs(['node', 'check', 'https://x.com', '--junit', 'out/junit.xml', '--sarif', 'out/res.sarif']);
    assert.equal(opts.junitPath, 'out/junit.xml');
    assert.equal(opts.sarifPath, 'out/res.sarif');
  });

  it('rejects --junit/--sarif without a path', () => {
    assert.throws(() => parseArgs(['node', 'check', 'https://x.com', '--junit']), /--junit requires a file path/);
    assert.throws(() => parseArgs(['node', 'check', 'https://x.com', '--sarif']), /--sarif requires a file path/);
  });

  it('parses --format and rejects unknown formats', () => {
    assert.equal(parseArgs(['node', 'check', 'https://x.com', '--format', 'sarif']).format, 'sarif');
    assert.equal(parseArgs(['node', 'check', 'https://x.com', '--format', 'junit']).format, 'junit');
    assert.equal(parseArgs(['node', 'check', 'https://x.com', '--format', 'json']).format, 'json');
    assert.equal(parseArgs(['node', 'check', 'https://x.com', '--format', 'text']).format, 'text');
    assert.throws(() => parseArgs(['node', 'check', 'https://x.com', '--format', 'xml']), /Invalid --format value/);
  });

  it('throws when the URL is missing', () => {
    assert.throws(() => parseArgs(['node', 'check']), /Usage:/);
  });
});

// ─── evaluateGate / shouldFail ───────────────────────────────────────

describe('check evaluateGate', () => {
  const findings = [
    { ruleId: 'r1', severity: 'critical', confidence: 'confirmed', title: 'C' },
    { ruleId: 'r2', severity: 'high', confidence: 'confirmed', title: 'H' },
    { ruleId: 'r3', severity: 'high', confidence: 'suspected', title: 'S' },
    { ruleId: 'r4', severity: 'low', confidence: 'confirmed', title: 'L' },
  ];

  it('passes with defaults (fail-on none, no min-score)', () => {
    const gate = evaluateGate({ findings, score: 40 });
    assert.equal(gate.failed, false);
    assert.equal(gate.exitCode, 0);
    assert.match(gate.reason, /^PASS/);
  });

  it('single-severity --fail-on keeps threshold semantics (at or above, any confidence)', () => {
    const gate = evaluateGate({ findings: [{ severity: 'medium', confidence: 'confirmed' }], failOn: 'medium' });
    assert.equal(gate.failed, true);
    assert.equal(gate.exitCode, 1);
    assert.match(gate.reason, /FAIL: findings at or above medium severity threshold/);
  });

  it('comma-list --fail-on fails on confirmed findings at listed severities', () => {
    const gate = evaluateGate({ findings, failOn: 'critical,high' });
    assert.equal(gate.failed, true);
    assert.equal(gate.exitCode, 1);
    assert.match(gate.reason, /FAIL: 2 confirmed finding\(s\) at severity critical, high/);
  });

  it('comma-list --fail-on ignores suspected findings', () => {
    const gate = evaluateGate({
      findings: [{ severity: 'high', confidence: 'suspected', title: 'S' }],
      failOn: 'critical,high',
    });
    assert.equal(gate.failed, false);
    assert.equal(gate.exitCode, 0);
  });

  it('comma-list --fail-on ignores severities outside the list', () => {
    const gate = evaluateGate({ findings: [{ severity: 'medium', confidence: 'confirmed' }], failOn: 'critical,high' });
    assert.equal(gate.failed, false);
  });

  it('treats missing confidence as confirmed in list mode', () => {
    const gate = evaluateGate({ findings: [{ severity: 'critical' }], failOn: 'critical' });
    assert.equal(gate.failed, true);
  });

  it('--min-score fails when the score is below the minimum', () => {
    const gate = evaluateGate({ findings: [], score: 62, minScore: 80 });
    assert.equal(gate.failed, true);
    assert.equal(gate.exitCode, 1);
    assert.match(gate.reason, /FAIL: score 62 is below the minimum 80/);
  });

  it('--min-score passes when the score meets the minimum', () => {
    const gate = evaluateGate({ findings: [], score: 80, minScore: 80 });
    assert.equal(gate.failed, false);
  });

  it('--min-score fails on a missing score (treated as 0)', () => {
    const gate = evaluateGate({ findings: [], score: null, minScore: 50 });
    assert.equal(gate.failed, true);
    assert.match(gate.reason, /below the minimum 50/);
  });

  it('formats float noise out of the gate reason (audit N-1)', () => {
    const pass = evaluateGate({ findings: [], score: 63.099999999999994 });
    assert.match(pass.reason, /score: 63\.1\)/, 'no 63.099999999999994 in the verdict line');
    const fail = evaluateGate({ findings: [], score: 63.099999999999994, minScore: 80 });
    assert.match(fail.reason, /FAIL: score 63\.1 is below the minimum 80/);
  });

  it('fail-on takes precedence over min-score when both fail', () => {
    const gate = evaluateGate({ findings: [{ severity: 'critical', confidence: 'confirmed' }], score: 10, failOn: 'critical,high', minScore: 90 });
    assert.equal(gate.failed, true);
    assert.match(gate.reason, /confirmed finding/);
  });

  it('shouldFail keeps threshold semantics and fixes severity ranking', () => {
    assert.equal(shouldFail([{ severity: 'medium' }], 'high'), false, 'medium is below high threshold');
    assert.equal(shouldFail([{ severity: 'critical' }], 'high'), true);
    assert.equal(shouldFail([{ severity: 'medium' }], 'none'), false);
    assert.equal(shouldFail([], 'high'), false);
  });

  it('threshold mode ignores environmental findings (Fix E3)', () => {
    assert.equal(
      shouldFail([{ severity: 'critical', confidence: 'suspected', findingType: 'environmental' }], 'critical'),
      false,
      'an environmental failure alone must not break a threshold gate',
    );
    const gate = evaluateGate({
      findings: [{ severity: 'critical', confidence: 'suspected', findingType: 'environmental' }],
      failOn: 'critical',
    });
    assert.equal(gate.failed, false);
    // A confirmed bug at the threshold still fails, even beside environmental noise.
    assert.equal(
      shouldFail([
        { severity: 'critical', findingType: 'environmental' },
        { severity: 'high', confidence: 'confirmed', findingType: 'bug' },
      ], 'high'),
      true,
    );
  });

  it('list mode still counts only confirmed findings (unchanged by Fix E3)', () => {
    const gate = evaluateGate({
      findings: [
        { severity: 'critical', confidence: 'suspected', findingType: 'environmental' },
        { severity: 'high', confidence: 'suspected' },
      ],
      failOn: 'critical,high',
    });
    assert.equal(gate.failed, false);
    const gate2 = evaluateGate({
      findings: [{ severity: 'critical', confidence: 'confirmed', findingType: 'bug' }],
      failOn: 'critical,high',
    });
    assert.equal(gate2.failed, true);
  });
});

// ─── report command (Phase 10) ───────────────────────────────────────

describe('testigator / legacy qualitypilot report command', () => {
  it('writes a standalone HTML report from a saved run JSON', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sqa-report-test-'));
    try {
      const runFile = path.join(dir, 'run.json');
      await import('node:fs/promises').then(fs => fs.writeFile(runFile, JSON.stringify({
        runId: 'run_report_test',
        url: 'https://example.com',
        score: 64,
        findings: [
          { title: 'Missing CSP', severity: 'high', ruleId: 'header-content-security-policy', pageUrl: 'https://example.com' },
          { title: 'A low thing', severity: 'low', ruleId: 'low-thing', pageUrl: 'https://example.com/x' },
        ],
      })));
      const htmlPath = path.join(dir, 'report.html');
      const router = fileURLToPath(new URL('../src/cli/testigator.js', import.meta.url));
      const res = spawnSync(process.execPath, [router, 'report', runFile, '--html', htmlPath, '--fail-on', 'medium'], { encoding: 'utf8', timeout: 30000 });
      assert.equal(res.status, 0, `report exited ${res.status}: ${res.stderr || res.stdout}`);
      const html = await import('node:fs/promises').then(fs => fs.readFile(htmlPath, 'utf8'));
      assert.match(html, /Testigator report/);
      // Legacy qualitypilot.js alias still executes cleanly
      const legacyRouter = fileURLToPath(new URL('../src/cli/qualitypilot.js', import.meta.url));
      const legacyRes = spawnSync(process.execPath, [legacyRouter, 'report', runFile, '--html', htmlPath, '--fail-on', 'medium'], { encoding: 'utf8', timeout: 30000 });
      assert.equal(legacyRes.status, 0);
      assert.match(html, /Missing CSP/);
      assert.doesNotMatch(html, /<script/i, 'standalone: no scripts');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exits 64 with usage when given an unknown flag', () => {
    const router = fileURLToPath(new URL('../src/cli/qualitypilot.js', import.meta.url));
    const res = spawnSync(process.execPath, [router, 'report', 'x.json', '--bogus'], { encoding: 'utf8', timeout: 30000 });
    assert.equal(res.status, 64);
    assert.match(`${res.stderr || ''}${res.stdout || ''}`, /Unknown argument/);
  });
});

// ─── direct CLI entry (smoke-run regression, 2026-11-14) ─────────────

describe('check CLI entry point', () => {
  it('executes when run directly — missing URL exits non-zero with usage (was silent exit 0)', () => {
    const script = fileURLToPath(new URL('../src/cli/check.js', import.meta.url));
    const res = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 30000 });
    assert.notEqual(res.status, 0, 'direct invocation must not silently exit 0 without doing anything');
    assert.match(`${res.stderr || ''}${res.stdout || ''}`, /Usage/i);
  });

  it('a failed scan exits 70 and surfaces the reason (first-run regression, 2026-11-14)', () => {
    const script = fileURLToPath(new URL('../src/cli/check.js', import.meta.url));
    const res = spawnSync(process.execPath, [script, 'http://127.0.0.1:9', '--max-pages', '1', '--timeout', '8000'], {
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, SQA_ALLOW_PRIVATE: 'true', ALLOW_PRIVATE_HOSTS: 'true' },
    });
    // Port 9 (discard protocol) refuses connections → the crawl fails → the
    // run is marked failed → the CLI must exit 70, never 0.
    assert.equal(res.status, 70, `failed scan must exit 70 (got ${res.status}); stdout: ${(res.stdout || '').slice(0, 300)}`);
    assert.match(`${res.stderr || ''}${res.stdout || ''}`, /scan failed/i);
  });
});

// ─── writeReportFiles (tmp artifacts) ────────────────────────────────

describe('check writeReportFiles', () => {
  const run = {
    runId: 'run_artifact_1',
    url: 'https://example.com',
    score: 91,
    findings: [{
      id: 'LINK-001', ruleId: 'broken-link', severity: 'high', confidence: 'confirmed',
      category: 'links', title: 'Broken link <&>', pageUrl: 'https://example.com/x',
      description: 'desc', evidence: 'ev', occurrences: 1,
    }],
  };

  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sqa-cli-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes JUnit XML when --junit is given', async () => {
    const junitPath = path.join(dir, 'junit.xml');
    const written = await writeReportFiles(run, { junitPath });
    assert.deepEqual(written, [junitPath]);

    const xml = await readFile(junitPath, 'utf8');
    assert.match(xml, /<testsuites name="SQA run run_artifact_1"/);
    assert.match(xml, /<failure message="Broken link &lt;&amp;&gt;" severity="high">/);
    assert.match(xml, /<property name="score" value="91"\/>/);
  });

  it('writes SARIF JSON when --sarif is given', async () => {
    const sarifPath = path.join(dir, 'out.sarif');
    const written = await writeReportFiles(run, { sarifPath });
    assert.deepEqual(written, [sarifPath]);

    const sarif = JSON.parse(await readFile(sarifPath, 'utf8'));
    assert.equal(sarif.version, '2.1.0');
    assert.equal(sarif.runs[0].results[0].ruleId, 'broken-link');
    assert.equal(sarif.runs[0].results[0].level, 'error');
  });

  it('writes both and skips the ones not requested', async () => {
    const junitPath = path.join(dir, 'junit.xml');
    const written = await writeReportFiles(run, { junitPath, sarifPath: null });
    assert.deepEqual(written, [junitPath]);

    const both = await writeReportFiles(run, {
      junitPath: path.join(dir, 'a.xml'),
      sarifPath: path.join(dir, 'b.json'),
    });
    assert.equal(both.length, 2);
    assert.equal(await readFile(path.join(dir, 'a.xml'), 'utf8').then((s) => s.includes('<?xml')), true);
    assert.equal(await readFile(path.join(dir, 'b.json'), 'utf8').then((s) => s.includes('"2.1.0"')), true);
  });

  it('is a no-op when neither artifact is requested', async () => {
    assert.deepEqual(await writeReportFiles(run, {}), []);
  });
});

// ─── --baseline parsing + diff gate (Phase 6) ────────────────────────

describe('check parseArgs — baseline and markdown', () => {
  it('parses --baseline with a file path', () => {
    const opts = parseArgs(['node', 'check', 'https://example.com', '--baseline', 'prev.json']);
    assert.equal(opts.baseline, 'prev.json');
  });

  it('accepts --format markdown', () => {
    const opts = parseArgs(['node', 'check', 'https://example.com', '--format', 'markdown']);
    assert.equal(opts.format, 'markdown');
  });

  it('rejects --baseline without a value', () => {
    assert.throws(
      () => parseArgs(['node', 'check', 'https://example.com', '--baseline']),
      /--baseline requires/,
    );
  });

  it('defaults --concurrency to 2 and accepts 1–4', () => {
    const opts = parseArgs(['node', 'check', 'https://example.com']);
    assert.equal(opts.concurrency, 2);
    assert.equal(parseArgs(['node', 'check', 'https://example.com', '--concurrency', '4']).concurrency, 4);
    assert.equal(parseArgs(['node', 'check', 'https://example.com', '--concurrency', '1']).concurrency, 1);
  });

  it('rejects --concurrency outside 1–4', () => {
    assert.throws(
      () => parseArgs(['node', 'check', 'https://example.com', '--concurrency', '8']),
      /must be a number between 1 and 4/,
    );
    assert.throws(
      () => parseArgs(['node', 'check', 'https://example.com', '--concurrency', '0']),
      /must be a number between 1 and 4/,
    );
  });
});

describe('loadBaselineRun', () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sqa-baseline-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads a JSON report file with findings', async () => {
    const file = path.join(dir, 'baseline.json');
    await import('node:fs/promises').then(fs => fs.writeFile(file, JSON.stringify({ runId: 'run_prev', findings: [{ ruleId: 'x' }] })));
    const baseline = await loadBaselineRun(file);
    assert.equal(baseline.runId, 'run_prev');
    assert.equal(baseline.findings.length, 1);
  });

  it('throws a clear error on invalid JSON', async () => {
    const file = path.join(dir, 'broken.json');
    await import('node:fs/promises').then(fs => fs.writeFile(file, '{not json'));
    await assert.rejects(() => loadBaselineRun(file), /not valid JSON/);
  });

  it('throws when the JSON has no findings array', async () => {
    const file = path.join(dir, 'shape.json');
    await import('node:fs/promises').then(fs => fs.writeFile(file, JSON.stringify({ runId: 'x' })));
    await assert.rejects(() => loadBaselineRun(file), /no findings array/);
  });

  it('tolerates mixed CLI output (progress lines around the JSON document)', async () => {
    const file = path.join(dir, 'mixed.json');
    const report = JSON.stringify({ runId: 'run_prev_mixed', findings: [{ ruleId: 'x' }] }, null, 2);
    const mixed = [
      'QualityPilot CI check — https://example.com',
      'Scanning https://example.com (run run_prev_mixed)...',
      '{"timestamp":"...","level":"info","message":"Crawling finished."}',
      report,
      'PASS: gate satisfied (fail-on: none)',
      '',
    ].join('\n');
    await import('node:fs/promises').then(fs => fs.writeFile(file, mixed));
    const baseline = await loadBaselineRun(file);
    assert.equal(baseline.runId, 'run_prev_mixed');
  });

  it('throws when the output contains no JSON document at all', async () => {
    const file = path.join(dir, 'empty.json');
    await import('node:fs/promises').then(fs => fs.writeFile(file, 'Scanning...\nCrawling finished.\n'));
    await assert.rejects(() => loadBaselineRun(file), /not valid JSON/);
  });
});

describe('evaluateBaselineGate', () => {
  const diff = (newFindings, extra = {}) => ({
    baselineRunId: 'run_base',
    summary: `${newFindings.length} new, 0 resolved, 2 persistent finding(s)`,
    newFindings,
    resolvedFindings: [],
    persistentFindings: [
      { ruleId: 'header-content-security-policy', severity: 'high', pageUrl: 'https://example.com' },
      { ruleId: 'header-referrer-policy', severity: 'low', pageUrl: 'https://example.com' },
    ],
    scoreDelta: 0,
    ...extra,
  });

  it('passes under --fail-on low when every finding is pre-existing', () => {
    const gate = evaluateBaselineGate({
      findings: [{ severity: 'low', ruleId: 'header-referrer-policy' }],
      score: 50,
      failOn: 'low',
      diff: diff([]),
    });
    assert.equal(gate.failed, false);
    assert.match(gate.reason, /baseline run_base/);
  });

  it('fails when a new finding crosses the threshold', () => {
    const gate = evaluateBaselineGate({
      findings: [],
      score: 50,
      failOn: 'medium',
      diff: diff([{ severity: 'medium', ruleId: 'new-thing', pageUrl: 'https://example.com/x' }]),
    });
    assert.equal(gate.failed, true);
    assert.match(gate.reason, /^FAIL: 1 new finding\(s\) vs baseline run_base/);
  });

  it('ignores pre-existing findings above the threshold', () => {
    const gate = evaluateBaselineGate({
      findings: [{ severity: 'critical', ruleId: 'old-critical' }],
      score: 10,
      failOn: 'critical',
      diff: diff([], { summary: '0 new, 0 resolved, 1 persistent finding(s)' }),
    });
    assert.equal(gate.failed, false);
  });

  it('still enforces --min-score absolutely when a baseline is present', () => {
    const gate = evaluateBaselineGate({
      findings: [],
      score: 50,
      failOn: 'none',
      minScore: 80,
      diff: diff([]),
    });
    assert.equal(gate.failed, true);
    assert.match(gate.reason, /below the minimum/);
  });

  it('behaves exactly like evaluateGate without a baseline', () => {
    const findings = [{ severity: 'low', ruleId: 'x' }];
    const base = evaluateGate({ findings, score: 50, failOn: 'low' });
    const withNull = evaluateBaselineGate({ findings, score: 50, failOn: 'low', diff: null });
    assert.equal(withNull.failed, base.failed);
    assert.equal(withNull.exitCode, base.exitCode);
    assert.equal(withNull.reason, base.reason);
  });
});

describe('check parseArgs — positional URL handling (audit H-3 regressions)', () => {
  it('accepts flags BEFORE the URL (used to take the flag value as the URL)', () => {
    const opts = parseArgs(['node', 'check', '--fail-on', 'high', 'https://x.com']);
    assert.equal(opts.url, 'https://x.com');
    assert.equal(opts.failOn, 'high');
  });

  it('rejects unknown flags instead of silently ignoring them', () => {
    assert.throws(() => parseArgs(['node', 'check', 'https://x.com', '--failon', 'high']), /Unknown option: --failon/);
  });

  it('rejects extra positional arguments', () => {
    assert.throws(() => parseArgs(['node', 'check', 'https://x.com', 'extra']), /Unexpected argument: extra/);
  });

  it('rejects non-positive --timeout values', () => {
    assert.throws(() => parseArgs(['node', 'check', 'https://x.com', '--timeout', '0']), /Invalid --timeout/);
  });

  it('parses --allow-private (default off)', () => {
    assert.equal(parseArgs(['node', 'check', 'https://x.com', '--allow-private']).allowPrivate, true);
    assert.equal(parseArgs(['node', 'check', 'https://x.com']).allowPrivate, false);
  });
});
