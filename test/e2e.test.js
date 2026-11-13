import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import e2eExecutor, {
  runStep,
  runFlow,
  checkUrlSafety,
  substituteStepValue,
  readJsonPath,
  captureFailureScreenshot,
  resolveUpload,
} from '../src/executors/e2e.js';
import {
  resolveLocator,
  resolveLocatorDetailed,
  extractSelectorName,
  inferRoleFromSelector,
  buildFallbackCandidates,
} from '../src/executors/selectorResolver.js';
import * as testData from '../src/services/testData.js';
import { createFindingFactory } from '../src/services/findingFactory.js';

// ─── MockPage + MockLocator ────────────────────────────────────────

class MockLocator {
  constructor(page, selector) {
    this.page = page;
    this.selector = selector;
  }
  async click() { this.page._calls.push(['click', this.selector]); }
  async fill(value) { this.page._calls.push(['fill', this.selector, value]); this.page._filled[this.selector] = value; }
  async selectOption(value) { this.page._calls.push(['selectOption', this.selector, value]); }
  async check() { this.page._calls.push(['check', this.selector]); }
  async uncheck() { this.page._calls.push(['uncheck', this.selector]); }
  async hover() { this.page._calls.push(['hover', this.selector]); }
  async focus() { this.page._calls.push(['focus', this.selector]); }
  async press(key) { this.page._calls.push(['press', this.selector, key]); }
  async setInputFiles(filePath) { this.page._calls.push(['setInputFiles', this.selector, filePath]); }
  async waitFor({ state }) { this.page._calls.push(['waitFor', this.selector, state]); }
  async textContent() {
    this.page._calls.push(['textContent', this.selector]);
    return this.page._textContent[this.selector] ?? 'mock-text';
  }
}

class MockPage {
  constructor(opts = {}) {
    this._calls = [];
    this._filled = {};
    this._textContent = opts.textContent || {};
    this._gotoResult = opts.gotoResult || {};
    this._url = opts.url || 'https://example.com';
    this.lastStatus = opts.lastStatus ?? null;
    this.viewport = null;
  }
  locator(selector) { return new MockLocator(this, selector); }
  async goto(url) { this._calls.push(['goto', url]); this._url = url; this.lastStatus = this._gotoResult[url] ?? 200; }
  url() { return this._url; }
  async waitForTimeout(ms) { this._calls.push(['waitForTimeout', ms]); }
  async setViewportSize(size) { this.viewport = size; }
  async close() { this._calls.push(['close']); }
  async screenshot() { this._calls.push(['screenshot']); return Buffer.from('fake'); }
}

// ─── runStep ───────────────────────────────────────────────────────

