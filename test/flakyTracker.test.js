import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  FlakyTracker,
  detectFlakyFromRuns,
  buildRunSummary,
  normalizeFlakyOptions,
  MIN_FLAKY_ALTERNATIONS,
} from '../src/matrix/flakyTracker.js';

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqa-flaky-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeRun(runId, url, startedAt, ruleIds, status = 'completed') {
  return {
    runId,
    url,
    startedAt,
    status,
    findings: ruleIds.map(ruleId => ({
      ruleId,
      severity: 'high',
      confidence: 'confirmed',
      category: 'links',
      pageUrl: url,
      title: `${ruleId} finding`,
    })),
  };
}

describe('detectFlakyFromRuns (pure function)', () => {
  it('returns empty array when only 1 run exists for a URL', () => {
    const runs = [makeRun('r1', 'https://x.com', '2025-01-01', ['rule1'])];
    assert.equal(detectFlakyFromRuns(runs).length, 0);
  });

  it('does NOT flag a rule that appears in every run (consistent fail)', () => {
    const runs = [
      makeRun('r1', 'https://x.com', '2025-01-01', ['rule1']),
      makeRun('r2', 'https://x.com', '2025-01-02', ['rule1']),
      makeRun('r3', 'https://x.com', '2025-01-03', ['rule1']),
    ];
    const flaky = detectFlakyFromRuns(runs);
    assert.equal(flaky.length, 0);  // rule1 fails every time — not flaky, just broken
  });

  it('does NOT flag a rule that never appears (consistent pass)', () => {
    const runs = [
      makeRun('r1', 'https://x.com', '2025-01-01', []),
      makeRun('r2', 'https://x.com', '2025-01-02', []),
    ];
    // No rule IDs in any run — nothing to flag as flaky
    assert.equal(detectFlakyFromRuns(runs).length, 0);
  });

  it('flags a rule that alternates pass/fail at least 3 times', () => {
    // fail→pass→fail→pass = 3 alternations (the minimum to be labeled flaky)
    const runs = [
      makeRun('r1', 'https://x.com', '2025-01-01', ['rule1']),
      makeRun('r2', 'https://x.com', '2025-01-02', []),
      makeRun('r3', 'https://x.com', '2025-01-03', ['rule1']),
      makeRun('r4', 'https://x.com', '2025-01-04', []),
    ];
    const flaky = detectFlakyFromRuns(runs);
    assert.equal(flaky.length, 1);
    assert.equal(flaky[0].ruleId, 'rule1');
    assert.equal(flaky[0].passCount, 2);
    assert.equal(flaky[0].failCount, 2);
    assert.equal(flaky[0].totalRuns, 4);
    assert.equal(flaky[0].alternations, 3);
    assert.equal(flaky[0].flakinessRatio, 0.5);
    assert.equal(flaky[0].alternations >= MIN_FLAKY_ALTERNATIONS, true);
  });

  it('does NOT flag a rule with fewer than 3 alternations (fix/regression mid-window)', () => {
    // fail→pass→fail = 2 alternations — explainable by a fix landing, not flaky
    const runs = [
      makeRun('r1', 'https://x.com', '2025-01-01', ['rule1']),
      makeRun('r2', 'https://x.com', '2025-01-02', []),
      makeRun('r3', 'https://x.com', '2025-01-03', ['rule1']),
    ];
    const flaky = detectFlakyFromRuns(runs);
    assert.equal(flaky.length, 0);
  });

  it('does NOT flag a single pass/fail pair (1 alternation)', () => {
    const runs = [
      makeRun('r1', 'https://x.com', '2025-01-01', ['rule1']),
      makeRun('r2', 'https://x.com', '2025-01-02', []),
    ];
    assert.equal(detectFlakyFromRuns(runs).length, 0);
  });

  it('sorts by flakiness ratio descending', () => {
    const runs = [
      // rule1: fail→pass→fail→pass = 3 alternations, ratio 0.5
      makeRun('r1', 'https://x.com', '2025-01-01', ['rule1']),
      makeRun('r2', 'https://x.com', '2025-01-02', []),
      makeRun('r3', 'https://x.com', '2025-01-03', ['rule1']),
      makeRun('r4', 'https://x.com', '2025-01-04', []),
      // rule2: fail→pass→fail→fail→pass→fail = 4 alternations, ratio 4/6 (more flaky)
      makeRun('r5', 'https://y.com', '2025-01-01', ['rule2']),
      makeRun('r6', 'https://y.com', '2025-01-02', []),
      makeRun('r7', 'https://y.com', '2025-01-03', ['rule2']),
      makeRun('r8', 'https://y.com', '2025-01-04', ['rule2']),
      makeRun('r9', 'https://y.com', '2025-01-05', []),
      makeRun('r10', 'https://y.com', '2025-01-06', ['rule2']),
    ];
    const flaky = detectFlakyFromRuns(runs);
    assert.equal(flaky.length, 2);
    assert.equal(flaky[0].ruleId, 'rule2');
    assert.equal(flaky[1].ruleId, 'rule1');
  });

  it('groups by URL — different URLs tracked separately', () => {
    const runs = [
      makeRun('r1', 'https://x.com', '2025-01-01', ['rule1']),
      makeRun('r2', 'https://y.com', '2025-01-02', ['rule1']),
    ];
    // Only 1 run per URL — can't detect flakiness
    assert.equal(detectFlakyFromRuns(runs).length, 0);
  });

  it('groups by normalized options — runs with different scan configs never compare', () => {
    const makeRunWithOptions = (runId, startedAt, ruleIds, options) => ({
      ...makeRun(runId, 'https://x.com', startedAt, ruleIds),
      options,
    });
    // rule1 fails at maxPages=10, passes at maxPages=3 — a coverage
    // difference, not flakiness. Two separate groups → 1 run each → no call.
    const runs = [
      makeRunWithOptions('r1', '2025-01-01', ['rule1'], { maxPages: 10, maxDepth: 2 }),
      makeRunWithOptions('r2', '2025-01-02', [], { maxPages: 3, maxDepth: 2 }),
      makeRunWithOptions('r3', '2025-01-03', ['rule1'], { maxPages: 10, maxDepth: 2 }),
      makeRunWithOptions('r4', '2025-01-04', [], { maxPages: 3, maxDepth: 2 }),
    ];
    assert.equal(detectFlakyFromRuns(runs).length, 0);

    // Same options → same group → the alternation pattern is visible.
    const sameOptions = [
      makeRunWithOptions('r1', '2025-01-01', ['rule1'], { maxPages: 10, maxDepth: 2 }),
      makeRunWithOptions('r2', '2025-01-02', [], { maxPages: 10, maxDepth: 2 }),
      makeRunWithOptions('r3', '2025-01-03', ['rule1'], { maxPages: 10, maxDepth: 2 }),
      makeRunWithOptions('r4', '2025-01-04', [], { maxPages: 10, maxDepth: 2 }),
    ];
    const flaky = detectFlakyFromRuns(sameOptions);
    assert.equal(flaky.length, 1);
    assert.equal(flaky[0].ruleId, 'rule1');
    assert.match(flaky[0].optionsKey, /maxPages=10/);
  });

  it('handles runs with missing findings array (ruleIds shape)', () => {
    const runs = [
      { runId: 'r1', url: 'https://x.com', startedAt: '2025-01-01', status: 'completed', ruleIds: [] },
      { runId: 'r2', url: 'https://x.com', startedAt: '2025-01-02', status: 'completed', ruleIds: ['rule1'] },
      { runId: 'r3', url: 'https://x.com', startedAt: '2025-01-03', status: 'completed', ruleIds: [] },
      { runId: 'r4', url: 'https://x.com', startedAt: '2025-01-04', status: 'completed', ruleIds: ['rule1'] },
    ];
    const flaky = detectFlakyFromRuns(runs);
    assert.equal(flaky.length, 1);
    assert.equal(flaky[0].ruleId, 'rule1');
  });

  it('skips non-completed runs', () => {
    const runs = [
      makeRun('r1', 'https://x.com', '2025-01-01', ['rule1'], 'failed'),
      makeRun('r2', 'https://x.com', '2025-01-02', []),
    ];
    // Only r2 is completed — only 1 completed run, can't detect flakiness
    assert.equal(detectFlakyFromRuns(runs).length, 0);
  });

  it('tracks lastFailedAt timestamp', () => {
    const runs = [
      makeRun('r1', 'https://x.com', '2025-01-01T10:00:00Z', ['rule1']),
      makeRun('r2', 'https://x.com', '2025-01-02T10:00:00Z', []),
      makeRun('r3', 'https://x.com', '2025-01-03T10:00:00Z', ['rule1']),
      makeRun('r4', 'https://x.com', '2025-01-04T10:00:00Z', []),
    ];
    const flaky = detectFlakyFromRuns(runs);
    assert.equal(flaky[0].lastFailedAt, '2025-01-03T10:00:00Z');
  });

  it('returns empty array for empty input', () => {
    assert.equal(detectFlakyFromRuns([]).length, 0);
  });
});

