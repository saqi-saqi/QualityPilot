import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  pageScopeAgreement,
  promotePageLoadFailures,
  crossCellAgreement,
  retryReconcile,
  isRetriableFinding,
  NONDETERMINISTIC_RULES,
} from '../src/matrix/matrixClassifier.js';
import { runMatrix } from '../src/matrix/matrixRunner.js';
import { registerExecutor, clearExecutors } from '../src/services/executorRegistry.js';
import { createFindingFactory } from '../src/services/findingFactory.js';

const mkFinding = (over = {}) => ({
  title: 'Finding',
  severity: 'medium',
  confidence: 'confirmed',
  category: 'network',
  findingType: 'bug',
  origin: 'first-party',
  ruleId: 'some-rule',
  pageUrl: 'https://example.com/a',
  ...over,
});

describe('matrixClassifier — pageScopeAgreement (step 2)', () => {
  it('promotes an isolated environmental finding to a suspected bug', () => {
    const f = mkFinding({
      findingType: 'environmental',
      ruleId: 'api-timeout',
      confidence: 'suspected',
      pageUrl: 'https://example.com/slow',
    });
    const covered = ['https://example.com/slow', 'https://example.com/a', 'https://example.com/b'];
    const { promoted } = pageScopeAgreement({ findings: [f], coveredPages: covered });
    assert.equal(promoted.length, 1);
    assert.equal(f.findingType, 'bug');
    assert.equal(f.pageScoped, true);
    assert.equal(f.confidence, 'suspected', 'promotion keeps suspected confidence');
    assert.match(f.description, /page-scope/);
  });

  it('keeps site-wide failures environmental (every covered page failing)', () => {
    // Every covered page must carry an env finding for the site-wide verdict.
    const f1 = mkFinding({ findingType: 'environmental', ruleId: 'api-timeout', confidence: 'suspected', pageUrl: 'https://example.com/a' });
    const f2 = mkFinding({ findingType: 'environmental', ruleId: 'api-timeout', confidence: 'suspected', pageUrl: 'https://example.com/b' });
    const covered = ['https://example.com/a', 'https://example.com/b'];
    const { promoted } = pageScopeAgreement({ findings: [f1, f2], coveredPages: covered });
    assert.equal(promoted.length, 0);
    assert.equal(f1.findingType, 'environmental');
    assert.equal(f2.findingType, 'environmental');
  });

  it('is a no-op without coveredPages (nothing to agree against)', () => {
    const f = mkFinding({ findingType: 'environmental', ruleId: 'api-timeout', confidence: 'suspected', pageUrl: 'https://example.com/a' });
    const { promoted } = pageScopeAgreement({ findings: [f] });
    assert.equal(promoted.length, 0);
    assert.equal(f.findingType, 'environmental');
  });

  it('honors pageScopeAgreement: false', () => {
    const f = mkFinding({ findingType: 'environmental', ruleId: 'api-timeout', confidence: 'suspected', pageUrl: 'https://example.com/slow' });
    const covered = ['https://example.com/slow', 'https://example.com/a', 'https://example.com/b'];
    const { promoted } = pageScopeAgreement({ findings: [f], coveredPages: covered, options: { pageScopeAgreement: false } });
    assert.equal(promoted.length, 0);
  });
});

describe('matrixClassifier — promotePageLoadFailures (step 2, coverage variant)', () => {
  const createFinding = createFindingFactory();

  it('promotes a minority page-load failure to a suspected page-unresponsive finding', () => {
    const pageFailures = [{ url: 'https://example.com/hang', error: 'TimeoutError' }];
    const coveredPages = ['https://example.com/', 'https://example.com/a', 'https://example.com/b', 'https://example.com/hang'];
    const { promoted } = promotePageLoadFailures({ pageFailures, coveredPages, createFinding });
    assert.equal(promoted.length, 1);
    assert.equal(promoted[0].ruleId, 'page-unresponsive');
    assert.equal(promoted[0].findingType, 'bug');
    assert.equal(promoted[0].confidence, 'suspected');
    assert.deepEqual(promoted[0].affectedPages, ['https://example.com/hang']);
  });

  it('skips site-wide load failures (environment down)', () => {
    const pageFailures = [
      { url: 'https://example.com/a', error: 'TimeoutError' },
      { url: 'https://example.com/b', error: 'TimeoutError' },
      { url: 'https://example.com/c', error: 'TimeoutError' },
    ];
    const coveredPages = ['https://example.com/a', 'https://example.com/b', 'https://example.com/c', 'https://example.com/d'];
    const { promoted } = promotePageLoadFailures({ pageFailures, coveredPages, createFinding });
    assert.equal(promoted.length, 0, '3 failures vs 1 healthy page = site-wide');
  });

  it('requires ≥3 covered pages', () => {
    const pageFailures = [{ url: 'https://example.com/a', error: 'x' }];
    const coveredPages = ['https://example.com/a', 'https://example.com/b'];
    const { promoted } = promotePageLoadFailures({ pageFailures, coveredPages, createFinding });
    assert.equal(promoted.length, 0);
  });
});

