import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Private-target opt-in MUST be set before any app module import (config
// freezes env at load): the replay scans the loopback fixture server.
process.env.NODE_ENV = 'test';
process.env.SQA_ALLOW_PRIVATE = 'true';
process.env.ALLOW_PRIVATE_HOSTS = 'true';

const { replayMain, retargetPlan } = await import('../src/cli/replay.js');
const { exportPlanJson } = await import('../src/export/planJson.js');

function planArtifact(targetUrl) {
  return exportPlanJson({
    schemaVersion: 1,
    id: 'replay-plan',
    targetUrl,
    executors: ['e2e'],
    flows: [{
      name: 'Clean baseline visit',
      startUrl: `${targetUrl}/page-ok.html`,
      steps: [
        { action: 'navigate', selector: `${targetUrl}/page-ok.html` },
        { action: 'assertText', selector: 'h1', contains: 'Clean Baseline Page' },
        { action: 'assertUrl', urlContains: '/page-ok.html' },
      ],
    }],
  }, { source: 'replay test' });
}

describe('replay — retargetPlan', () => {
  it('rewrites same-origin recorded URLs to the new target origin (path+query preserved)', () => {
    const plan = {
      targetUrl: 'https://prod.example.com',
      flows: [{
        name: 'J',
        startUrl: 'https://prod.example.com/login?next=/dash',
        steps: [
          { action: 'navigate', selector: 'https://prod.example.com/login' },
          { action: 'api-request', method: 'GET', url: 'https://prod.example.com/api/users?page=2' },
        ],
      }],
      apiEndpoints: [{ method: 'GET', path: '/api/users', baseUrl: 'https://prod.example.com' }],
    };
    const out = retargetPlan(plan, 'https://preview-staging.example.dev');
    assert.equal(out.targetUrl, 'https://preview-staging.example.dev');
    assert.equal(out.flows[0].startUrl, 'https://preview-staging.example.dev/login?next=/dash');
    assert.equal(out.flows[0].steps[0].selector, 'https://preview-staging.example.dev/login');
    assert.equal(out.flows[0].steps[1].url, 'https://preview-staging.example.dev/api/users?page=2');
    assert.equal(out.apiEndpoints[0].baseUrl, 'https://preview-staging.example.dev');
  });

  it('leaves cross-origin URLs untouched', () => {
    const plan = {
      targetUrl: 'https://prod.example.com',
      flows: [{
        name: 'J',
        startUrl: 'https://prod.example.com/a',
        steps: [{ action: 'navigate', selector: 'https://thirdparty.test/widget' }],
      }],
    };
    const out = retargetPlan(plan, 'https://preview.example.dev');
    assert.equal(out.flows[0].steps[0].selector, 'https://thirdparty.test/widget');
  });
});

describe('replay — CLI', () => {
  it('replays an exported plan against the fixture site and passes the gate', async () => {
    const fx = await (await import('./fixtures/site/server.js')).startFixtureServer();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-replay-'));
    try {
      const planPath = path.join(tmp, 'plan.json');
      fs.writeFileSync(planPath, JSON.stringify(planArtifact(fx.url)));
      const code = await replayMain(['qualitypilot', 'replay', planPath, '--timeout', '180000']);
      assert.equal(code, 0, 'clean fixture plan must pass the gate');
    } finally {
      if (fx.server?.close) fx.server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('missing plan file → exit 70; missing args → exit 64', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-replay-'));
    const code = await replayMain(['qualitypilot', 'replay', path.join(tmp, 'nope.json')]);
    assert.equal(code, 70);
    const usage = await replayMain(['qualitypilot', 'replay']);
    assert.equal(usage, 64);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('appends a markdown job summary when GITHUB_STEP_SUMMARY is set', async () => {
    const fx = await (await import('./fixtures/site/server.js')).startFixtureServer();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-replay-'));
    const summaryPath = path.join(tmp, 'step-summary.md');
    process.env.GITHUB_STEP_SUMMARY = summaryPath;
    try {
      const planPath = path.join(tmp, 'plan.json');
      fs.writeFileSync(planPath, JSON.stringify(planArtifact(fx.url)));
      const code = await replayMain(['qualitypilot', 'replay', planPath, '--timeout', '180000']);
      assert.equal(code, 0);
      const summary = fs.readFileSync(summaryPath, 'utf8');
      assert.match(summary, /## QualityPilot replay — replay-plan/);
      assert.match(summary, /Gate \|/);
    } finally {
      delete process.env.GITHUB_STEP_SUMMARY;
      if (fx.server?.close) fx.server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
