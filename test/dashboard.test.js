// Test-environment setup MUST run before the dashboard module (and its frozen
// config) is imported — hence the dynamic import below instead of a static one.
process.env.NODE_ENV = 'test';                    // bypass rate limiting in requests
process.env.SQA_SCHEDULER_ENABLED = 'false';      // keep the monitor loop out of tests
delete process.env.SQA_API_TOKEN;                 // open mode
delete process.env.ALLOWED_ORIGINS;               // use the default allowlist (localhost:*)

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Seed SQLite in a temp dir (like storage.test.js does) — the dashboard's
// runManager reads the default database, which honors QUALITYPILOT_DB_PATH.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqa-dashboard-test-'));
process.env.QUALITYPILOT_DB_PATH = path.join(tmpDir, 'qualitypilot.sqlite');

const {
  computeTrends,
  createDashboardServer,
  isAuthorized,
  createTicket,
  corsOriginFor,
  checkRateLimit,
  resetRateLimits,
  sanitizeRecordedUrl,
  sanitizeRole,
  safeTokenEqual,
} = await import('../dashboard/server.js');

const { diffRuns, findingKey, normalizeTitle } = await import('../src/services/runDiff.js');
const { saveRun } = await import('../src/storage/runStore.js');

// ─── computeTrends (existing suite) ──────────────────────────────────

const sampleRuns = [
  {
    runId: 'run_1',
    url: 'https://example.com',
    status: 'completed',
    startedAt: '2025-01-01T10:00:00Z',
    completedAt: '2025-01-01T10:01:00Z',
    score: 92,
    summary: {
      totalPages: 5,
      totalFindings: 3,
      bySeverity: { critical: 0, high: 1, medium: 1, low: 1, info: 0 },
      byCategory: { links: 2, network: 1 },
    },
  },
  {
    runId: 'run_2',
    url: 'https://example.com',
    status: 'completed',
    startedAt: '2025-01-01T11:00:00Z',
    completedAt: '2025-01-01T11:01:00Z',
    score: 78,
    summary: {
      totalPages: 5,
      totalFindings: 5,
      bySeverity: { critical: 1, high: 1, medium: 2, low: 1, info: 0 },
      byCategory: { links: 3, network: 2 },
    },
  },
  {
    runId: 'run_3',
    url: 'https://example.com',
    status: 'failed',
    startedAt: '2025-01-01T12:00:00Z',
    completedAt: '2025-01-01T12:00:30Z',
    score: null,
    summary: null,
  },
  {
    runId: 'run_4',
    url: 'https://example.com',
    status: 'completed',
    startedAt: '2025-01-01T13:00:00Z',
    completedAt: '2025-01-01T13:01:30Z',
    score: 85,
    summary: {
      totalPages: 5,
      totalFindings: 4,
      bySeverity: { critical: 0, high: 2, medium: 1, low: 1, info: 0 },
      byCategory: { links: 2, network: 1, accessibility: 1 },
    },
  },
];