describe('matrixClassifier — crossCellAgreement (step 3)', () => {
  it('demotes a confirmed single-cell nondeterministic finding in a multi-cell matrix', () => {
    const f = mkFinding({ ruleId: 'api-status-mismatch', matrixCells: ['cell-0'] });
    const demoted = crossCellAgreement([f], 2);
    assert.equal(demoted.length, 1);
    assert.equal(f.confidence, 'suspected');
    assert.equal(f.flakyCandidate, true);
    assert.equal(f.singleCell, true);
    assert.match(f.description, /1 of 2 matrix cells/);
  });

  it('keeps multi-cell-consistent findings confirmed', () => {
    const f = mkFinding({ ruleId: 'api-status-mismatch', matrixCells: ['cell-0', 'cell-1'] });
    const demoted = crossCellAgreement([f], 2);
    assert.equal(demoted.length, 0);
    assert.equal(f.confidence, 'confirmed');
  });

  it('never demotes deterministic executors (a11y etc.)', () => {
    const f = mkFinding({ ruleId: 'a11y-violation', matrixCells: ['cell-0'] });
    const demoted = crossCellAgreement([f], 3);
    assert.equal(demoted.length, 0);
    assert.equal(f.confidence, 'confirmed');
  });

  it('exempts retry-confirmed findings', () => {
    const f = mkFinding({ ruleId: 'api-status-mismatch', matrixCells: ['cell-0'], retriedConfirmed: true });
    assert.equal(crossCellAgreement([f], 2).length, 0);
    assert.equal(f.confidence, 'confirmed');
  });

  it('is a no-op for single-cell matrices', () => {
    const f = mkFinding({ ruleId: 'api-status-mismatch', matrixCells: ['cell-0'] });
    assert.equal(crossCellAgreement([f], 1).length, 0);
  });
});

describe('matrixClassifier — retryReconcile (step 4)', () => {
  it('demotes a confirmed candidate that does not reproduce on retry', () => {
    const f1 = mkFinding({ ruleId: 'api-status-mismatch', pageUrl: 'https://example.com/a' });
    retryReconcile([f1], []); // nothing in run 2
    assert.equal(f1.confidence, 'suspected');
    assert.equal(f1.flakyRetried, true);
    assert.match(f1.description, /did not reproduce/);
  });

  it('marks a reproduced candidate retriedConfirmed and keeps it confirmed', () => {
    const f1 = mkFinding({ ruleId: 'api-status-mismatch', pageUrl: 'https://example.com/a' });
    const f2 = mkFinding({ ruleId: 'api-status-mismatch', pageUrl: 'https://example.com/a' });
    retryReconcile([f1], [f2]);
    assert.equal(f1.confidence, 'confirmed');
    assert.equal(f1.retriedConfirmed, true);
  });

  it('never retries environmental candidates', () => {
    const f1 = mkFinding({ findingType: 'environmental', ruleId: 'api-timeout', confidence: 'suspected', pageUrl: 'https://example.com/a' });
    retryReconcile([f1], []);
    assert.equal(f1.confidence, 'suspected');
    assert.equal(f1.flakyRetried, undefined);
  });

  it('isRetriableFinding matches the nondeterministic families only', () => {
    assert.equal(isRetriableFinding({ ruleId: 'api-status-mismatch' }), true);
    assert.equal(isRetriableFinding({ ruleId: 'fuzz-failure' }), true);
    assert.equal(isRetriableFinding({ ruleId: 'e2e-flow-failure' }), true);
    assert.equal(isRetriableFinding({ ruleId: 'a11y-violation' }), false);
  });

  it('NONDETERMINISTIC_RULES excludes deterministic executors', () => {
    assert.equal(NONDETERMINISTIC_RULES.has('a11y-violation'), false);
    assert.equal(NONDETERMINISTIC_RULES.has('api-status-mismatch'), true);
  });
});