describe('runStep', () => {
  let page;
  beforeEach(() => {
    page = new MockPage();
  });

  it('navigate calls page.goto with the URL', async () => {
    await runStep({ action: 'navigate', selector: 'https://example.com' }, page);
    assert.deepEqual(page._calls[0], ['goto', 'https://example.com']);
  });

  it('click calls locator.click', async () => {
    await runStep({ action: 'click', selector: '#btn' }, page);
    assert.deepEqual(page._calls[0], ['click', '#btn']);
  });

  it('fill calls locator.fill with value', async () => {
    await runStep({ action: 'fill', selector: '#input', value: 'hello' }, page);
    assert.deepEqual(page._calls[0], ['fill', '#input', 'hello']);
    assert.equal(page._filled['#input'], 'hello');
  });

  it('fill with no value defaults to empty string', async () => {
    await runStep({ action: 'fill', selector: '#input' }, page);
    assert.equal(page._filled['#input'], '');
  });

  it('select calls locator.selectOption', async () => {
    await runStep({ action: 'select', selector: '#dropdown', value: 'opt1' }, page);
    assert.deepEqual(page._calls[0], ['selectOption', '#dropdown', 'opt1']);
  });

  it('check + uncheck + hover + focus all dispatch', async () => {
    await runStep({ action: 'check', selector: '#c' }, page);
    await runStep({ action: 'uncheck', selector: '#c' }, page);
    await runStep({ action: 'hover', selector: '#h' }, page);
    await runStep({ action: 'focus', selector: '#f' }, page);
    assert.deepEqual(page._calls[0], ['check', '#c']);
    assert.deepEqual(page._calls[1], ['uncheck', '#c']);
    assert.deepEqual(page._calls[2], ['hover', '#h']);
    assert.deepEqual(page._calls[3], ['focus', '#f']);
  });

  it('press calls locator.press with key', async () => {
    await runStep({ action: 'press', selector: '#input', value: 'Enter' }, page);
    assert.deepEqual(page._calls[0], ['press', '#input', 'Enter']);
  });

  it('upload calls setInputFiles with sandbox-resolved path', async () => {
    await runStep({ action: 'upload', selector: '#file', value: 'sample.txt' }, page);
    assert.equal(page._calls[0][0], 'setInputFiles');
    assert.equal(page._calls[0][1], '#file');
    assert.ok(page._calls[0][2].endsWith('sample.txt'));
  });

  it('rejects uploads outside the sandbox or traversing paths', () => {
    assert.throws(() => resolveUpload('.env'), /Upload outside sandbox|Upload file not found/);
    assert.throws(() => resolveUpload('../.env'), /Upload outside sandbox|Upload file not found/);
    assert.throws(() => resolveUpload('/etc/passwd'), /Upload outside sandbox|Upload file not found/);
    assert.throws(() => resolveUpload('nonexistent-file-12345.xyz'), /Upload file not found/);
  });

  it('wait with ms calls waitForTimeout', async () => {
    await runStep({ action: 'wait', ms: 500 }, page);
    assert.deepEqual(page._calls[0], ['waitForTimeout', 500]);
  });

  it('wait with selector calls locator.waitFor visible', async () => {
    await runStep({ action: 'wait', selector: '#el', state: 'visible' }, page);
    assert.deepEqual(page._calls[0], ['waitFor', '#el', 'visible']);
  });

  it('assertVisible calls locator.waitFor visible', async () => {
    await runStep({ action: 'assertVisible', selector: '#el' }, page);
    assert.deepEqual(page._calls[0], ['waitFor', '#el', 'visible']);
  });

  it('assertHidden calls locator.waitFor hidden', async () => {
    await runStep({ action: 'assertHidden', selector: '#el' }, page);
    assert.deepEqual(page._calls[0], ['waitFor', '#el', 'hidden']);
  });

  it('assertText with equals passes when text matches', async () => {
    page._textContent['h1'] = 'Welcome';
    await runStep({ action: 'assertText', selector: 'h1', equals: 'Welcome' }, page);
    // No throw
    assert.deepEqual(page._calls[0], ['textContent', 'h1']);
  });

  it('assertText with equals throws when text does not match', async () => {
    page._textContent['h1'] = 'Wrong';
    await assert.rejects(
      () => runStep({ action: 'assertText', selector: 'h1', equals: 'Welcome' }, page),
      /assertText failed/i,
    );
  });

  it('assertText with contains passes when text contains substring', async () => {
    page._textContent['h1'] = 'Welcome to the app';
    await runStep({ action: 'assertText', selector: 'h1', contains: 'Welcome' }, page);
  });

  it('assertText with contains throws when text lacks substring', async () => {
    page._textContent['h1'] = 'About Us';
    await assert.rejects(
      () => runStep({ action: 'assertText', selector: 'h1', contains: 'Welcome' }, page),
      /does not contain/i,
    );
  });

  it('assertUrl with url passes when URL matches', async () => {
    page._url = 'https://example.com/dashboard';
    await runStep({ action: 'assertUrl', url: 'https://example.com/dashboard' }, page);
  });

  it('assertUrl with url throws on mismatch', async () => {
    page._url = 'https://example.com/wrong';
    await assert.rejects(
      () => runStep({ action: 'assertUrl', url: 'https://example.com/dashboard' }, page),
      /assertUrl failed/i,
    );
  });

  it('assertUrl with urlContains passes when substring matches', async () => {
    page._url = 'https://example.com/users/42/profile';
    await runStep({ action: 'assertUrl', urlContains: '/users/' }, page);
  });

  it('assertUrl with urlMatches uses regex', async () => {
    page._url = 'https://example.com/posts/123';
    await runStep({ action: 'assertUrl', urlMatches: '/posts/\\d+' }, page);
  });

  it('assertStatus checks page.lastStatus', async () => {
    page.lastStatus = 200;
    await runStep({ action: 'assertStatus', status: 200 }, page);
  });

  it('assertStatus throws when lastStatus is null', async () => {
    page.lastStatus = null;
    await assert.rejects(
      () => runStep({ action: 'assertStatus', status: 200 }, page),
      /lastStatus to be tracked/i,
    );
  });

  it('throws on unknown action', async () => {
    await assert.rejects(
      () => runStep({ action: 'teleport' }, page),
      /Unknown flow step action/i,
    );
  });
});