describe('computeTrends', () => {
  it('counts total / completed / failed runs', () => {
    const t = computeTrends(sampleRuns);
    assert.equal(t.totalRuns, 4);
    assert.equal(t.completedRuns, 3);
    assert.equal(t.failedRuns, 1);
  });

  it('computes avgScore across completed runs with scores', () => {
    const t = computeTrends(sampleRuns);
    // (92 + 78 + 85) / 3 = 85
    assert.equal(t.avgScore, 85);
  });

  it('returns avgScore=null when no completed runs', () => {
    const t = computeTrends([]);
    assert.equal(t.avgScore, null);
    assert.equal(t.totalRuns, 0);
  });

  it('returns avgScore=null when completed runs have no scores', () => {
    const t = computeTrends([{ runId: 'x', status: 'completed', score: null, summary: null }]);
    assert.equal(t.avgScore, null);
  });

  it('caps scoreTrend at last 10 runs (oldest first for chart)', () => {
    const t = computeTrends(sampleRuns);
    assert.equal(t.scoreTrend.length, 3);  // only 3 completed runs
    // newest first → run_4 (score 85), run_2 (78), run_1 (92)
    assert.equal(t.scoreTrend[0].runId, 'run_4');
    assert.equal(t.scoreTrend[0].score, 85);
    assert.equal(t.scoreTrend[2].runId, 'run_1');
  });

  it('aggregates findings by severity across runs', () => {
    const t = computeTrends(sampleRuns);
    // run_1: 0/1/1/1/0 + run_2: 1/1/2/1/0 + run_4: 0/2/1/1/0 = 1/4/4/3/0
    assert.equal(t.findingsBySeverity.critical, 1);
    assert.equal(t.findingsBySeverity.high, 4);
    assert.equal(t.findingsBySeverity.medium, 4);
    assert.equal(t.findingsBySeverity.low, 3);
    assert.equal(t.findingsBySeverity.info, 0);
  });

  it('aggregates findings by category across runs', () => {
    const t = computeTrends(sampleRuns);
    // run_1: links=2, network=1; run_2: links=3, network=2; run_4: links=2, network=1, accessibility=1
    assert.equal(t.findingsByCategory.links, 7);
    assert.equal(t.findingsByCategory.network, 4);
    assert.equal(t.findingsByCategory.accessibility, 1);
  });

  it('handles runs with missing summary', () => {
    const runs = [
      { runId: 'r1', status: 'completed', score: 90, summary: null },
      { runId: 'r2', status: 'completed', score: 80,
        summary: { bySeverity: { critical: 1 }, byCategory: { links: 1 } } },
    ];
    const t = computeTrends(runs);
    assert.equal(t.avgScore, 85);
    assert.equal(t.findingsBySeverity.critical, 1);
    assert.equal(t.findingsByCategory.links, 1);
  });

  it('returns empty findings when no completed runs', () => {
    const t = computeTrends([{ runId: 'r1', status: 'failed' }]);
    assert.deepEqual(t.findingsBySeverity, { critical: 0, high: 0, medium: 0, low: 0, info: 0 });
    assert.deepEqual(t.findingsByCategory, {});
  });

  it('always returns flakyTests array (Phase 6 will populate)', () => {
    const t = computeTrends(sampleRuns);
    assert.ok(Array.isArray(t.flakyTests));
    // Phase 4 returns empty array — Phase 6 will fill this in
    assert.equal(t.flakyTests.length, 0);
  });
});

// ─── runDiff (run-to-run comparison service) ─────────────────────────

