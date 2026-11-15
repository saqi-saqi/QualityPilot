import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportPlanJson, importPlanJson, PLAN_EXPORT_KIND } from '../src/export/planJson.js';
import { exportPlaywrightSpecs, HEALER_FILENAME } from '../src/export/playwright.js';
import { exportMain } from '../src/cli/export.js';
import { startFixtureServer } from './fixtures/site/server.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// A plan exercising every exported step type (unit-level; not executed).
function fullCoveragePlan(targetUrl) {
  return {
    schemaVersion: 1,
    id: 'export-plan',
    targetUrl,
    flows: [{
      name: 'Checkout journey',
      description: 'Covers every exported step mapping',
      startUrl: `${targetUrl}/page-ok.html`,
      steps: [
        { action: 'navigate', selector: `${targetUrl}/page-ok.html` },
        { action: 'assertStatus', status: 200 },
        { action: 'click', selector: '#login-btn' },
        { action: 'fill', selector: 'input[name="email"]', value: '${TEST_EMAIL}' },
        { action: 'select', selector: '#country', value: 'de' },
        { action: 'check', selector: '#terms' },
        { action: 'wait', ms: 250 },
        { action: 'assertVisible', selector: '.dashboard', timeoutMs: 5000 },
        { action: 'assertText', selector: 'h1', contains: 'Dashboard' },
        { action: 'assertUrl', urlContains: '/dashboard' },
        { action: 'api-request', method: 'POST', url: `${targetUrl}/api/echo`, expectStatus: 200, expectJsonPath: 'data.ok', saveAsVar: 'echoResp', body: '{"ok":true}' },
      ],
    }],
  };
}

describe('export/planJson', () => {
  it('normalizes the plan (defaults applied) and emits the documented envelope', () => {
    const artifact = exportPlanJson({
      schemaVersion: 1,
      id: 'p',
      targetUrl: 'https://example.com',
      flows: [{ name: 'F', startUrl: 'https://example.com/x', steps: [{ action: 'click', selector: '#b' }] }],
    }, { source: 'unit test' });

    assert.equal(artifact.kind, PLAN_EXPORT_KIND);
    assert.equal(artifact.formatVersion, 1);
    assert.equal(artifact.generator.name, 'QualityPilot');
    assert.equal(artifact.source, 'unit test');
    assert.ok(artifact.exportedAt);
    // Defaults materialized by normalization:
    assert.deepEqual(artifact.plan.flows[0].retry, { maxAttempts: 2, backoffMs: 500 });
    assert.deepEqual(artifact.plan.flows[0].tags, []);
  });

  it('throws with the zod issue text for an invalid plan', () => {
    // targetUrl is required with no default — omitting it must throw with a
    // path-tagged zod issue.
    assert.throws(
      () => exportPlanJson({ schemaVersion: 1, id: 'p' }),
      /targetUrl/i,
    );
  });

  it('round-trips: importPlanJson(exportPlanJson(plan)) deep-equals the normalized plan', () => {
    const plan = {
      schemaVersion: 1,
      id: 'rt',
      targetUrl: 'https://example.com',
      flows: [{
        name: 'Journey',
        startUrl: 'https://example.com/a',
        steps: [
          { action: 'navigate', selector: 'https://example.com/a' },
          { action: 'fill', selector: '#e', value: 'x' },
          { action: 'assertVisible', selector: '#ok' },
        ],
      }],
    };
    const artifact = exportPlanJson(plan);
    const reimported = importPlanJson(JSON.parse(JSON.stringify(artifact)));
    assert.deepEqual(reimported, artifact.plan);
  });

  it('importPlanJson rejects foreign envelopes', () => {
    assert.throws(() => importPlanJson({ kind: 'other/thing', plan: {} }), /not a QualityPilot plan export/i);
    assert.throws(() => importPlanJson({ kind: PLAN_EXPORT_KIND }), /artifact\.plan is missing/i);
    assert.throws(() => importPlanJson({}), /not a QualityPilot plan export/i);
  });
});