// ─── runFlow ───────────────────────────────────────────────────────

describe('runFlow', () => {
  it('runs all steps + returns ok:true when no failures', async () => {
    const page = new MockPage({ textContent: { 'h1': 'Welcome' } });
    const flow = {
      name: 'Login',
      startUrl: 'https://example.com/login',
      steps: [
        { action: 'fill', selector: 'input[name="email"]', value: 'test@example.com' },
        { action: 'click', selector: 'button[type="submit"]' },
        { action: 'assertText', selector: 'h1', contains: 'Welcome' },
      ],
    };
    const result = await runFlow(flow, page);
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 1);
  });

  it('retries on failure + returns ok:false after maxAttempts', async () => {
    const page = new MockPage({ textContent: { 'h1': 'Wrong' } });
    const flow = {
      name: 'Login',
      startUrl: 'https://example.com/login',
      steps: [
        { action: 'assertText', selector: 'h1', contains: 'Welcome' },  // fails
      ],
      retry: { maxAttempts: 2, backoffMs: 1 },
    };
    const result = await runFlow(flow, page);
    assert.equal(result.ok, false);
    assert.equal(result.attempts, 2);
    assert.match(result.lastError.message, /does not contain/i);
  });

  it('eventually succeeds on retry', async () => {
    let attemptCount = 0;
    const page = new MockPage();
    // Override textContent to flip after first attempt
    const original = page._textContent;
    page._textContent = new Proxy({}, {
      get(_, key) {
        if (key === 'h1') {
          attemptCount++;
          return attemptCount >= 2 ? 'Welcome' : 'Wrong';
        }
        return original[key];
      },
    });

    const flow = {
      name: 'Flaky',
      startUrl: 'https://example.com',
      steps: [
        { action: 'assertText', selector: 'h1', contains: 'Welcome' },
      ],
      retry: { maxAttempts: 3, backoffMs: 1 },
    };
    const result = await runFlow(flow, page);
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
  });
});

// ─── e2eExecutor (no-context path) ──────────────────────────────────

describe('e2eExecutor no-context path', () => {
  it('returns skipped result when no Playwright context', async () => {
    const ctx = {
      plan: { flows: [{ name: 'Test', startUrl: 'https://x.com', steps: [] }] },
      createFinding: createFindingFactory(),
      onEvent: () => {},
      signal: undefined,
    };
    const result = await e2eExecutor(ctx);
    assert.equal(result.findings.length, 0);
    assert.equal(result.stats.skipped, true);
    assert.equal(result.stats.reason, 'no-browser-context');
  });
});

// ─── e2eExecutor with mock context ─────────────────────────────────

describe('e2eExecutor with mock context', () => {
  it('runs flows + emits findings on failure', async () => {
    class MockContext {
      async newPage() {
        return new MockPage({ textContent: { 'h1': 'Wrong Text' } });
      }
    }
    const ctx = {
      plan: {
        targetUrl: 'https://example.com',
        viewports: [{ width: 1280, height: 720 }],
        flows: [{
          name: 'Login',
          startUrl: 'https://example.com/login',
          steps: [
            { action: 'assertText', selector: 'h1', contains: 'Welcome' },
          ],
          retry: { maxAttempts: 1, backoffMs: 1 },
        }],
      },
      context: new MockContext(),
      createFinding: createFindingFactory(),
      onEvent: () => {},
      signal: undefined,
    };
    const result = await e2eExecutor(ctx);
    assert.equal(result.stats.ran, 1);
    assert.equal(result.stats.failed, 1);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].ruleId, 'e2e-flow-failure');
    assert.match(result.findings[0].title, /Login/);
  });

  it('passes when all flows succeed', async () => {
    class MockContext {
      async newPage() {
        return new MockPage({ textContent: { 'h1': 'Welcome' } });
      }
    }
    const ctx = {
      plan: {
        targetUrl: 'https://example.com',
        viewports: [{ width: 1280, height: 720 }],
        flows: [{
          name: 'Login',
          startUrl: 'https://example.com/login',
          steps: [
            { action: 'assertText', selector: 'h1', contains: 'Welcome' },
          ],
          retry: { maxAttempts: 1, backoffMs: 1 },
        }],
      },
      context: new MockContext(),
      createFinding: createFindingFactory(),
      onEvent: () => {},
      signal: undefined,
    };
    const result = await e2eExecutor(ctx);
    assert.equal(result.stats.ran, 1);
    assert.equal(result.stats.passed, 1);
    assert.equal(result.findings.length, 0);
  });
});