describe('runDiff', () => {
  const runA = {
    runId: 'run_a',
    score: 80,
    findings: [
      { ruleId: 'axe-img-alt', pageUrl: 'https://x.test/', severity: 'high', title: 'Image missing alt', occurrences: 2 },
      { ruleId: 'check-links-broken', pageUrl: 'https://x.test/pricing', severity: 'medium', title: 'Broken link' },
      { title: 'Crawl Error on Checkout', severity: 'high' },
    ],
  };
  const runB = {
    runId: 'run_b',
    score: 90,
    findings: [
      { ruleId: 'axe-img-alt', pageUrl: 'https://x.test/', severity: 'high', title: 'Image missing alt', occurrences: 1 },
      { ruleId: 'axe-color-contrast', pageUrl: 'https://x.test/', severity: 'serious', title: 'Low contrast text' },
      { title: 'crawl   error  on checkout', severity: 'low' },
    ],
  };

  it('classifies new / resolved / persistent findings', () => {
    const d = diffRuns(runA, runB);
    assert.equal(d.newFindings.length, 1);
    assert.equal(d.newFindings[0].ruleId, 'axe-color-contrast');
    assert.equal(d.resolvedFindings.length, 1);
    assert.equal(d.resolvedFindings[0].ruleId, 'check-links-broken');
    assert.equal(d.persistentFindings.length, 2); // axe-img-alt + title-fallback crawl error
  });

  it('matches by normalized title when ruleId/pageUrl are missing', () => {
    const d = diffRuns(runA, runB);
    const crawl = d.persistentFindings.find(f => f.title.toLowerCase().includes('crawl'));
    assert.ok(crawl, 'title-only finding matched across runs');
  });

  it('computes scoreDelta and a human summary', () => {
    const d = diffRuns(runA, runB);
    assert.equal(d.scoreDelta, 10);
    assert.match(d.summary, /1 new/);
    assert.match(d.summary, /1 resolved/);
    assert.match(d.summary, /2 persistent/);
    assert.match(d.summary, /\+10/);
  });

  it('returns scoreDelta=null when a run has no score', () => {
    const d = diffRuns({ runId: 'a', findings: [] }, { runId: 'b', score: 50, findings: [] });
    assert.equal(d.scoreDelta, null);
    assert.equal(d.newFindings.length, 0);
    assert.equal(d.resolvedFindings.length, 0);
  });

  it('flags severity changes on persistent findings', () => {
    const d = diffRuns(
      { runId: 'a', findings: [{ ruleId: 'r', pageUrl: 'https://x.test/p', severity: 'low', title: 'T' }] },
      { runId: 'b', score: 1, findings: [{ ruleId: 'r', pageUrl: 'https://x.test/p', severity: 'high', title: 'T' }] },
    );
    assert.equal(d.persistentFindings.length, 1);
    assert.equal(d.persistentFindings[0].previousSeverity, 'low');
  });

  it('sums occurrences for same-key findings', () => {
    const d = diffRuns(
      { runId: 'a', findings: [] },
      { runId: 'b', findings: [
        { ruleId: 'r', pageUrl: 'https://x.test/', severity: 'low', title: 'T', occurrences: 2 },
        { ruleId: 'r', pageUrl: 'https://x.test/', severity: 'low', title: 'T', occurrences: 3 },
      ] },
    );
    assert.equal(d.newFindings.length, 1);
    assert.equal(d.newFindings[0].occurrences, 5);
  });

  it('findingKey falls back to normalized title', () => {
    // Audit L-10: a bare-origin URL normalizes without the trailing slash, so
    // 'https://x.test' and 'https://x.test/' are the SAME page identity.
    assert.equal(findingKey({ ruleId: 'r', pageUrl: 'https://x.test/' }), 'id:r|https://x.test');
    assert.equal(findingKey({ ruleId: 'r', pageUrl: 'https://x.test' }), 'id:r|https://x.test');
    assert.equal(
      findingKey({ ruleId: 'r', pageUrl: 'https://X.test:443/page' }),
      findingKey({ ruleId: 'r', pageUrl: 'https://x.test/page' }),
      'host casing + explicit default port do not create a second identity',
    );
    assert.notEqual(
      findingKey({ ruleId: 'r', pageUrl: 'https://x.test/app#/login' }),
      findingKey({ ruleId: 'r', pageUrl: 'https://x.test/app#/register' }),
      'hash-routed SPA pages stay distinct targets',
    );
    assert.equal(findingKey({ title: '  Mixed   Case  ' }), 'title:mixed case');
    assert.equal(normalizeTitle('A  B'), 'a b');
    assert.equal(findingKey({}), null);
  });
});

// ─── security helpers ────────────────────────────────────────────────

