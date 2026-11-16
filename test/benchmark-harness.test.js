/**
 * test/benchmark-harness.test.js — pure-function coverage for the Phase F
 * recall harness (benchmark/run-recall-benchmark.mjs).
 *
 * The harness module must be import-safe: importing it must NOT launch a scan
 * (regression 2026-11-16 — an import triggered main() and started a real
 * 15-minute scan).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { extractJson, scoreReport } = await import(
  pathToFileURL(path.join(root, 'benchmark', 'run-recall-benchmark.mjs')).href
);

const groundtruth = JSON.parse(
  readFileSync(path.join(root, 'benchmark', 'groundtruth-juiceshop.json'), 'utf8')
);

describe('benchmark harness extractJson', () => {
  it('extracts the JSON document from mixed CLI stdout (progress lines before, gate line after)', () => {
    const raw = [
      'QualityPilot CI check — http://localhost:3000',
      '◇ injected env (36) from .env',
      '{"timestamp":"2026-11-16T05:02:58.159Z","level":"info","message":"JobQueue: recovered 0/1"}',
      'Scanning http://localhost:3000 (run run_matrix_x)...',
      '{"timestamp":"...","level":"info","message":"Crawling finished. Deduplicated 46 URLs."}',
      '{',
      '  "url": "http://localhost:3000",',
      '  "runId": "run_matrix_x",',
      '  "score": 88,',
      '  "status": "completed",',
      '  "findings": [{"title": "brace in string { not a boundary", "severity": "low"}],',
      '  "compliance": null,',
      '  "threshold": "none",',
      '  "minScore": null,',
      '  "failed": false,',
      '  "timestamp": "2026-11-16T05:22:54.991Z"',
      '}',
      'PASS: gate satisfied (fail-on: none, min-score: none, score: 88)',
      '',
    ].join('\n');
    const parsed = extractJson(raw);
    assert.equal(parsed.runId, 'run_matrix_x');
    assert.equal(parsed.score, 88);
    assert.equal(parsed.findings[0].title.includes('{'), true);
  });

  it('extracts a real saved scan artifact (js-post-fix.json: pre-JSON log lines + full document)', () => {
    const raw = readFileSync(path.join(root, 'benchmark', 'results', 'js-post-fix.json'), 'utf8');
    const parsed = extractJson(raw);
    assert.match(parsed.runId, /^run_matrix_/);
    assert.equal(parsed.status, 'running'); // pre-fix artifact captured mid-run
  });

  it('throws a clear error when stdout has no JSON document', () => {
    assert.throws(() => extractJson('Scanning...\nCrawling finished.\n'), /No JSON document/);
  });

  it('throws a clear error when the JSON document is truncated', () => {
    assert.throws(() => extractJson('log line\n{\n  "url": "http://x"\n'), /truncated/);
  });
});

describe('benchmark harness scoreReport', () => {
  const liveChecks = Object.fromEntries(groundtruth.expected.map((e) => [e.id, { holds: true }]));

  it('scores full recall when every expected rule is reported, and never counts observational findings', () => {
    const report = {
      status: 'completed',
      runId: 't',
      findings: groundtruth.expected.map((e, i) => ({ ruleId: e.ruleId, severity: e.severity, pageUrl: `p${i}` })),
    };
    const r = scoreReport({ report, groundtruth, liveChecks });
    assert.equal(r.recall, 1);
    assert.equal(r.missed.length, 0);
    assert.equal(r.fpHits.length, 0);
    assert.equal(r.observational.length, 0);
  });

  it('counts recall on DISTINCT ruleIds, not per-page duplicates', () => {
    const report = {
      status: 'completed',
      runId: 't',
      findings: groundtruth.expected.flatMap((e) => [
        { ruleId: e.ruleId, pageUrl: 'http://x/1' },
        { ruleId: e.ruleId, pageUrl: 'http://x/2' },
      ]),
    };
    const r = scoreReport({ report, groundtruth, liveChecks });
    assert.equal(r.recall, 1);
  });

  it('flags must-not-find rules as false-positive guard hits', () => {
    const report = {
      status: 'completed',
      runId: 't',
      findings: [
        ...groundtruth.expected.map((e) => ({ ruleId: e.ruleId })),
        { ruleId: 'header-strict-transport-security', severity: 'high' }, // must NOT fire on HTTP target
        { ruleId: 'console-error', severity: 'low' }, // observational
      ],
    };
    const r = scoreReport({ report, groundtruth, liveChecks });
    assert.equal(r.fpHits.length, 1);
    assert.equal(r.fpHits[0].ruleId, 'header-strict-transport-security');
    assert.deepEqual(r.observational.map((o) => o.ruleId), ['console-error']);
    assert.equal(r.recall, 1);
  });

  it('excludes expectations whose liveCheck no longer holds instead of scoring them as missed', () => {
    const staleId = groundtruth.expected[0].id; // e.g. the app gained CSP since curation
    const live = { ...liveChecks, [staleId]: { holds: false } };
    const report = {
      status: 'completed',
      runId: 't',
      findings: groundtruth.expected.slice(1).map((e) => ({ ruleId: e.ruleId })),
    };
    const r = scoreReport({ report, groundtruth, liveChecks: live });
    assert.equal(r.scored.length, groundtruth.expected.length - 1);
    assert.equal(r.recall, 1);
    assert.deepEqual(r.stale.map((s) => s.id), [staleId]);
  });
});