// ─── selectorResolver ───────────────────────────────────────────────

describe('selectorResolver', () => {
  class CountablePage {
    constructor(counts = {}, opts = {}) {
      this.counts = counts;      // selector string → element count
      this.events = [];
      this.getByRoleSupported = opts.getByRole !== false;
      this.getByTextSupported = opts.getByText !== false;
    }
    locator(selector) {
      const self = this;
      return {
        selector,
        async count() { return self.counts[selector] ?? 0; },
      };
    }
    getByRole(role, { name } = {}) {
      return this.locator(`role:${role}:${name}`);
    }
    getByText(text) {
      return this.locator(`text:${text}`);
    }
  }

  it('extracts a name from id / attribute / class selectors', () => {
    assert.equal(extractSelectorName('#login-btn'), 'login-btn');
    assert.equal(extractSelectorName('input[name="email"]'), 'email');
    assert.equal(extractSelectorName('[data-testid="checkout"]'), 'checkout');
    assert.equal(extractSelectorName('form .submit-button'), 'submit-button');
    assert.equal(extractSelectorName('div > span'), null);
  });

  it('infers implied roles from tag/class hints', () => {
    assert.equal(inferRoleFromSelector('button[type="submit"]'), 'button');
    assert.equal(inferRoleFromSelector('.btn-primary'), 'button');
    assert.equal(inferRoleFromSelector('nav a[href="/login"]'), 'link');
    assert.equal(inferRoleFromSelector('input[name="email"]'), 'textbox');
    assert.equal(inferRoleFromSelector('div.container'), null);
  });

  it('builds the fallback ladder in order: testid, test, aria-label, role, text', () => {
    const candidates = buildFallbackCandidates('#login-btn');
    assert.deepEqual(candidates.map(c => c.selector || c.kind),
      ['[data-testid="login-btn"]', '[data-test="login-btn"]', '[aria-label="login-btn"]', 'role', 'text']);
    assert.equal(candidates[3].role, 'button');
  });

  it('returns the original locator when it exists (no healing)', async () => {
    const page = new CountablePage({ '#btn': 2 });
    const resolved = await resolveLocatorDetailed(page, '#btn');
    assert.equal(resolved.healed, false);
    assert.equal(resolved.selector, '#btn');
    assert.ok((await resolveLocator(page, '#btn')) !== null);
  });

  it('heals to [data-testid=...] when the original selector matches nothing', async () => {
    const page = new CountablePage({
      '#submit-btn': 0,
      '[data-testid="submit-btn"]': 1,
    });
    const resolved = await resolveLocatorDetailed(page, '#submit-btn');
    assert.equal(resolved.healed, true);
    assert.equal(resolved.selector, '[data-testid="submit-btn"]');
    assert.equal(resolved.ladder.find(l => l.candidate === '#submit-btn').found, false);
    assert.equal(resolved.ladder.find(l => l.candidate === '[data-testid="submit-btn"]').found, true);
  });

  it('falls through to the role engine and text engine', async () => {
    const page = new CountablePage({
      '#weird-btn': 0,
      'role:button:weird-btn': 1,
      'text:weird-btn': 1,
    }, { getByRole: true });
    const resolved = await resolveLocatorDetailed(page, '#weird-btn');
    assert.equal(resolved.healed, true);
    assert.equal(resolved.selector, "getByRole('button', { name: 'weird-btn' })");

    const noRolePage = new CountablePage({
      '#weird-btn': 0,
      'text:weird-btn': 1,
    });
    const viaText = await resolveLocatorDetailed(noRolePage, '#weird-btn');
    assert.equal(viaText.healed, true);
    assert.equal(viaText.selector, "getByText('weird-btn')");
  });

  it('returns a null locator (with the ladder) when everything misses', async () => {
    const page = new CountablePage({});
    const resolved = await resolveLocatorDetailed(page, '#ghost');
    assert.equal(resolved.locator, null);
    assert.equal(resolved.healed, false);
    assert.ok(resolved.ladder.length >= 4);
    assert.ok(resolved.ladder.every(l => l.found === false));
    assert.equal(await resolveLocator(page, '#ghost'), null);
  });
});

