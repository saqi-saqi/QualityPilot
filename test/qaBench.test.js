/**
 * test/qaBench.test.js — fast deterministic regression tests for WS5 QA-Bench v1.0.0.
 *
 * Verifies:
 *   1. groundtruth.json declares >= 50 seeded regressions across E2E, API, a11y,
 *      security, visual (+ perf) and 5 explicit false-positive controls.
 *   2. buildQaBenchPlan() produces a valid approved TestPlan across all domains.
 *   3. startQaBenchServer() starts in both 'clean' and 'regressed' modes and
 *      enforces anon / user / admin session auth + seeded regressions.
 *   4. evaluateQaBenchRun() scores matched findings, missed items, and FP guards.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startQaBenchServer } from '../benchmark/qa-bench/server.js';
import { buildQaBenchPlan } from '../benchmark/qa-bench/plan.js';
import { evaluateQaBenchRun } from '../benchmark/run-qa-bench.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GT_PATH = path.join(REPO_ROOT, 'benchmark', 'qa-bench', 'groundtruth.json');

test('qa-bench groundtruth declares >= 50 seeded regressions across all required domains', async () => {
  const gt = JSON.parse(await fs.readFile(GT_PATH, 'utf8'));
  assert.ok(gt.expected.length >= 50, `Expected >= 50 seeded regressions, got ${gt.expected.length}`);
  assert.equal(gt.mustNotFind.length, 5);

  const domains = new Set(gt.expected.map((e) => e.domain));
  for (const required of ['a11y', 'security', 'api_runtime', 'e2e', 'visual', 'perf']) {
    assert.ok(domains.has(required), `Missing domain ${required} in groundtruth.json`);
  }
  const roles = new Set(gt.expected.map((e) => e.role));
  for (const role of ['anon', 'user', 'admin']) {
    assert.ok(roles.has(role), `Missing role ${role} in groundtruth.json`);
  }
});

test('buildQaBenchPlan validates cleanly against TestPlan schema', () => {
  const plan = buildQaBenchPlan('http://127.0.0.1:4100');
  assert.equal(plan.status, 'approved');
  assert.equal(plan.flows.length, 8);
  assert.ok(plan.apiEndpoints.length >= 14);
  assert.equal(plan.visualBaselines.length, 5);
  assert.deepEqual(plan.a11yRules, []);
});

test('qa-bench server switches clean <-> regressed and handles auth roles + seeded bugs', async () => {
  const srv = await startQaBenchServer({ clean: false });
  try {
    // Unauthenticated private orders returns 401
    const anonPrivate = await fetch(`${srv.url}/api/orders/private`);
    assert.equal(anonPrivate.status, 401);

    // Benign login fails 401; valid user succeeds 200 and accesses private orders
    const badLogin = await fetch(`${srv.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nope@novaops.local', password: 'wrong' }),
    });
    assert.equal(badLogin.status, 401);

    const userLogin = await fetch(`${srv.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@novaops.local', password: 'UserBench!2026' }),
    });
    assert.equal(userLogin.status, 200);
    const cookie = userLogin.headers.get('set-cookie').split(';')[0];

    const authedPrivate = await fetch(`${srv.url}/api/orders/private`, {
      headers: { Cookie: cookie },
    });
    assert.equal(authedPrivate.status, 200);

    // Regressed admin endpoint reachable anonymously & billing summary 500
    const adminLeak = await fetch(`${srv.url}/api/admin/audit-settings`);
    assert.equal(adminLeak.status, 200);
    const billingErr = await fetch(`${srv.url}/api/billing/summary`);
    assert.equal(billingErr.status, 500);

    // Switching to clean restores healthy responses & authz check
    srv.setMode('clean');
    const cleanAdmin = await fetch(`${srv.url}/api/admin/audit-settings`);
    assert.equal(cleanAdmin.status, 403);
    const cleanBilling = await fetch(`${srv.url}/api/billing/summary`);
    assert.equal(cleanBilling.status, 200);
  } finally {
    await srv.close();
  }
});

test('evaluateQaBenchRun scores matched expectations and catches FP violations', async () => {
  const gt = JSON.parse(await fs.readFile(GT_PATH, 'utf8'));
  const score = evaluateQaBenchRun({
    groundtruth: gt,
    runReport: {
      findings: [
        { ruleId: 'transport-http', pageUrl: 'http://127.0.0.1:4100/' },
        { ruleId: 'e2e-flow-selector-timeout', pageUrl: 'http://127.0.0.1:4100/workspace', title: 'E2E flow failed: e2e-archive-modal' },
        { ruleId: 'axe-label', pageUrl: 'http://127.0.0.1:4100/clean-health', title: 'False a11y alert' },
      ],
    },
  });

  assert.equal(score.matchedCount, 2);
  assert.equal(score.fpViolationCount, 1);
  assert.equal(score.fpViolations[0].id, 'QB-FP-01');
});

test('perf capturePerfMetrics never emits bare 0 TTFB with measured=true (sub-ms invariant)', async () => {
  const { capturePerfMetrics } = await import('../src/executors/perf.js');
  const mockPage = {
    addInitScript: async () => {},
    goto: async () => {},
    waitForTimeout: async () => {},
    evaluate: async (fn) => {
      const src = fn.toString();
      if (src.includes('__perfEntries')) {
        return {
          LCP: 0.4,
          CLS: 0,
          FCP: 0.2,
          TTFB: 0.3,
          TBT: 0,
          INP: null,
          measured: { LCP: true, CLS: true, FCP: true, TTFB: true, TBT: true, INP: false },
        };
      }
      return { requestCount: 1, pageSizeBytes: 2048 };
    },
  };
  const { metrics } = await capturePerfMetrics(mockPage, 'http://127.0.0.1:4100/', { settleMs: 1 });
  assert.equal(metrics.TTFB, 1);
  assert.equal(metrics.LCP, 1);
  assert.equal(metrics.FCP, 1);
  assert.equal(metrics.INP, 'unmeasured');
  assert.equal(metrics.measured.TTFB, true);
  assert.equal(metrics.measured.INP, false);
});