describe('matrixClassifier — integration through runMatrix', () => {
  it('demotes a confirmed finding seen in only one of two cells', async () => {
    clearExecutors();
    let calls = 0;
    registerExecutor('cls-exec', async (ctx) => {
      calls++;
      // Produce the finding only in the FIRST cell (cell-0); cell-1 finds nothing.
      const cellId = ctx?.options?.coveredPages === undefined ? 'cell-0' : 'cell-0';
      return {
        findings: calls <= 1 ? [ctx.createFinding({
          title: 'Flaky API mismatch',
          severity: 'medium',
          confidence: 'confirmed',
          category: 'network',
          findingType: 'bug',
          origin: 'first-party',
          ruleId: 'api-status-mismatch',
          pageUrl: 'https://example.com/a',
        })] : [],
        stats: { status: 'ok' },
      };
    });

    const plan = {
      schemaVersion: 1,
      id: 'cls-plan',
      targetUrl: 'https://example.com',
      status: 'approved',
      browsers: ['chromium'],
      viewports: [{ width: 1280, height: 720, name: 'desktop' }],
      executors: ['cls-exec'],
      pages: [], flows: [], apiEndpoints: [], fuzzTargets: [], a11yRules: [], perfBudgets: [], visualBaselines: [],
      generatedBy: 'test',
    };
    const cells = [
      { id: 'cell-0', browser: null, viewport: null, role: 'anon', executors: ['cls-exec'], needsBrowser: false },
      { id: 'cell-1', browser: null, viewport: null, role: 'anon', executors: ['cls-exec'], needsBrowser: false },
    ];

    const result = await runMatrix({
      plan,
      cells,
      browserPool: null,
      createFinding: createFindingFactory(),
      onEvent: () => {},
      signal: undefined,
      options: { concurrency: 1, dedup: true, coveredPages: ['https://example.com/a'], retryBeforeConfirm: false },
    });

    const mismatch = result.findings.find((f) => f.ruleId === 'api-status-mismatch');
    assert.ok(mismatch, 'finding present');
    // cells: cell-0 produced it (calls 1), cell-1 found nothing (calls 2)
    assert.deepEqual(mismatch.matrixCells, ['cell-0']);
    assert.equal(mismatch.confidence, 'suspected', 'single-cell confirmed finding demoted by cross-cell agreement');
    assert.equal(mismatch.flakyCandidate, true);
    clearExecutors();
  });

  it('retry-before-confirm demotes a finding that does not reproduce on the re-run', async () => {
    clearExecutors();
    let calls = 0;
    registerExecutor('retry-exec', async (ctx) => {
      calls++;
      return {
        findings: calls % 2 === 1 ? [ctx.createFinding({
          title: 'Blip 5xx',
          severity: 'high',
          confidence: 'confirmed',
          category: 'network',
          findingType: 'bug',
          origin: 'first-party',
          ruleId: 'api-status-mismatch',
          pageUrl: 'https://example.com/x',
        })] : [],
        stats: { status: 'ok' },
      };
    });

    const plan = {
      schemaVersion: 1,
      id: 'retry-plan',
      targetUrl: 'https://example.com',
      status: 'approved',
      browsers: ['chromium'],
      viewports: [{ width: 1280, height: 720, name: 'desktop' }],
      executors: ['retry-exec'],
      pages: [], flows: [], apiEndpoints: [], fuzzTargets: [], a11yRules: [], perfBudgets: [], visualBaselines: [],
      generatedBy: 'test',
    };
    const cells = [{ id: 'cell-0', browser: null, viewport: null, role: 'anon', executors: ['retry-exec'], needsBrowser: false }];

    const result = await runMatrix({
      plan,
      cells,
      browserPool: null,
      createFinding: createFindingFactory(),
      onEvent: () => {},
      signal: undefined,
      options: { concurrency: 1, dedup: false, retryBeforeConfirm: true },
    });

    // The blip appeared in run 1, vanished in run 2 → demoted, not confirmed.
    const blip = result.findings.find((f) => f.ruleId === 'api-status-mismatch');
    assert.ok(blip, 'blip finding recorded');
    assert.equal(blip.confidence, 'suspected');
    assert.equal(blip.flakyRetried, true);
    clearExecutors();
  });
});
