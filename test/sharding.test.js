process.env.NODE_ENV = 'test';
process.env.SQA_ALLOW_PRIVATE = 'true';
process.env.ALLOW_PRIVATE_HOSTS = 'true';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const {
  parseShardSpec,
  resolveShardStorage,
  partitionShardWorkload,
  mergeShardReports,
} = await import('../src/matrix/sharding.js');
const { planMatrix } = await import('../src/matrix/matrixPlanner.js');
const { parseArgs: parseCheckArgs } = await import('../src/cli/check.js');
const { parseReplayArgs } = await import('../src/cli/replay.js');
const { parseMergeArgs, mergeReportsMain } = await import('../src/cli/mergeReports.js');
const { startFixtureServer } = await import('./fixtures/site/server.js');
const { buildTestPlan, approvePlan } = await import('../src/explorer/index.js');
const { crawlSite, closeCrawlSession } = await import('../src/services/crawler.js');
const { exportPlanJson } = await import('../src/export/planJson.js');
const { setDefaultProvider, MockProvider } = await import('../src/explorer/llmProvider.js');

describe('matrix sharding — parseShardSpec & storage isolation', () => {
  it('parses valid shard specs and rejects invalid ones', () => {
    assert.deepEqual(parseShardSpec('1/4'), { index: 1, total: 4, spec: '1/4' });
    assert.deepEqual(parseShardSpec('4 / 4'), { index: 4, total: 4, spec: '4/4' });
    assert.throws(() => parseShardSpec('0/4'), /Invalid --shard/);
    assert.throws(() => parseShardSpec('5/4'), /Invalid --shard/);
    assert.throws(() => parseShardSpec('1/0'), /Invalid --shard/);
    assert.throws(() => parseShardSpec('abc'), /Invalid --shard/);
  });

  it('resolves distinct isolated storage directories per shard', () => {
    const s1 = resolveShardStorage({ index: 1, total: 4 }, '/tmp/qp');
    const s2 = resolveShardStorage({ index: 2, total: 4 }, '/tmp/qp');
    assert.notEqual(s1.dataDir, s2.dataDir);
    assert.notEqual(s1.dbPath, s2.dbPath);
    assert.notEqual(s1.screenshotsDir, s2.screenshotsDir);
    assert.match(s1.dbPath, /shard-1-of-4/);
    assert.match(s2.dbPath, /shard-2-of-4/);
  });

  it('wires --shard and --shard-out into check, replay, and merge-reports CLIs', () => {
    const c = parseCheckArgs(['node', 'check', 'https://example.com', '--shard', '2/4', '--shard-out', 's2.json']);
    assert.deepEqual(c.shard, { index: 2, total: 4, spec: '2/4' });
    assert.equal(c.shardOut, 's2.json');

    const r = parseReplayArgs(['node', 'replay', 'plan.json', '--shard', '3/4', '--shard-out', 's3.json', '--format', 'json']);
    assert.deepEqual(r.shard, { index: 3, total: 4, spec: '3/4' });
    assert.equal(r.shardOut, 's3.json');
    assert.equal(r.format, 'json');

    const m = parseMergeArgs(['node', 'merge-reports', 's1.json', 's2.json', '--expect-shards', '2', '--fail-on', 'critical,high', '--min-score', '80']);
    assert.deepEqual(m.files, ['s1.json', 's2.json']);
    assert.equal(m.expectShards, 2);
    assert.equal(m.failOn, 'critical,high');
    assert.equal(m.minScore, 80);
  });
});

