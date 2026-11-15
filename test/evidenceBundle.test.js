// Phase 4 evidence bundles — zip writer, HAR builder, tiered bundles,
// dashboard endpoint, and real-browser capture integration.
// Private-target opt-in MUST be set before any app module import (config
// freezes env at load): the capture integration scans the loopback fixture.
process.env.NODE_ENV = 'test';
process.env.SQA_ALLOW_PRIVATE = 'true';
process.env.ALLOW_PRIVATE_HOSTS = 'true';
process.env.SQA_SCHEDULER_ENABLED = 'false';
delete process.env.SQA_API_TOKEN;

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const { createZip, readZip } = await import('../src/services/zipWriter.js');
const { buildHarFromRun, scrubHar, buildFindingEvidenceBundle } = await import('../src/services/evidenceBundle.js');
const { startFixtureServer } = await import('./fixtures/site/server.js');
const { runMatrix } = await import('../src/matrix/matrixRunner.js');
const { BrowserPool } = await import('../src/matrix/browserPool.js');
const { registerAllExecutors } = await import('../src/executors/index.js');
const { clearExecutors } = await import('../src/services/executorRegistry.js');
const { createFindingFactory } = await import('../src/services/findingFactory.js');
const { saveRun } = await import('../src/storage/runStore.js');
const { createDashboardServer } = await import('../dashboard/server.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-evidence-'));

function fakeRun(over = {}) {
  return {
    runId: 'run_evidence_1',
    url: 'https://example.com',
    status: 'completed',
    startedAt: '2026-11-15T00:00:00Z',
    completedAt: '2026-11-15T00:01:00Z',
    score: 90,
    pages: [{
      url: 'https://example.com/login',
      title: 'Login',
      apiCalls: [
        {
          method: 'POST', url: 'https://example.com/api/login', status: 200,
          requestHeaders: { 'content-type': 'application/json', authorization: 'Bearer [REDACTED]' },
          responseHeaders: { 'content-type': 'application/json' },
          requestBody: '{"email":"a@b.c"}', responseBody: '{"token":"REDACTED"}',
          responseContentType: 'application/json', durationMs: 42,
        },
      ],
    }],
    findings: [],
    ...over,
  };
}

describe('zipWriter', () => {
  it('round-trips entries and is readable by the platform tar', () => {
    const zip = createZip([
      { name: 'a.txt', data: 'hello'.repeat(200) },
      { name: 'media/shot.png', data: Buffer.alloc(512, 3) },
    ]);
    const back = readZip(zip);
    assert.equal(back.get('a.txt').toString(), 'hello'.repeat(200));
    assert.equal(back.get('media/shot.png').length, 512);

    const zipPath = path.join(tmpRoot, 'check.zip');
    fs.writeFileSync(zipPath, zip);
    const res = spawnSync('tar', ['-tf', zipPath], { encoding: 'utf8' });
    assert.equal(res.status, 0, `tar must read the archive: ${res.stderr}`);
    assert.match(res.stdout, /a\.txt/);
    assert.match(res.stdout, /media\/shot\.png/);
  });
});

describe('evidenceBundle — HAR', () => {
  it('builds HAR 1.2 entries from captured apiCalls', () => {
    const har = buildHarFromRun(fakeRun());
    assert.equal(har.log.version, '1.2');
    assert.equal(har.log.entries.length, 1);
    const e = har.log.entries[0];
    assert.equal(e.request.method, 'POST');
    assert.equal(e.request.url, 'https://example.com/api/login');
    assert.equal(e.response.status, 200);
    assert.ok(Array.isArray(e.request.headers));
  });

  it('scrubs token-shaped values entry-by-entry while keeping JSON structure', () => {
    const har = buildHarFromRun(fakeRun({
      pages: [{
        url: 'https://example.com/x',
        apiCalls: [{
          method: 'GET', url: 'https://example.com/api?token=abc123', status: 200,
          requestHeaders: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig' },
          responseHeaders: {}, requestBody: null, responseBody: '{"secret":"sk-live-abcdefghijklmnopqrstuvwx"}',
        }],
      }],
    }));
    const scrubbed = scrubHar(har);
    const e = scrubbed.log.entries[0];
    const headerValue = e.request.headers.find((h) => h.name === 'authorization')?.value || '';
    assert.ok(!headerValue.includes('eyJhbGciOiJIUzI1NiJ9'), 'bearer token scrubbed');
    assert.ok(!String(e.response.content.text || '').includes('sk-live-abcdefghijklmnopqrstuvwx'), 'sk key scrubbed');
  });
});

describe('evidenceBundle — tiers', () => {
  it('default bundle includes README, finding, HAR and captured media', () => {
    const shot = path.join(tmpRoot, 'shot-1.png');
    fs.writeFileSync(shot, Buffer.alloc(64, 1));
    const finding = {
      id: 'NET-001', ruleId: 'e2e-flow-failure', title: 'Flow failed',
      severity: 'high', confidence: 'confirmed', pageUrl: 'https://example.com/login',
      screenshot: shot,
    };
    const { buffer, filename, entryNames } = buildFindingEvidenceBundle({
      run: fakeRun({ findings: [finding] }),
      finding,
      evidenceDir: path.join(tmpRoot, 'evidence'),
    });
    assert.equal(filename, 'evidence-NET-001.zip');
    assert.ok(entryNames.includes('README.txt'));
    assert.ok(entryNames.includes('finding.json'));
    assert.ok(entryNames.includes('har.json'));
    assert.ok(entryNames.some((n) => n.startsWith('media/')), 'default tier includes media');
    const back = readZip(buffer);
    assert.match(back.get('README.txt').toString(), /default tier/);
  });

  it('shareable bundle omits media, states exclusions, and scrubs the HAR', () => {
    const shot = path.join(tmpRoot, 'shot-2.png');
    fs.writeFileSync(shot, Buffer.alloc(64, 2));
    const finding = {
      id: 'NET-002', ruleId: 'e2e-flow-failure', title: 'Flow failed',
      severity: 'high', confidence: 'confirmed', pageUrl: 'https://example.com/login',
      screenshot: shot,
    };
    const { buffer, filename, entryNames } = buildFindingEvidenceBundle({
      run: fakeRun(),
      finding,
      evidenceDir: path.join(tmpRoot, 'evidence'),
      shareable: true,
    });
    assert.equal(filename, 'evidence-NET-002-shareable.zip');
    assert.ok(!entryNames.some((n) => n.startsWith('media/')), 'no media in shareable tier');
    assert.ok(entryNames.includes('trace-metadata.json'), 'media replaced by metadata');
    const back = readZip(buffer);
    assert.match(back.get('README.txt').toString(), /cannot be reliably redacted/i);
    assert.match(back.get('README.txt').toString(), /Video and screenshots/i);
  });
});