describe('FlakyTracker (file-based)', () => {
  it('records a run + retrieves it', async () => {
    const tracker = new FlakyTracker({ dataDir: tmpDir });
    const run = makeRun('r1', 'https://x.com', '2025-01-01', ['rule1']);
    await tracker.recordRun(run);

    const runs = await tracker.listRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].runId, 'r1');
    assert.equal(runs[0].url, 'https://x.com');
    assert.deepEqual(runs[0].ruleIds, ['rule1']);
  });

  it('is idempotent — recording same runId overwrites', async () => {
    const tracker = new FlakyTracker({ dataDir: tmpDir });
    await tracker.recordRun(makeRun('r1', 'https://x.com', '2025-01-01', ['rule1']));
    await tracker.recordRun(makeRun('r1', 'https://x.com', '2025-01-01', ['rule2']));
    const runs = await tracker.listRuns();
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].ruleIds, ['rule2']);
  });

  it('persists across instances (writes to file)', async () => {
    const tracker1 = new FlakyTracker({ dataDir: tmpDir });
    await tracker1.recordRun(makeRun('r1', 'https://x.com', '2025-01-01', ['rule1']));

    // New instance — should read the same data from disk
    const tracker2 = new FlakyTracker({ dataDir: tmpDir });
    const runs = await tracker2.listRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].runId, 'r1');
  });

  it('detectFlakyTests returns flaky findings after recording mixed runs', async () => {
    const tracker = new FlakyTracker({ dataDir: tmpDir });
    await tracker.recordRun(makeRun('r1', 'https://x.com', '2025-01-01', ['rule1']));
    await tracker.recordRun(makeRun('r2', 'https://x.com', '2025-01-02', []));
    await tracker.recordRun(makeRun('r3', 'https://x.com', '2025-01-03', ['rule1']));
    await tracker.recordRun(makeRun('r4', 'https://x.com', '2025-01-04', []));

    const flaky = await tracker.detectFlakyTests();
    assert.equal(flaky.length, 1);
    assert.equal(flaky[0].ruleId, 'rule1');
    assert.equal(flaky[0].passCount, 2);
    assert.equal(flaky[0].failCount, 2);
    assert.equal(flaky[0].alternations, 3);
  });

  it('clear() empties the history', async () => {
    const tracker = new FlakyTracker({ dataDir: tmpDir });
    await tracker.recordRun(makeRun('r1', 'https://x.com', '2025-01-01', ['rule1']));
    await tracker.clear();
    const runs = await tracker.listRuns();
    assert.equal(runs.length, 0);
  });

  it('stats() returns totalRuns, uniqueUrls, uniqueRuleIds', async () => {
    const tracker = new FlakyTracker({ dataDir: tmpDir });
    await tracker.recordRun(makeRun('r1', 'https://x.com', '2025-01-01', ['rule1', 'rule2']));
    await tracker.recordRun(makeRun('r2', 'https://y.com', '2025-01-02', ['rule2']));

    const stats = await tracker.stats();
    assert.equal(stats.totalRuns, 2);
    assert.equal(stats.uniqueUrls, 2);
    assert.equal(stats.uniqueRuleIds, 2);
    assert.ok(stats.updatedAt);
  });

  it('handles missing data dir gracefully', async () => {
    const tracker = new FlakyTracker({ dataDir: path.join(tmpDir, 'nonexistent') });
    const runs = await tracker.listRuns();
    assert.equal(runs.length, 0);
  });

  it('sorts runs by startedAt after recording', async () => {
    const tracker = new FlakyTracker({ dataDir: tmpDir });
    // Record out of order
    await tracker.recordRun(makeRun('r3', 'https://x.com', '2025-01-03', []));
    await tracker.recordRun(makeRun('r1', 'https://x.com', '2025-01-01', []));
    await tracker.recordRun(makeRun('r2', 'https://x.com', '2025-01-02', []));

    const runs = await tracker.listRuns();
    assert.equal(runs[0].runId, 'r1');
    assert.equal(runs[1].runId, 'r2');
    assert.equal(runs[2].runId, 'r3');
  });
});