describe('export/playwright', () => {
  let spec, files;
  beforeEach(() => {
    const plan = fullCoveragePlan('http://127.0.0.1:39999');
    ({ files } = exportPlaywrightSpecs(plan, { source: 'unit' }));
    spec = files.find((f) => f.name === 'checkout-journey.spec.ts');
  });

  it('emits one spec file per flow plus the healer', () => {
    assert.equal(files.filter((f) => f.name.endsWith('.spec.ts')).length, 1);
    assert.ok(files.some((f) => f.name === HEALER_FILENAME), 'healer helper must ship in the bundle');
  });

  it('maps navigate+assertStatus into a captured-goto pair', () => {
    assert.match(spec.content, /const __resp = await page\.goto\('http:\/\/127\.0\.0\.1:39999\/page-ok\.html'\);/);
    assert.match(spec.content, /await qExpectStatus\(__resp, 200\);/);
  });

  it('routes interaction steps through the healer with ${VAR} interpolation', () => {
    assert.match(spec.content, /await qClick\(page, '#login-btn'\);/);
    assert.match(spec.content, /await qFill\(page, 'input\[name="email"\]', qs\('\$\{TEST_EMAIL\}'\)\);/);
    assert.match(spec.content, /await qSelect\(page, '#country', 'de'\);/);
    assert.match(spec.content, /await qCheck\(page, '#terms'\);/);
  });

  it('maps waits, assertions and URL checks to Playwright-native calls', () => {
    assert.match(spec.content, /await page\.waitForTimeout\(250\);/);
    assert.match(spec.content, /await expect\(page\.locator\('\.dashboard'\)\)\.toBeVisible\(\{ timeout: 5000 \}\);/);
    assert.match(spec.content, /await expect\(page\.locator\('h1'\)\)\.toContainText\('Dashboard'\);/);
    assert.match(spec.content, /await expect\(page\)\.toHaveURL\(new RegExp\('\/dashboard'\)\);/);
  });

  it('emits api-request steps with the request fixture and json-path assertion', () => {
    assert.match(spec.content, /async \(\{ page, request \}\) => \{/);
    assert.match(spec.content, /await request\.fetch\('http:\/\/127\.0\.0\.1:39999\/api\/echo', \{/);
    assert.match(spec.content, /expect\(__res\.status\(\)\)\.toBe\(200\);/);
    assert.match(spec.content, /expect\(qJsonPath\(__json, 'data\.ok'\), 'json path data\.ok'\)\.toBeDefined\(\);/);
    assert.match(spec.content, /run variable 'echoResp'/);
  });

  it('emits the retry policy when maxAttempts > 1', () => {
    const plan = fullCoveragePlan('http://127.0.0.1:39999');
    plan.flows[0].retry = { maxAttempts: 3, backoffMs: 250 };
    const { files: retryFiles } = exportPlaywrightSpecs(plan);
    const retrySpec = retryFiles.find((f) => f.name === 'checkout-journey.spec.ts');
    assert.match(retrySpec.content, /test\.describe\.configure\(\{ retries: 2 \}\);/);
  });

  it('groups non-auth flows per role when storageStateByRole is given', () => {
    const plan = {
      schemaVersion: 1,
      id: 'roles',
      targetUrl: 'https://example.com',
      flows: [{
        name: 'Browse',
        startUrl: 'https://example.com/a',
        steps: [{ action: 'assertVisible', selector: 'main' }],
      }],
    };
    const { files: grouped } = exportPlaywrightSpecs(plan, {
      storageStateByRole: { anon: 'states/anon.json', user: 'states/user.json' },
    });
    const specFile = grouped.find((f) => f.name === 'browse.spec.ts');
    assert.match(specFile.content, /test\.describe\('anon', \(\) => \{\s*test\.use\(\{ storageState: 'states\/anon\.json' \}\);/);
    assert.match(specFile.content, /test\.describe\('user', \(\) => \{/);
    assert.equal((specFile.content.match(/test\.use\(/g) || []).length, 2);
  });

  it('emits auth flows into a dedicated auth-setup describe', () => {
    const plan = {
      schemaVersion: 1,
      id: 'auth',
      targetUrl: 'https://example.com',
      flows: [{
        name: 'Login',
        startUrl: 'https://example.com/login',
        auth: { type: 'cookie', loginFlow: 'Login' },
        steps: [{ action: 'fill', selector: '#email', value: 'a@b.c' }],
      }],
    };
    const { files: withAuth } = exportPlaywrightSpecs(plan);
    const authSpec = withAuth.find((f) => f.name === 'auth-setup.spec.ts');
    assert.ok(authSpec, 'auth flows emit auth-setup.spec.ts');
    assert.match(authSpec.content, /replace with recorded storage states/);
    assert.match(authSpec.content, /Auth flows perform the recorded login/);
  });

  it('healer is a TypeScript port of the runtime ladder (testid → role → text)', () => {
    const healer = files.find((f) => f.name === HEALER_FILENAME).content;
    assert.match(healer, /data-testid/);
    assert.match(healer, /getByRole/);
    assert.match(healer, /getByText/);
    assert.match(healer, /process\.env\[name\] \?\? ''/);
  });
});

describe('export CLI', () => {
  it('writes plan.json + specs and returns 0; usage errors return 64', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-export-'));
    const planPath = path.join(tmp, 'plan-in.json');
    fs.writeFileSync(planPath, JSON.stringify(fullCoveragePlan('https://example.com')));
    const outDir = path.join(tmp, 'out');

    const code = await exportMain(['qualitypilot', 'export', planPath, '--out', outDir]);
    assert.equal(code, 0);
    assert.ok(fs.existsSync(path.join(outDir, 'plan.json')));
    assert.ok(fs.existsSync(path.join(outDir, 'checkout-journey.spec.ts')));
    assert.ok(fs.existsSync(path.join(outDir, HEALER_FILENAME)));

    const usage = await exportMain(['qualitypilot', 'export']);
    assert.equal(usage, 64);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('rejects unknown formats with exit 64', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-export-'));
    const planPath = path.join(tmp, 'p.json');
    fs.writeFileSync(planPath, JSON.stringify(fullCoveragePlan('https://example.com')));
    const code = await exportMain(['qualitypilot', 'export', planPath, '--format', 'wat']);
    assert.equal(code, 64);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('export runtime drift guard (generated spec executes via @playwright/test)', () => {
  it('runs the generated spec against the fixture site — green', async () => {
    const fx = await startFixtureServer();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-spec-run-'));
    try {
      const plan = {
        schemaVersion: 1,
        id: 'rt-run',
        targetUrl: fx.url,
        flows: [{
          name: 'Clean baseline visit',
          startUrl: `${fx.url}/page-ok.html`,
          steps: [
            { action: 'navigate', selector: `${fx.url}/page-ok.html` },
            { action: 'assertText', selector: 'h1', contains: 'Clean Baseline Page' },
            { action: 'assertUrl', urlContains: '/page-ok.html' },
          ],
        }],
      };
      const { files } = exportPlaywrightSpecs(plan);
      for (const f of files) fs.writeFileSync(path.join(tmp, f.name), f.content, 'utf8');
      fs.writeFileSync(path.join(tmp, 'playwright.config.mjs'),
        `export default { testDir: '.', use: { baseURL: '${fx.url}' }, retries: 0 };\n`);
      // The exported spec imports '@playwright/test' — make the repo's install
      // resolvable from the isolated tmp dir (junction keeps ESM resolution happy).
      try {
        fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(tmp, 'node_modules'), 'junction');
      } catch {
        fs.cpSync(path.join(repoRoot, 'node_modules'), path.join(tmp, 'node_modules'), { recursive: true });
      }

      const cli = path.join(repoRoot, 'node_modules', '@playwright', 'test', 'cli.js');
      // Async spawn (NOT spawnSync): the fixture server runs in THIS process's
      // event loop — spawnSync would freeze it and the child's requests would
      // hang (ERR_ABORTED). Async keeps the loop live while the child runs.
      const child = spawn(process.execPath, [cli, 'test', '--config', path.join(tmp, 'playwright.config.mjs'), '--reporter', 'line'], {
        cwd: tmp, timeout: 180000, killSignal: 'SIGKILL',
      });
      let out = '';
      child.stdout?.on('data', (d) => { out += d; });
      child.stderr?.on('data', (d) => { out += d; });
      const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c ?? 1)));
      assert.equal(code, 0, `generated spec must pass\nstdout: ${out.slice(-1200)}`);
      assert.match(out, /1 passed/);
    } finally {
      if (fx.server?.close) fx.server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