describe('matrix sharding — partitionShardWorkload', () => {
  it('partitions multi-browser/viewport matrices across shards with zero cell duplication', () => {
    const plan = {
      targetUrl: 'https://example.com',
      browsers: ['chromium', 'firefox'],
      viewports: [{ width: 1280, height: 720, name: 'desktop' }, { width: 375, height: 812, name: 'mobile' }],
      executors: ['api-contract', 'e2e', 'accessibility-deep', 'visual'],
      pages: [{ url: 'https://example.com/' }, { url: 'https://example.com/about' }],
      flows: [],
      apiEndpoints: [],
      a11yRules: [],
      perfBudgets: [],
      visualBaselines: [],
      fuzzTargets: [],
    };
    const cells = planMatrix(plan, ['anon', 'user']);
    const seenIds = [];
    for (let i = 1; i <= 4; i++) {
      const part = partitionShardWorkload({ plan, cells, shard: { index: i, total: 4 } });
      assert.equal(part.mode, 'cell-partition');
      assert.ok(part.cells.length > 0);
      seenIds.push(...part.cells.map(c => c.id));
    }
    assert.equal(seenIds.length, cells.length);
    assert.equal(new Set(seenIds).size, cells.length);
  });

  it('falls back to deterministic page slicing when browser cells < shard total', () => {
    const pages = Array.from({ length: 6 }, (_, i) => ({ url: `https://example.com/p${i + 1}` }));
    const plan = {
      targetUrl: 'https://example.com',
      browsers: ['chromium'],
      viewports: [{ width: 1280, height: 720, name: 'desktop' }],
      executors: ['security', 'api-contract', 'accessibility-deep', 'perf', 'legacy-links'],
      pages,
      flows: [],
      apiEndpoints: [{ method: 'GET', path: '/api/a' }, { method: 'GET', path: '/api/b' }],
      a11yRules: pages.map(p => ({ pageUrl: p.url, rules: [] })),
      perfBudgets: pages.map(p => ({ pageUrl: p.url })),
      visualBaselines: [],
      fuzzTargets: [],
    };
    const cells = planMatrix(plan, ['anon']);
    const ownedPages = [];
    let siteWideCount = 0;
    for (let i = 1; i <= 4; i++) {
      const part = partitionShardWorkload({ plan, cells, shard: { index: i, total: 4 } });
      assert.equal(part.mode, 'page-partition');
      ownedPages.push(...part.plan.pages.map(p => p.url));
      assert.equal(part.coveredPages.length, 6, 'full coveredPages preserved for coverage accounting');
      if (part.cells.some(c => c.id === 'no-browser::site')) siteWideCount++;
    }
    assert.equal(siteWideCount, 1, 'site-wide cell runs exactly once');
    assert.equal(new Set(ownedPages).size, 6, 'all 6 pages covered across shards without overlap');
  });
});