// ─── URL safety ─────────────────────────────────────────────────────

describe('checkUrlSafety', () => {
  const targetOrigin = 'https://example.com';

  it('rejects file:, data: and ftp: schemes outright', async () => {
    for (const url of ['file:///etc/passwd', 'data:text/html,<h1>hi</h1>', 'ftp://example.com/x']) {
      const res = await checkUrlSafety(url, { targetOrigin });
      assert.equal(res.ok, false, `${url} should be rejected`);
      assert.match(res.reason, /scheme/i);
    }
  });

  it('rejects cross-origin URLs unless allowCrossOrigin is set', async () => {
    const res = await checkUrlSafety('https://evil.example.org/steal', { targetOrigin });
    assert.equal(res.ok, false);
    assert.match(res.reason, /cross-origin/i);

    // allowCrossOrigin → passes the same-origin gate; IP literal avoids DNS
    const allowed = await checkUrlSafety('https://93.184.216.34/x', { targetOrigin, allowCrossOrigin: true });
    assert.equal(allowed.ok, true);
  });

  it('rejects invalid URLs', async () => {
    assert.equal((await checkUrlSafety('not-a-url', {})).ok, false);
  });

  it('accepts same-origin URLs (IP literal — no DNS dependency)', async () => {
    const res = await checkUrlSafety('https://93.184.216.34/login', { targetOrigin: 'https://93.184.216.34' });
    assert.equal(res.ok, true);
  });
});

// ─── variables ──────────────────────────────────────────────────────

describe('substituteStepValue (${VAR} placeholders)', () => {
  it('resolves from the flow variable scope first', () => {
    const events = [];
    const value = substituteStepValue('user=${WHO}', { WHO: 'flow-scope' }, (m) => events.push(m));
    assert.equal(value, 'user=flow-scope');
  });

  it('resolves SQA_TD_* env vars (prefix stripped)', () => {
    process.env.SQA_TD_E2E_VAR = 'from-env';
    try {
      const value = substituteStepValue('${E2E_VAR}', {}, () => {});
      assert.equal(value, 'from-env');
    } finally {
      delete process.env.SQA_TD_E2E_VAR;
    }
  });

  it('leaves unknown placeholders literal and emits one warning per key', () => {
    const events = [];
    const value = substituteStepValue('x=${NOPE_NOT_DEFINED} y=${NOPE_NOT_DEFINED}', {}, (m) => events.push(m));
    assert.equal(value, 'x=${NOPE_NOT_DEFINED} y=${NOPE_NOT_DEFINED}');
    assert.equal(events.length, 1);
    assert.match(events[0], /NOPE_NOT_DEFINED/);
  });
});

