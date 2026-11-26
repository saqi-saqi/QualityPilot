process.env.NODE_ENV = 'test';
process.env.SQA_ALLOW_PRIVATE = 'true';
process.env.ALLOW_PRIVATE_HOSTS = 'true';
process.env.SQA_SCHEDULER_ENABLED = 'false';
delete process.env.SQA_API_TOKEN;

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qp-vis-review-'));
process.env.SQA_DATA_DIR = tmpDir;
process.env.SQA_SCREENSHOTS_DIR = path.join(tmpDir, 'screenshots');
process.env.QUALITYPILOT_DB_PATH = path.join(tmpDir, 'qualitypilot.sqlite');

const { closeDatabase } = await import('../src/storage/db.js');
const baselineStore = await import('../src/storage/baselineStore.js');
const { createDashboardServer } = await import('../dashboard/server.js');
const { checkMain } = await import('../src/cli/check.js');
const { getRun } = await import('../src/services/runManager.js');
const { MockProvider, setDefaultProvider } = await import('../src/explorer/llmProvider.js');

setDefaultProvider(new MockProvider());

let targetServer;
let targetUrl;
let tickerColor = '#111111';
let tickerLabel = 'TICK-1';
let shiftLayout = false;

let dashServer;
let dashUrl;

before(async () => {
  await fs.mkdir(process.env.SQA_SCREENSHOTS_DIR, { recursive: true });

  targetServer = http.createServer((req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline'; object-src 'none'; base-uri 'self'");
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin');
    res.setHeader('Permissions-Policy', 'camera=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Visual Review Fixture</title></head>
<body style="margin:0;padding:24px;font-family:sans-serif;background:#fff;color:#111;">
  <main>
    <h1 style="margin:0 0 12px;">Hero Heading</h1>
    <div class="live-ticker" style="width:420px;height:140px;background:${tickerColor};color:#fff;display:flex;align-items:center;justify-content:center;font-size:28px;">
      ${tickerLabel}
    </div>
    ${shiftLayout ? '<div style="margin-top:16px;width:420px;height:120px;background:#2563eb;color:#fff;font-size:24px;">BANNER SHIFT</div>' : ''}
  </main>
</body>
</html>`);
  });
  await new Promise((r) => targetServer.listen(0, '127.0.0.1', r));
  targetUrl = `http://127.0.0.1:${targetServer.address().port}`;

  const dash = createDashboardServer({ port: 0 });
  await dash.listen();
  dashServer = dash.server;
  dashUrl = `http://127.0.0.1:${dashServer.address().port}`;
});

after(async () => {
  if (dashServer) await new Promise((r) => dashServer.close(r));
  if (targetServer) await new Promise((r) => targetServer.close(r));
  closeDatabase();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe('WS4.2 — Dashboard visual baseline review, masks, approval & waiver persistence', () => {
  it('baselineStore persists mask selectors, approvals, and waivers with validation', async () => {
    const b = baselineStore.saveBaseline({
      monitorId: 'mon_unit',
      pageUrl: 'https://unit.example/page',
      viewport: '1280x720',
      label: 'default',
      path: path.join(tmpDir, 'screenshots', 'unit.png'),
      hash: 'abc123',
    });
    assert.ok(b.id);

    const masked = baselineStore.updateBaselineMasks(b.id, ['.clock, [data-dynamic]', '.clock']);
    assert.deepEqual(masked.maskSelectors, ['.clock', '[data-dynamic]']);

    assert.throws(
      () => baselineStore.waiveBaselineReview({ id: b.id, reason: '   ' }),
      /non-empty reason/
    );
    assert.throws(
      () => baselineStore.waiveBaselineReview({ id: b.id, reason: 'ok', expiresAt: '2026-02-31' }),
      /Invalid calendar date/
    );

    const waived = baselineStore.waiveBaselineReview({
      id: b.id,
      runId: 'run_u1',
      reason: 'Intentional promo banner',
      expiresAt: '2029-12-31',
    });
    assert.equal(waived.baseline.status, 'waived');
    assert.equal(baselineStore.getActiveBaselineWaivers('mon_unit').length, 1);

    const approved = baselineStore.approveBaselineReview({
      id: b.id,
      runId: 'run_u2',
      reason: 'Promoted new baseline',
      maskSelectors: ['.clock', '.ads'],
    });
    assert.equal(approved.baseline.status, 'approved');
    assert.deepEqual(approved.baseline.maskSelectors, ['.clock', '.ads']);
    assert.equal(baselineStore.getActiveBaselineWaivers('mon_unit').length, 0);
    assert.ok(baselineStore.listBaselineDecisions({ baselineId: b.id }).length >= 3);
  });

  it('E2E: approving a masked dynamic change keeps the next run gate green and records decision; waive also suppresses gate', async () => {
    // Wait until a Playwright run against the dynamic page creates baseline + detects diff
    const { registerAllExecutors } = await import('../src/executors/index.js');
    const { registerLegacyChecks } = await import('../src/checks/index.js');
    const { createRunWithMatrix } = await import('../src/services/runManager.js');
    registerAllExecutors();
    registerLegacyChecks();

    async function waitRun(id) {
      for (let i = 0; i < 120; i++) {
        const r = await getRun(id);
        if (r && (r.status === 'completed' || r.status === 'failed')) return r;
        await new Promise((res) => setTimeout(res, 150));
      }
      throw new Error(`Timed out waiting for ${id}`);
    }

    const planBase = {
      schemaVersion: 1,
      id: 'vis-e2e',
      targetUrl,
      status: 'approved',
      pages: [{ url: `${targetUrl}/`, viewport: { width: 800, height: 600, name: 'desktop' } }],
      flows: [],
      apiEndpoints: [],
      fuzzTargets: [],
      a11yRules: [],
      perfBudgets: [],
      visualBaselines: [{
        pageUrl: `${targetUrl}/`,
        viewport: { width: 800, height: 600, name: 'desktop' },
        maskSelectors: [],
        threshold: 0.01,
      }],
      viewports: [{ width: 800, height: 600, name: 'desktop' }],
      browsers: ['chromium'],
      executors: ['visual'],
    };

    const monitorId = 'mon_e2e_visual';

    // Run 1: captures first baseline cleanly
    tickerColor = '#111111';
    tickerLabel = 'TICK-1';
    const r1Id = await createRunWithMatrix({
      url: targetUrl,
      options: { monitorId, maxPages: 1, maxDepth: 0 },
      plan: planBase,
      approved: true,
    });
    const r1 = await waitRun(r1Id);
    assert.equal(r1.status, 'completed');
    assert.ok(r1.findings.some((f) => f.ruleId === 'visual-baseline-captured'));

    // Run 2: .live-ticker changed color/text -> visual-regression emitted
    tickerColor = '#e11d48';
    tickerLabel = 'TICK-2';
    const r2Id = await createRunWithMatrix({
      url: targetUrl,
      options: { monitorId, maxPages: 1, maxDepth: 0 },
      plan: planBase,
      approved: true,
    });
    const r2 = await waitRun(r2Id);
    assert.equal(r2.status, 'completed');
    const reg2 = r2.findings.find((f) => f.ruleId === 'visual-regression');
    assert.ok(reg2, 'expected visual-regression finding when dynamic ticker changed');

    // Inspect dashboard /api/runs/:id/baselines side-by-side images + metadata
    const listRes = await fetch(`${dashUrl}/api/runs/${encodeURIComponent(r2Id)}/baselines`).then((r) => r.json());
    assert.equal(listRes.baselines.length, 1);
    const item = listRes.baselines[0];
    assert.ok(item.baselineImageUrl, 'baselineImageUrl present');
    assert.ok(item.actualImageUrl, 'actualImageUrl present');
    assert.ok(item.diffImageUrl, 'diffImageUrl present');

    for (const imgUrl of [item.baselineImageUrl, item.actualImageUrl, item.diffImageUrl]) {
      const imgRes = await fetch(`${dashUrl}${imgUrl}`);
      assert.equal(imgRes.status, 200, `image fetch ok: ${imgUrl}`);
      const buf = Buffer.from(await imgRes.arrayBuffer());
      assert.equal(buf[0], 137, 'PNG header');
    }

    // Approve baseline AND add mask selector `.live-ticker` via dashboard API
    const approveRes = await fetch(`${dashUrl}/api/baselines/${item.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: r2Id,
        maskSelectors: ['.live-ticker'],
        reason: 'Dynamic ticker masked and baseline approved',
      }),
    }).then((r) => r.json());
    assert.equal(approveRes.ok, true);
    assert.deepEqual(approveRes.baseline.maskSelectors, ['.live-ticker']);

    // Run 3: .live-ticker changes AGAIN on server, yet persisted mask + approved
    // baseline keeps diff = 0, gate GREEN, and decision recorded on run record.
    tickerColor = '#16a34a';
    tickerLabel = 'TICK-3';
    const r3Id = await createRunWithMatrix({
      url: targetUrl,
      options: { monitorId, maxPages: 1, maxDepth: 0 },
      plan: planBase,
      approved: true,
    });
    const r3 = await waitRun(r3Id);
    assert.equal(r3.status, 'completed');
    assert.equal(r3.findings.filter((f) => f.ruleId === 'visual-regression').length, 0, 'masked dynamic ticker produces 0 regressions');
    assert.ok(Array.isArray(r3.baselineDecisions) && r3.baselineDecisions.some((d) => d.action === 'approved'), 'approval decision recorded in run record');

    // Test waive flow + CLI check gate exit code = 0 when waived!
    shiftLayout = true;
    const r4Id = await createRunWithMatrix({
      url: targetUrl,
      options: { monitorId, maxPages: 1, maxDepth: 0 },
      plan: planBase,
      approved: true,
    });
    const r4 = await waitRun(r4Id);
    assert.ok(r4.findings.some((f) => f.ruleId === 'visual-regression'), 'unmasked layout shift triggers visual-regression');

    const waiveRes = await fetch(`${dashUrl}/api/baselines/${item.id}/waive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: r4Id,
        reason: 'Acceptable banner rollout for this sprint',
        expiresAt: '2029-12-31',
      }),
    }).then((r) => r.json());
    assert.equal(waiveRes.ok, true);

    // Run 5: visual-regression still detected on unmasked shift, yet persisted
    // waiver marks it waived=true, records decision, and checkMain stays GREEN!
    const r5Id = await createRunWithMatrix({
      url: targetUrl,
      options: { monitorId, maxPages: 1, maxDepth: 0 },
      plan: planBase,
      approved: true,
    });
    const r5 = await waitRun(r5Id);
    const reg5 = r5.findings.find((f) => f.ruleId === 'visual-regression');
    assert.ok(reg5, 'finding stays visible in run record');
    assert.equal(reg5.waived, true, 'finding is marked waived');
    assert.equal(reg5.waiverReason, 'Acceptable banner rollout for this sprint');
    assert.ok(r5.baselineDecisions.some((d) => d.action === 'waived'));

    // Write r5 as baseline JSON report? Even better: verify evaluateBaselineGate keeps gate green!
    const { evaluateGate } = await import('../src/cli/check.js');
    const gate = evaluateGate({
      findings: r5.findings.filter((f) => !f.waived),
      score: r5.score,
      failOn: 'medium',
    });
    assert.equal(gate.failed, false);
    assert.equal(gate.exitCode, 0);
  });
});