describe('buildRunSummary', () => {
  it('extracts runId, url, startedAt, status, and ruleId Set', () => {
    const run = {
      runId: 'r1',
      url: 'https://x.com',
      startedAt: '2025-01-01',
      status: 'completed',
      findings: [
        { ruleId: 'a' },
        { ruleId: 'b' },
        { ruleId: 'a' },  // duplicate — should be deduped in Set
        { /* no ruleId */ },
      ],
    };
    const summary = buildRunSummary(run);
    assert.equal(summary.runId, 'r1');
    assert.equal(summary.url, 'https://x.com');
    assert.equal(summary.status, 'completed');
    assert.ok(summary.ruleIds instanceof Set);
    assert.equal(summary.ruleIds.size, 2);  // 'a' + 'b'
    assert.ok(summary.ruleIds.has('a'));
    assert.ok(summary.ruleIds.has('b'));
  });

  it('handles empty findings array', () => {
    const summary = buildRunSummary({ runId: 'r1', findings: [] });
    assert.equal(summary.ruleIds.size, 0);
  });

  it('handles missing findings array', () => {
    const summary = buildRunSummary({ runId: 'r1' });
    assert.equal(summary.ruleIds.size, 0);
  });

  it('includes a normalized options key (mode, maxPages, depth, executor set)', () => {
    const summary = buildRunSummary({
      runId: 'r1',
      url: 'https://x.com',
      status: 'completed',
      mode: 'matrix',
      options: { maxPages: 5, maxDepth: 2, executors: ['visual', 'e2e'] },
      findings: [],
    });
    assert.equal(summary.optionsKey, 'mode=matrix|maxPages=5|depth=2|executors=e2e,visual');
  });

  it('normalizes executor order + missing options to stable defaults', () => {
    assert.equal(
      normalizeFlakyOptions({ options: { executors: ['b', 'a', 'b'] } }),
      'mode=matrix|maxPages=default|depth=default|executors=a,b'
    );
    assert.equal(
      normalizeFlakyOptions({ mode: 'legacy', options: { maxPages: 3, maxDepth: 1 } }),
      'mode=legacy|maxPages=3|depth=1|executors='
    );
  });
});