describe('mergeShardReports — unit invariants', () => {
  it('merges site-wide and cross-shard findings identically and fails on missing/failed shards', () => {
    const s1 = {
      runId: 'r1',
      url: 'http://127.0.0.1:9999',
      status: 'completed',
      shard: { index: 1, total: 2, spec: '1/2' },
      coveredPages: ['http://127.0.0.1:9999/a.html', 'http://127.0.0.1:9999/b.html'],
      pages: [{ url: 'http://127.0.0.1:9999/a.html' }],
      matrixStats: { totalCells: 2, completedCells: 2, failedCells: 0, abortedCells: 0 },
      findings: [
        {
          ruleId: 'header-content-security-policy',
          title: 'Missing Content-Security-Policy',
          severity: 'high',
          confidence: 'confirmed',
          findingType: 'bug',
          pageUrl: 'http://127.0.0.1:9999/a.html',
          affectedPages: ['http://127.0.0.1:9999/a.html'],
          occurrences: 1,
        },
        {
          ruleId: 'axe-image-alt',
          title: 'Images missing alt',
          severity: 'critical',
          confidence: 'confirmed',
          findingType: 'bug',
          selector: '#hero',
          pageUrl: 'http://127.0.0.1:9999/a.html',
          occurrences: 1,
        },
      ],
    };
    const s2 = {
      runId: 'r2',
      url: 'http://127.0.0.1:9999',
      status: 'completed',
      shard: { index: 2, total: 2, spec: '2/2' },
      coveredPages: ['http://127.0.0.1:9999/a.html', 'http://127.0.0.1:9999/b.html'],
      pages: [{ url: 'http://127.0.0.1:9999/b.html' }],
      matrixStats: { totalCells: 2, completedCells: 2, failedCells: 0, abortedCells: 0 },
      findings: [
        {
          ruleId: 'header-content-security-policy',
          title: 'Missing Content-Security-Policy',
          severity: 'high',
          confidence: 'confirmed',
          findingType: 'bug',
          pageUrl: 'http://127.0.0.1:9999/b.html',
          affectedPages: ['http://127.0.0.1:9999/b.html'],
          occurrences: 1,
        },
      ],
    };

    const merged = mergeShardReports([s1, s2]);
    assert.equal(merged.status, 'completed');
    assert.equal(merged.findings.length, 2, 'site-wide CSP rolls up into one finding');
    const csp = merged.findings.find(f => f.ruleId === 'header-content-security-policy');
    assert.equal(csp.pageUrl, 'http://127.0.0.1:9999/a.html');
    assert.equal(csp.affectedPages.length, 2);

    assert.throws(() => mergeShardReports([s1]), /Incomplete shard set/);
    const failed = mergeShardReports([s1, { ...s2, status: 'failed', error: 'crash' }]);
    assert.equal(failed.status, 'failed');
  });

  it('mergeReportsMain CLI writes unified JSON + SARIF + JUnit outputs and exits with gate verdict', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qp-merge-cli-'));
    try {
      const f1 = path.join(tmp, 's1.json');
      const f2 = path.join(tmp, 's2.json');
      const outSarif = path.join(tmp, 'merged.sarif');
      const outJunit = path.join(tmp, 'merged.xml');
      const base = {
        url: 'https://app.test',
        status: 'completed',
        coveredPages: ['https://app.test/1', 'https://app.test/2'],
        pages: [],
        matrixStats: { totalCells: 2, completedCells: 2, failedCells: 0, abortedCells: 0 },
      };
      await fs.writeFile(f1, JSON.stringify({
        ...base,
        runId: 's1',
        shard: { index: 1, total: 2, spec: '1/2' },
        findings: [{ ruleId: 'axe-image-alt', title: 'Missing alt', severity: 'critical', confidence: 'confirmed', findingType: 'bug', pageUrl: 'https://app.test/1', selector: '#img1' }],
      }));
      await fs.writeFile(f2, JSON.stringify({
        ...base,
        runId: 's2',
        shard: { index: 2, total: 2, spec: '2/2' },
        findings: [],
      }));
      const code = await mergeReportsMain([
        'qualitypilot', 'merge-reports', f1, f2,
        '--fail-on', 'critical',
        '--sarif', outSarif,
        '--junit', outJunit,
      ]);
      assert.equal(code, 1, 'critical finding fails gate cleanly');
      assert.ok(existsSync(outSarif));
      assert.ok(existsSync(outJunit));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });
});

function spawnReplayShard({ planFile, url, shardSpec, shardOut, dataDir }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const env = {
      ...process.env,
      NODE_ENV: 'production',
      SQA_ALLOW_PRIVATE: 'false',
      // Force allow-private via env only if not production; replay validates plan via SSRF unless ALLOW_PRIVATE_HOSTS
    };
    // Note: replay uses config.allowPrivateTargets which disables when NODE_ENV === 'production'.
    // Keep development env so loopback fixture is allowed explicitly via SQA_ALLOW_PRIVATE=true.
    env.NODE_ENV = 'development';
    env.SQA_ALLOW_PRIVATE = 'true';
    env.ALLOW_PRIVATE_HOSTS = 'true';
    env.SQA_DATA_DIR = dataDir;
    delete env.QUALITYPILOT_DB_PATH;
    delete env.SQA_DB_PATH;

    const args = [
      'src/cli/qualitypilot.js',
      'replay',
      planFile,
      '--url', url,
      '--fail-on', 'critical,high',
      '--min-score', '90',
      ...(shardSpec ? ['--shard', shardSpec] : []),
      '--shard-out', shardOut,
      '--format', 'json',
    ];
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', (code) => {
      resolve({ code, elapsedMs: Date.now() - t0, stdout, stderr });
    });
  });
}