describe('testData service', () => {
  it('merges file + env, substitutes strings, lists keys', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqa-td-'));
    const file = path.join(dir, 'testdata.json');
    await fs.writeFile(file, JSON.stringify({ TEST_USER: 'file-user', NESTED: { a: 1 } }));

    process.env.SQA_TD_TEST_USER = 'env-user';
    try {
      assert.equal(testData.get('TEST_USER', file), 'env-user');  // env wins
      const sub = testData.substitute('login as ${TEST_USER} / ${MISSING_X}', { filePath: file });
      assert.equal(sub.value, 'login as env-user / ${MISSING_X}');
      assert.deepEqual(sub.unknown, ['MISSING_X']);
      assert.ok(testData.keys(file).includes('TEST_USER'));
      assert.ok(!testData.keys(file).includes('NESTED'));  // non-string values rejected
    } finally {
      delete process.env.SQA_TD_TEST_USER;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('handles a missing file gracefully (env-only)', () => {
    process.env.SQA_TD_ONLY_ENV = 'yes';
    try {
      const missing = path.join(os.tmpdir(), `sqa-td-none-${Date.now()}.json`);
      assert.equal(testData.get('ONLY_ENV', missing), 'yes');
      assert.equal(testData.get('ONLY_ENV'), 'yes');  // default path also works via env
    } finally {
      delete process.env.SQA_TD_ONLY_ENV;
      testData._clearCache();
    }
  });
});

describe('readJsonPath', () => {
  it('walks dot paths including array indices', () => {
    const body = { data: { items: [{ id: 'x1' }] } };
    assert.equal(readJsonPath(body, 'data.items.0.id'), 'x1');
    assert.equal(readJsonPath(body, 'data.items.9.id'), undefined);
    assert.equal(readJsonPath(null, 'a'), undefined);
  });
});

// ─── api-request steps ──────────────────────────────────────────────

describe('runStep api-request (hybrid API steps)', () => {
  const jsonBody = JSON.stringify({ data: { items: [{ id: 'x1' }], total: 1 }, token: 'TKN' });

  function makeMockFetch(status = 200) {
    return async () => ({
      status,
      async text() { return jsonBody; },
    });
  }

  it('performs the request, asserts status + json path, saves a variable', async () => {
    const page = new MockPage();
    const variables = {};
    const events = [];
    const result = await runStep({
      action: 'api-request',
      url: 'https://example.com/api/items',
      method: 'GET',
      expectStatus: 200,
      expectJsonPath: 'data.items.0.id',
      saveAsVar: 'itemId',
    }, page, { variables, fetchImpl: makeMockFetch(200), onEvent: m => events.push(m) });

    assert.equal(result.status, 200);
    assert.equal(page.lastStatus, 200);
    assert.equal(variables.itemId, 'x1');
    assert.ok(events.some(e => /saved response value into variable/.test(e)));
  });

  it('throws when expectStatus does not match', async () => {
    await assert.rejects(
      () => runStep({ action: 'api-request', url: 'https://example.com/api', expectStatus: 201 }, new MockPage(), { fetchImpl: makeMockFetch(200) }),
      /expected status 201 but got 200/i,
    );
  });

  it('throws when expectJsonPath is missing from the body', async () => {
    await assert.rejects(
      () => runStep({ action: 'api-request', url: 'https://example.com/api', expectJsonPath: 'nope.nope' }, new MockPage(), { fetchImpl: makeMockFetch(200) }),
      /expectJsonPath "nope.nope" not found/i,
    );
  });

  it('skips unsafe URLs (file: scheme)', async () => {
    const result = await runStep({ action: 'api-request', url: 'file:///etc/passwd' }, new MockPage(), {});
    assert.equal(result.skipped, true);
    assert.equal(result.unsafeUrl, 'file:///etc/passwd');
  });

  it('substitutes ${VAR} in url, headers and body', async () => {
    let captured;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return { status: 200, async text() { return '{}'; } };
    };
    process.env.SQA_TD_API_PATH = '/api/items';
    try {
      await runStep({
        action: 'api-request',
        url: 'https://example.com${API_PATH}',
        method: 'POST',
        headers: { 'X-Trace': 'run-${API_PATH}' },
        body: { q: '${API_PATH}' },
      }, new MockPage(), { fetchImpl });
      assert.equal(captured.url, 'https://example.com/api/items');
      assert.equal(captured.init.headers['X-Trace'], 'run-/api/items');
      assert.equal(JSON.parse(captured.init.body).q, '/api/items');
      assert.equal(captured.init.headers['Content-Type'], 'application/json');
    } finally {
      delete process.env.SQA_TD_API_PATH;
    }
  });

  it('saves a saved variable usable as ${VAR} in later steps', async () => {
    const variables = {};
    await runStep({
      action: 'api-request', url: 'https://example.com/api/token',
      expectJsonPath: 'token', saveAsVar: 'TOKEN',
    }, new MockPage(), { variables, fetchImpl: makeMockFetch(200) });
    const events = [];
    const value = substituteStepValue('Bearer ${TOKEN}', variables, m => events.push(m));
    assert.equal(value, 'Bearer TKN');
  });
});

// ─── navigate URL safety ────────────────────────────────────────────

describe('runStep navigate URL safety', () => {
  it('skips navigate steps with disallowed schemes and does not goto', async () => {
    const page = new MockPage();
    const result = await runStep({ action: 'navigate', value: 'file:///etc/passwd' }, page);
    assert.equal(result.skipped, true);
    assert.ok(!page._calls.some(c => c[0] === 'goto'));
  });

  it('skips cross-origin navigate steps unless allowCrossOrigin', async () => {
    const page = new MockPage();
    const result = await runStep({ action: 'navigate', value: 'https://evil.example.org/x' }, page, {
      targetOrigin: 'https://example.com',
    });
    assert.equal(result.skipped, true);
    assert.match(result.skipReason, /cross-origin/i);

    const allowed = await runStep({ action: 'navigate', value: 'https://93.184.216.34/x' }, new MockPage(), {
      targetOrigin: 'https://example.com',
      allowCrossOrigin: true,
    });
    assert.equal(allowed.skipped, undefined);
  });
});

// ─── self-healing in steps ──────────────────────────────────────────

describe('runStep self-healing selectors', () => {
  class CountableLocator {
    constructor(page, selector) { this.page = page; this.selector = selector; }
    async count() { return this.page.counts[this.selector] ?? 0; }
    async click() { this.page._calls.push(['click', this.selector]); }
    async fill(value) { this.page._calls.push(['fill', this.selector, value]); }
    async waitFor() { this.page._calls.push(['waitFor', this.selector]); }
    async textContent() { return 'Welcome'; }
  }
  class CountableMockPage extends MockPage {
    constructor(counts) { super(); this.counts = counts; }
    locator(selector) { return new CountableLocator(this, selector); }
  }

  it('uses the original locator when it exists', async () => {
    const page = new CountableMockPage({ '#btn': 3 });
    const result = await runStep({ action: 'click', selector: '#btn' }, page);
    assert.equal(result.healedTo, undefined);
    assert.deepEqual(page._calls[0], ['click', '#btn']);
  });

  it('heals a drifted selector and emits an event + healedTo', async () => {
    const events = [];
    const page = new CountableMockPage({
      '#submit-btn': 0,
      '[data-testid="submit-btn"]': 1,
    });
    const result = await runStep({ action: 'click', selector: '#submit-btn' }, page, {
      onEvent: m => events.push(m),
    });
    assert.equal(result.healedTo, '[data-testid="submit-btn"]');
    assert.ok(events.some(e => /selector self-healed: #submit-btn → \[data-testid="submit-btn"\]/.test(e)));
    assert.deepEqual(page._calls[0], ['click', '[data-testid="submit-btn"]']);
  });

  it('attaches the tried ladder to the thrown error when nothing matches', async () => {
    const page = new CountableMockPage({});
    // Make click throw (simulating a real timeout)
    page.locator = () => ({
      async count() { return 0; },
      async click() { const e = new Error('Timeout 5000ms exceeded.\nwaiting for locator("#ghost")'); throw e; },
    });
    await assert.rejects(
      () => runStep({ action: 'click', selector: '#ghost' }, page, { existenceTimeoutMs: 50 }),
      (err) => {
        assert.ok(Array.isArray(err.selectorLadder));
        assert.ok(err.selectorLadder.every(l => l.found === false));
        return true;
      },
    );
  });
});

// ─── runFlow: unsafe URLs, evidence, skipped steps ──────────────────

describe('runFlow URL safety + evidence', () => {
  it('refuses to run a flow whose startUrl is unsafe', async () => {
    const page = new MockPage();
    const result = await runFlow({ name: 'Bad', startUrl: 'file:///etc/passwd', steps: [{ action: 'wait', ms: 1 }] }, page);
    assert.equal(result.ok, false);
    assert.equal(result.attempts, 0);
    assert.match(result.unsafeStart.reason, /scheme/i);
    assert.ok(!page._calls.some(c => c[0] === 'goto'));
  });

  it('records unsafe skipped steps but keeps running the flow', async () => {
    const page = new MockPage({ textContent: { h1: 'Welcome' } });
    const result = await runFlow({
      name: 'Mixed',
      startUrl: 'https://example.com/',   // mock page — goto succeeds
      steps: [
        { action: 'navigate', value: 'file:///etc/passwd' },
        { action: 'assertText', selector: 'h1', contains: 'Welcome' },
      ],
      retry: { maxAttempts: 1 },
    }, page);
    assert.equal(result.ok, true);
    assert.equal(result.skippedSteps.length, 1);
    assert.equal(result.skippedSteps[0].unsafeUrl, 'file:///etc/passwd');
  });

  it('captures a failure screenshot into screenshotsDir on final failure', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqa-e2e-'));
    const page = new MockPage({ textContent: { h1: 'Wrong' } });
    const result = await runFlow({
      name: 'Login',
      startUrl: 'https://example.com/login',
      steps: [{ action: 'assertText', selector: 'h1', contains: 'Welcome' }],
      retry: { maxAttempts: 1 },
    }, page, { screenshotsDir: dir, runId: 'run_test_1' });

    assert.equal(result.ok, false);
    assert.ok(result.evidence.screenshot, 'expected a screenshot filename');
    const saved = await fs.readFile(path.join(dir, result.evidence.screenshot));
    assert.ok(saved.length > 0);
    assert.match(result.evidence.screenshot, /^run_test_1_.*\.png$/);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('includes the selector ladder in failure evidence', async () => {
    const page = new MockPage({ textContent: { h1: 'Wrong' } });
    // give the mock a count() that always returns 0 → ladder is recorded
    const origLocator = page.locator.bind(page);
    page.locator = (sel) => {
      const loc = origLocator(sel);
      loc.count = async () => 0;
      return loc;
    };
    const result = await runFlow({
      name: 'Drifted',
      startUrl: 'https://example.com/',
      steps: [{ action: 'assertText', selector: '#missing-thing', contains: 'Welcome' }],
      retry: { maxAttempts: 1 },
    }, page);
    assert.equal(result.ok, false);
    assert.ok(Array.isArray(result.evidence.ladder));
    assert.ok(result.evidence.ladder.length >= 4);
  });
});

// ─── executor: unsafe URL findings ──────────────────────────────────

describe('e2eExecutor unsafe URL findings', () => {
  it('emits e2e-unsafe-url for an unsafe start URL and skips the flow', async () => {
    class MockContext { async newPage() { return new MockPage(); } }
    const ctx = {
      plan: {
        targetUrl: 'https://example.com',
        flows: [{ name: 'Bad', startUrl: 'file:///etc/passwd', steps: [{ action: 'wait', ms: 1 }] }],
      },
      context: new MockContext(),
      createFinding: createFindingFactory(),
      onEvent: () => {},
    };
    const result = await e2eExecutor(ctx);
    assert.equal(result.stats.skipped, 1);
    assert.equal(result.findings.length, 1);
    const f = result.findings[0];
    assert.equal(f.ruleId, 'e2e-unsafe-url');
    assert.equal(f.severity, 'high');
    assert.equal(f.confidence, 'confirmed');
    assert.equal(f.category, 'security');
  });

  it('emits e2e-unsafe-url for unsafe mid-flow steps and still runs the rest', async () => {
    class MockContext { async newPage() { return new MockPage({ textContent: { h1: 'Welcome' } }); } }
    const ctx = {
      plan: {
        targetUrl: 'https://example.com',
        flows: [{
          name: 'Mixed',
          startUrl: 'https://example.com/',
          steps: [
            { action: 'navigate', value: 'file:///etc/passwd' },
            { action: 'assertText', selector: 'h1', contains: 'Welcome' },
          ],
          retry: { maxAttempts: 1 },
        }],
      },
      context: new MockContext(),
      createFinding: createFindingFactory(),
      onEvent: () => {},
    };
    const result = await e2eExecutor(ctx);
    assert.equal(result.stats.passed, 1);
    assert.equal(result.stats.unsafeSteps, 1);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].ruleId, 'e2e-unsafe-url');
  });
});