describe('security helpers', () => {
  it('isAuthorized: open mode when no token is configured', () => {
    const req = { headers: {} };
    const url = new URL('http://x.test/api/runs');
    assert.equal(isAuthorized(req, url, ''), true);
  });

  it('isAuthorized: accepts Bearer header and ?ticket=, rejects ?token= and wrong token', () => {
    const url1 = new URL('http://x.test/api/runs');
    assert.equal(isAuthorized({ headers: { authorization: 'Bearer secret-key' } }, url1, 'secret-key'), true);
    const ticket = createTicket();
    const url2 = new URL(`http://x.test/api/runs?ticket=${ticket}`);
    assert.equal(isAuthorized({ method: 'GET', headers: {} }, url2, 'secret-key'), true);
    // ?token= is rejected
    const urlToken = new URL('http://x.test/api/runs?token=secret-key');
    assert.equal(isAuthorized({ headers: {} }, urlToken, 'secret-key'), false);
    const url3 = new URL('http://x.test/api/runs');
    assert.equal(isAuthorized({ headers: { authorization: 'Bearer wrong' } }, url3, 'secret-key'), false);
    const url4 = new URL('http://x.test/api/runs?ticket=nope');
    assert.equal(isAuthorized({ method: 'GET', headers: {} }, url4, 'secret-key'), false);
    const url5 = new URL('http://x.test/api/runs');
    assert.equal(isAuthorized({ headers: {} }, url5, 'secret-key'), false);
  });

  it('isAuthorized: /health and non-API paths stay open', () => {
    assert.equal(isAuthorized({ headers: {} }, new URL('http://x.test/health'), 'secret'), true);
    assert.equal(isAuthorized({ headers: {} }, new URL('http://x.test/styles.css'), 'secret'), true);
  });

  it('safeTokenEqual: constant-time compare accepts only exact matches', () => {
    assert.equal(safeTokenEqual('abc', 'abc'), true);
    assert.equal(safeTokenEqual('abd', 'abc'), false);
    assert.equal(safeTokenEqual('', 'abc'), false);
    assert.equal(safeTokenEqual('abc', ''), false);
    // Different lengths must not throw (sha256 normalizes length first)
    assert.equal(safeTokenEqual('a', 'a-very-much-longer-token'), false);
  });

  it('corsOriginFor: echoes allowed origins only', () => {
    const allowed = { headers: { origin: 'http://localhost:8080' } };
    assert.equal(corsOriginFor(allowed), 'http://localhost:8080');
    const disallowed = { headers: { origin: 'https://evil.example' } };
    assert.equal(corsOriginFor(disallowed), null);
    const noOrigin = { headers: {} };
    assert.equal(corsOriginFor(noOrigin), null);
  });

  it('sanitizeRecordedUrl: strips query strings and fragments', () => {
    assert.equal(sanitizeRecordedUrl('https://x.test/account?reset_token=SECRET&page=2'), 'https://x.test/account');
    assert.equal(sanitizeRecordedUrl('https://x.test/account#section'), 'https://x.test/account');
    assert.equal(sanitizeRecordedUrl(''), null);
    assert.equal(sanitizeRecordedUrl(null), null);
    assert.equal(sanitizeRecordedUrl('not a url?token=abc'), 'not a url');
  });

  it('sanitizeRole: default / valid / invalid', () => {
    assert.equal(sanitizeRole(undefined), 'default');
    assert.equal(sanitizeRole(null), 'default');
    assert.equal(sanitizeRole(''), 'default');
    assert.equal(sanitizeRole('admin_1'), 'admin_1');
    assert.equal(sanitizeRole('guest-2'), 'guest-2');
    assert.equal(sanitizeRole('bad role!'), null);
    assert.equal(sanitizeRole('a'.repeat(33)), null);
  });

  it('checkRateLimit: fixed window per key with reset', () => {
    resetRateLimits();
    const t0 = 1_000_000;
    const opts = { max: 3, windowMs: 60_000, now: t0 };
    assert.equal(checkRateLimit('k1', opts).ok, true);
    assert.equal(checkRateLimit('k1', opts).ok, true);
    assert.equal(checkRateLimit('k1', opts).ok, true);
    const blocked = checkRateLimit('k1', opts);
    assert.equal(blocked.ok, false);
    assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 60_000);
    // Window rolls over → fresh budget
    assert.equal(checkRateLimit('k1', { ...opts, now: t0 + 60_001 }).ok, true);
    // Different keys are independent
    assert.equal(checkRateLimit('k2', opts).ok, true);
    resetRateLimits();
    assert.equal(checkRateLimit('k1', opts).ok, true);
  });
});

// ─── live HTTP tests ─────────────────────────────────────────────────