describe('dashboard evidence endpoint (live HTTP)', () => {
  let server;
  let base;

  before(async () => {
    // Seed a run with one finding + a screenshot on disk.
    const shot = path.join(tmpRoot, 'shot-3.png');
    fs.writeFileSync(shot, Buffer.alloc(32, 3));
    await saveRun(fakeRun({
      runId: 'run_evidence_http',
      findings: [{
        id: 'A11Y-001', ruleId: 'image-alt', title: 'Missing alt', severity: 'serious',
        confidence: 'confirmed', pageUrl: 'https://example.com/login', screenshot: shot,
      }],
    }));
    const created = createDashboardServer({ port: 0 });
    server = created.server;
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => { server?.close(); });

  it('serves the default bundle as a ZIP attachment', async () => {
    const res = await fetch(`${base}/api/runs/run_evidence_http/findings/A11Y-001/evidence`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    assert.match(res.headers.get('content-disposition'), /evidence-A11Y-001\.zip/);
    const zip = readZip(Buffer.from(await res.arrayBuffer()));
    assert.ok(zip.has('har.json'));
    assert.ok(zip.has('finding.json'));
  });

  it('serves the shareable tier (no media, metadata present)', async () => {
    const res = await fetch(`${base}/api/runs/run_evidence_http/findings/A11Y-001/evidence?shareable=true`);
    assert.equal(res.status, 200);
    const zip = readZip(Buffer.from(await res.arrayBuffer()));
    assert.ok(![...zip.keys()].some((n) => n.startsWith('media/')), 'shareable has no media');
    assert.ok(zip.has('trace-metadata.json'));
  });

  it('404s for an unknown finding', async () => {
    const res = await fetch(`${base}/api/runs/run_evidence_http/findings/NOPE-999/evidence`);
    assert.equal(res.status, 404);
  });

  it('404s for an unknown run', async () => {
    const res = await fetch(`${base}/api/runs/run_missing/findings/X/evidence`);
    assert.equal(res.status, 404);
  });
});

describe('evidence capture — real browser cell (tracing + video on failure)', () => {
  it('keeps trace.zip + video for a failing E2E cell and tags findings with evidenceRef', async () => {
    registerAllExecutors();
    const fx = await startFixtureServer();
    const evidenceDir = path.join(tmpRoot, 'evidence-real');
    const browserPool = new BrowserPool();
    try {
      const plan = {
        schemaVersion: 1,
        id: 'evidence-plan',
        targetUrl: fx.url,
        status: 'approved',
        browsers: ['chromium'],
        viewports: [{ width: 1280, height: 720, name: 'desktop' }],
        executors: ['e2e'],
        pages: [], apiEndpoints: [], fuzzTargets: [], a11yRules: [], perfBudgets: [], visualBaselines: [],
        generatedBy: 'test',
        flows: [{
          name: 'Deliberately failing flow',
          startUrl: `${fx.url}/page-ok.html`,
          steps: [
            { action: 'navigate', selector: `${fx.url}/page-ok.html` },
            { action: 'assertText', selector: 'h1', equals: 'Text that does not exist' },
          ],
        }],
      };
      const cells = [{
        id: 'cell-evidence', browser: 'chromium', viewport: { width: 1280, height: 720, name: 'desktop' },
        role: 'anon', executors: ['e2e'], needsBrowser: true,
      }];

      const result = await runMatrix({
        plan,
        cells,
        browserPool,
        createFinding: createFindingFactory(),
        onEvent: () => {},
        signal: undefined,
        options: {
          concurrency: 1, dedup: false,
          screenshotsDir: path.join(tmpRoot, 'shots'),
          evidenceDir,
          runId: 'run_evidence_real',
          retryBeforeConfirm: false,
        },
      });

      const e2eFinding = result.findings.find((f) => f.ruleId === 'e2e-flow-failure');
      assert.ok(e2eFinding, `failing flow produces an e2e-flow-failure finding (got: ${JSON.stringify(result.findings.map((f) => f.ruleId))})`);
      assert.deepEqual(e2eFinding.evidenceRef, { cellId: 'cell-evidence', hasTrace: true, hasVideo: true });
      assert.ok(fs.existsSync(path.join(evidenceDir, 'cell-evidence', 'trace.zip')), 'trace.zip saved for the failing cell');
      const videoDir = path.join(evidenceDir, 'cell-evidence', 'video');
      const videos = fs.existsSync(videoDir) ? fs.readdirSync(videoDir).filter((f) => f.endsWith('.webm')) : [];
      assert.ok(videos.length >= 1, 'video captured for the failing cell');
    } finally {
      await browserPool.shutdown().catch(() => {});
      fx.server?.close?.();
      clearExecutors();
    }
  });
});
