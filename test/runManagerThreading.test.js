/**
 * test/runManagerThreading.test.js — regression tests for the 2026-11-24
 * audit's option-threading findings.
 *
 *   H-2  `--authorized-target` was stored on the run but never forwarded to
 *        runMatrix, so the injection executor's non-loopback gate could
 *        never open. `--openapi` had the same defect one layer up
 *        (createRunWithMatrix dropped the parsed spec entirely).
 *   M-1  `--login <typo>` silently degraded to an anonymous scan.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Private-target opt-in MUST be set before any app module import (config
// freezes env at load): the M-1 case scans the loopback fixture server.
process.env.NODE_ENV = 'test';
process.env.SQA_ALLOW_PRIVATE = 'true';
process.env.ALLOW_PRIVATE_HOSTS = 'true';

const {
  buildRunOptions,
  matrixOptionsForRun,
  createRunWithMatrix,
  getRun,
} = await import('../src/services/runManager.js');

describe('run options — persistence (audit H-2)', () => {
  it('keeps --openapi, --authorized-target and --login on the run record', () => {
    const opts = buildRunOptions({
      openapiSpec: { endpoints: [{ path: '/x' }] },
      authorizedTarget: true,
      loginRecording: 'rec',
      maxPages: 500,
      concurrency: 9,
    });
    assert.equal(opts.authorizedTarget, true);
    assert.deepEqual(opts.openapiSpec, { endpoints: [{ path: '/x' }] }, 'the parsed spec must survive the run record');
    assert.equal(opts.loginRecording, 'rec');
    assert.equal(opts.maxPages, 100, 'maxPages stays capped');
    assert.equal(opts.concurrency, 4, 'concurrency stays capped');
  });

  it('defaults to an unauthorized run', () => {
    const opts = buildRunOptions({});
    assert.equal(opts.authorizedTarget, false);
    assert.equal('openapiSpec' in opts, false);
  });
});

describe('matrix options — threading (audit H-2)', () => {
  it('forwards authorizedTarget and page records without Playwright handles', () => {
    const run = {
      url: 'https://staging.example.com',
      options: buildRunOptions({ authorizedTarget: true, activeTesting: false }),
    };
    const opts = matrixOptionsForRun(run, {
      runId: 'run_x',
      pages: [{ url: 'https://staging.example.com/a', links: ['/b'], page: { fake: true } }],
    });
    assert.equal(opts.authorizedTarget, true, 'injection gate input reaches the matrix');
    assert.equal(opts.allowActiveFuzz, false, 'fuzz mutation stays behind activeTesting');
    assert.deepEqual(opts.pages, [{ url: 'https://staging.example.com/a', links: ['/b'] }]);
    assert.equal(opts.siteOrigin, 'https://staging.example.com');
    assert.deepEqual(opts.coveredPages, ['https://staging.example.com/a']);
  });

  it('does not authorize when the run was not authorized', () => {
    const opts = matrixOptionsForRun({ url: 'https://x.test', options: buildRunOptions({}) });
    assert.equal(opts.authorizedTarget, false);
  });
});

describe('M-1 — explicit --login with a missing recording', () => {
  it('fails the run instead of silently scanning anonymously', async () => {
    const { startFixtureServer } = await import('./fixtures/site/server.js');
    const fx = await startFixtureServer();
    try {
      const runId = await createRunWithMatrix({
        url: fx.url,
        options: { loginRecording: 'no-such-recording', maxPages: 1, maxDepth: 0 },
      });
      let run;
      for (let i = 0; i < 100; i++) {
        run = await getRun(runId);
        if (run && (run.status === 'failed' || run.status === 'completed')) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(run?.status, 'failed', 'a missing recording must not produce a completed anonymous run');
      assert.match(run.error, /No recorded login session named "no-such-recording"/);
    } finally {
      if (fx.server?.close) fx.server.close();
    }
  });
});