describe('dashboard server (live HTTP)', () => {
  let server;
  let base;

  before(async () => {
    const created = createDashboardServer({ port: 0 });
    server = created.server;
    // Listen directly (bypasses the factory's listen() which starts the scheduler)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    assert.equal(server.address().address, '127.0.0.1', 'binds to loopback, not 0.0.0.0');

    // Seed two completed runs for the diff endpoint
    saveRun({
      runId: 'run_diff_a',
      url: 'https://diff.test',
      status: 'completed',
      mode: 'matrix',
      score: 80,
      startedAt: '2026-01-01T10:00:00.000Z',
      completedAt: '2026-01-01T10:05:00.000Z',
      findings: [
        { ruleId: 'axe-img-alt', pageUrl: 'https://diff.test/', severity: 'high', title: 'Image missing alt', occurrences: 2 },
        { ruleId: 'check-links-broken', pageUrl: 'https://diff.test/pricing', severity: 'medium', title: 'Broken link' },
        { title: 'Crawl Error on Checkout', severity: 'high' },
      ],
    });
    saveRun({
      runId: 'run_diff_b',
      url: 'https://diff.test',
      status: 'completed',
      mode: 'matrix',
      score: 90,
      startedAt: '2026-01-01T11:00:00.000Z',
      completedAt: '2026-01-01T11:05:00.000Z',
      findings: [
        { ruleId: 'axe-img-alt', pageUrl: 'https://diff.test/', severity: 'high', title: 'Image missing alt', occurrences: 1 },
        { ruleId: 'axe-color-contrast', pageUrl: 'https://diff.test/', severity: 'serious', title: 'Low contrast text' },
        { title: 'Crawl Error on Checkout', severity: 'low' },
      ],
    });
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  it('GET /health returns 200 and helmet security headers are present', async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy') || '', /default-src 'self'/);
    assert.ok(res.headers.get('x-frame-options'));
    const body = await res.json();
    assert.equal(body.status, 'ok');
  });

  it('GET / serves the dashboard HTML with helmet headers', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    const html = await res.text();
    assert.match(html, /QualityPilot/);
  });

  it('CORS: allowed origin is echoed, disallowed origin gets no echo', async () => {
    const allowed = await fetch(`${base}/health`, { headers: { Origin: 'http://localhost:8080' } });
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:8080');
    assert.equal(allowed.headers.get('vary'), 'Origin');

    const disallowed = await fetch(`${base}/health`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(disallowed.headers.get('access-control-allow-origin'), null);

    const noOrigin = await fetch(`${base}/health`);
    assert.equal(noOrigin.headers.get('access-control-allow-origin'), null);
  });

  it('CORS: OPTIONS preflight echoes headers only for allowed origins', async () => {
    const allowed = await fetch(`${base}/api/runs`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:3000');
    assert.match(allowed.headers.get('access-control-allow-methods') || '', /POST/);

    const disallowed = await fetch(`${base}/api/runs`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(disallowed.headers.get('access-control-allow-origin'), null);
  });

  it('screenshot guard: filenames from another run are rejected with 404', async () => {
    const res = await fetch(`${base}/api/runs/run_diff_a/screenshots/run_DIFFERENT_run_abc123.png`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.match(body.error, /Screenshot not found/);
  });

  it('screenshot guard: path traversal is rejected with 400', async () => {
    const res = await fetch(`${base}/api/runs/run_diff_a/screenshots/..%2f..%2fserver.js`);
    assert.ok([400, 404].includes(res.status), `got ${res.status}`);
  });

  it('PATCH findings: invalid state / missing fields return 400', async () => {
    const badState = await fetch(`${base}/api/runs/run_diff_b/findings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ruleId: 'axe-img-alt', pageUrl: 'https://diff.test/', state: 'deleted' }),
    });
    assert.equal(badState.status, 400);
    assert.match((await badState.json()).error, /Invalid state/);

    const noRule = await fetch(`${base}/api/runs/run_diff_b/findings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageUrl: 'https://diff.test/', state: 'open' }),
    });
    assert.equal(noRule.status, 400);

    const noUrl = await fetch(`${base}/api/runs/run_diff_b/findings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ruleId: 'axe-img-alt', state: 'open' }),
    });
    assert.equal(noUrl.status, 400);
  });

  it('PATCH findings: valid state reaches the store (200 or 501 until it lands)', async () => {
    const res = await fetch(`${base}/api/runs/run_diff_b/findings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ruleId: 'axe-img-alt', pageUrl: 'https://diff.test/', state: 'acknowledged' }),
    });
    // 200 once runStore.setFindingState lands; 501 while the integration is pending
    assert.ok([200, 501].includes(res.status), `got ${res.status}`);
    if (res.status === 200) {
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.state, 'acknowledged');
    }
  });

  it('GET /api/runs/:id returns the seeded run (triage merge does not break findings)', async () => {
    const res = await fetch(`${base}/api/runs/run_diff_b`);
    assert.equal(res.status, 200);
    const run = await res.json();
    assert.equal(run.runId, 'run_diff_b');
    assert.equal(run.score, 90);
    assert.ok(Array.isArray(run.findings) && run.findings.length === 3);
  });

  it('GET /api/runs/:id/diff?against= returns the full diff shape', async () => {
    const res = await fetch(`${base}/api/runs/run_diff_b/diff?against=run_diff_a`);
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.runId, 'run_diff_b');
    assert.equal(d.against, 'run_diff_a');
    assert.ok(Array.isArray(d.newFindings));
    assert.ok(Array.isArray(d.resolvedFindings));
    assert.ok(Array.isArray(d.persistentFindings));
    assert.equal(d.newFindings.length, 1);
    assert.equal(d.newFindings[0].ruleId, 'axe-color-contrast');
    assert.equal(d.resolvedFindings.length, 1);
    assert.equal(d.resolvedFindings[0].ruleId, 'check-links-broken');
    assert.equal(d.persistentFindings.length, 2);
    assert.equal(d.scoreDelta, 10);
    assert.equal(d.scoreA, 80);
    assert.equal(d.scoreB, 90);
    assert.ok(typeof d.summary === 'string' && d.summary.length > 0);
  });

  it('GET /api/runs/:id/diff without ?against auto-picks the most recent earlier run', async () => {
    const res = await fetch(`${base}/api/runs/run_diff_b/diff`);
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.against, 'run_diff_a');
  });

  it('GET /api/runs/:id/diff returns 404 for unknown runs', async () => {
    const missing = await fetch(`${base}/api/runs/run_nope/diff?against=run_diff_a`);
    assert.equal(missing.status, 404);
    const missingAgainst = await fetch(`${base}/api/runs/run_diff_a/diff?against=run_nope`);
    assert.equal(missingAgainst.status, 404);
  });

  it('GET /api/record-status sanitizes the recorded URL (no query strings)', async () => {
    const res = await fetch(`${base}/api/record-status`);
    assert.equal(res.status, 200);
    const status = await res.json();
    assert.equal(typeof status.active, 'boolean');
    // currentUrl is null when idle; when present it must never carry a query
    assert.ok(status.currentUrl == null || !status.currentUrl.includes('?'));
  });

  it('POST /api/plan: missing url → 400; with url → drafts a plan', async () => {
    const missing = await fetch(`${base}/api/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 400);

    const withUrl = await fetch(`${base}/api/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://diff.test', options: { maxPages: 3 } }),
    });
    assert.equal(withUrl.status, 200);
    const body = await withUrl.json();
    assert.ok(body.draftId);
    assert.ok(body.plan);
  });

  it('POST /api/runs with a bogus planDraftId → 404 (or 501 while planDraftStore is pending)', async () => {
    const res = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planDraftId: 'no_such_draft' }),
    });
    assert.ok([404, 501].includes(res.status), `got ${res.status}`);
  });

  it('POST /api/runs without url or planDraftId → 400', async () => {
    const res = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ options: {} }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Missing url/);
  });

  it('GET /api/runs/:id/evidence → 501 until buildEvidenceReport lands (or 200 attachment)', async () => {
    const res = await fetch(`${base}/api/runs/run_diff_b/evidence`);
    assert.ok([200, 501].includes(res.status), `got ${res.status}`);
    if (res.status === 200) {
      assert.match(res.headers.get('content-disposition') || '', /evidence-run_diff_b\.json/);
      await res.json(); // parses
    }
  });

  it('POST /api/runs/:id/publish: invalid target → 400; valid target → 501 until publisher lands', async () => {
    const bad = await fetch(`${base}/api/runs/run_diff_b/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'github' }),
    });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /Invalid target/);

    const good = await fetch(`${base}/api/runs/run_diff_b/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'testrail' }),
    });
    assert.ok([200, 501].includes(good.status), `got ${good.status}`);
    if (good.status === 200) {
      const body = await good.json();
      assert.equal(typeof body.ok, 'boolean');
      assert.equal(body.target, 'testrail');
      assert.equal(body.error, undefined); // never leaks internals
    }
  });

  it('POST /api/monitors/:id/record-login with a malformed role → 400', async () => {
    const res = await fetch(`${base}/api/monitors/no_such_monitor/record-login?role=bad%20role!`, { method: 'POST' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Invalid role/);
  });

  it('unknown API route → 404 (CORS headers still applied)', async () => {
    const res = await fetch(`${base}/api/nope`, { headers: { Origin: 'http://localhost:8080' } });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:8080');
  });
});
