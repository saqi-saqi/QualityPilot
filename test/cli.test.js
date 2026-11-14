import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseArgs,
  evaluateGate,
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