describe('WS4.1 E2E acceptance — 4-shard fixture run vs unsharded run', () => {
  it('produces equivalent findings & gate verdict in less wall time with isolated per-shard storage', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qp-e2e-shard-'));
    const fixture = await startFixtureServer(0);
    setDefaultProvider(new MockProvider());
    try {
      // Crawl once and export a deterministic plan spanning pages + api + a11y + security + perf
      const crawl = await crawlSite({
        url: `${fixture.url}/index.html`,
        options: { maxPages: 8, maxDepth: 1 },
      });
      await closeCrawlSession(crawl.browser, crawl.egressProxy).catch(() => {});

      const { plan } = await buildTestPlan({
        pages: crawl.pages,
        targetUrl: fixture.url,
        siteOrigin: crawl.siteOrigin,
        options: { summary: false, riskPriority: false },
      });
      const fourViewportPlan = approvePlan({
        ...plan,
        executors: ['api-contract', 'security', 'accessibility-deep', 'perf', 'legacy-links', 'legacy-console', 'legacy-network'],
        browsers: ['chromium'],
        viewports: [
          { width: 1280, height: 720, name: 'desktop' },
          { width: 1024, height: 768, name: 'tablet' },
          { width: 768, height: 1024, name: 'portrait' },
          { width: 375, height: 812, name: 'mobile' },
        ],
      });
      const planFile = path.join(tmp, 'plan.json');
      await fs.writeFile(planFile, JSON.stringify(exportPlanJson(fourViewportPlan), null, 2), 'utf8');

      const unshardedOut = path.join(tmp, 'unsharded.json');
      const unshardedDir = path.join(tmp, 'unsharded-data');
      const t0Unsharded = Date.now();
      const unsharded = await spawnReplayShard({
        planFile,
        url: fixture.url,
        shardSpec: null,
        shardOut: unshardedOut,
        dataDir: unshardedDir,
      });
      const unshardedWallMs = Date.now() - t0Unsharded;
      assert.equal(unsharded.code, 1, `Unsharded gate failed as expected (${unsharded.stderr})`);
      const unshardedReport = JSON.parse(await fs.readFile(unshardedOut, 'utf8'));

      // Run 4 parallel shards
      const shardDataDir = path.join(tmp, 'sharded-data');
      const shardFiles = [1, 2, 3, 4].map(i => path.join(tmp, `shard-${i}.json`));
      const t0Sharded = Date.now();
      const shardResults = await Promise.all([1, 2, 3, 4].map(i =>
        spawnReplayShard({
          planFile,
          url: fixture.url,
          shardSpec: `${i}/4`,
          shardOut: shardFiles[i - 1],
          dataDir: shardDataDir,
        })
      ));

      const mergedJsonOut = path.join(tmp, 'merged.json');
      const mergeExit = await mergeReportsMain([
        'qualitypilot', 'merge-reports', ...shardFiles,
        '--expect-shards', '4',
        '--fail-on', 'critical,high',
        '--min-score', '90',
        '--out', mergedJsonOut,
        '--format', 'json',
      ]);
      const shardedWallMs = Date.now() - t0Sharded;

      for (const r of shardResults) {
        assert.ok(r.code === 0 || r.code === 1, `Shard did not fail execution (${r.stderr})`);
      }

      const mergedReport = JSON.parse(await fs.readFile(mergedJsonOut, 'utf8'));

      // Verify identical verdict & finding ruleIds + scores
      assert.equal(mergeExit, unsharded.code, 'Merged gate exit code must match unsharded run');
      assert.equal(mergedReport.failed, unshardedReport.failed, 'Merged gate verdict matches unsharded');
      assert.equal(Math.round(mergedReport.score * 10), Math.round(unshardedReport.score * 10), 'Merged score matches unsharded');

      const sig = (f) => `${f.ruleId}::${f.pageUrl || ''}::${f.selector || ''}`;
      const unshardedSigs = [...new Set(unshardedReport.findings.map(sig))].sort();
      const mergedSigs = [...new Set(mergedReport.findings.map(sig))].sort();
      assert.deepEqual(mergedSigs, unshardedSigs, 'Merged findings set must match unsharded findings set');

      // Verify wall-time speedup on 4-shard run
      console.log(`[sharding-bench] unsharded=${unshardedWallMs}ms, 4-shard+merge=${shardedWallMs}ms`);
      assert.ok(
        shardedWallMs < unshardedWallMs,
        `Expected 4-shard run (${shardedWallMs}ms) to finish faster than unsharded (${unshardedWallMs}ms)`
      );
    } finally {
      await fixture.close().catch(() => {});
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });
});
