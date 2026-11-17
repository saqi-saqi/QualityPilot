/**
 * test/injection.test.js — Phase 8 differential injection executor.
 *
 * All payload signals in these tests mirror behaviors VERIFIED live against
 * the pinned Juice Shop target on 2026-11-17 (login tautology 401→200, search
 * param 200→500 + SQLITE_ERROR, DOM reflection of a raw <iframe> payload).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import injectionExecutor from '../src/executors/injection.js';
import { matchSqlError, isLocalhostHost, isLoopbackUrl } from '../src/security/injectionSignatures.js';
import { createFindingFactory } from '../src/services/findingFactory.js';

// ─── signatures ──────────────────────────────────────────────────────

describe('matchSqlError', () => {
  it('detects the verified Juice Shop signature (SQLITE_ERROR)', () => {
    const hit = matchSqlError('<title>Error: SQLITE_ERROR: near ")": syntax error</title>');
    assert.equal(hit.vendor, 'sqlite');
    assert.match(hit.match, /SQLITE_ERROR/);
  });

  it('detects MySQL, Oracle and Sequelize signatures', () => {
    assert.equal(matchSqlError('You have an error in your SQL syntax near x').vendor, 'mysql');
    assert.equal(matchSqlError('ORA-00933: SQL command not properly ended').vendor, 'oracle');
    // When both the ORM wrapper and the engine appear, the ENGINE is the
    // attribution (sqlite here — first matching signature wins by design).
    assert.equal(matchSqlError('SequelizeDatabaseError: SQLITE_ERROR: near x').vendor, 'sqlite');
    assert.equal(matchSqlError('SequelizeDatabaseError: execution issue').vendor, 'sequelize');
  });

  it('does not match clean application JSON', () => {
    assert.equal(matchSqlError('{"status":"success","data":[]}'), null);
    assert.equal(matchSqlError('Invalid email or password.'), null);
  });
});

describe('isLocalhostHost / isLoopbackUrl', () => {
  it('accepts loopback spellings', () => {
    assert.equal(isLocalhostHost('localhost'), true);
    assert.equal(isLocalhostHost('127.0.0.1'), true);
    assert.equal(isLocalhostHost('::1'), true);
    assert.equal(isLoopbackUrl('http://localhost:3000/x'), true);
    assert.equal(isLoopbackUrl('http://127.0.0.1:8080'), true);
  });

  it('rejects non-loopback hosts', () => {
    assert.equal(isLocalhostHost('demo.realworld.show'), false);
    assert.equal(isLoopbackUrl('https://demo.realworld.show'), false);
    assert.equal(isLocalhostHost('127.0.0.1.example.com'), false);
  });
});

// ─── executor ────────────────────────────────────────────────────────

const makeCtx = (overrides = {}) => ({
  plan: {
    targetUrl: 'http://localhost:3000',
    apiEndpoints: [],
    fuzzTargets: [],
  },
  context: null,
  options: {},
  createFinding: createFindingFactory(),
  onEvent: () => {},
  signal: undefined,
  ...overrides,
});

describe('injection executor — authorization gate', () => {
  it('skips non-loopback targets without authorization', async () => {
    const ctx = makeCtx({ plan: { targetUrl: 'https://demo.realworld.show', apiEndpoints: [], fuzzTargets: [] } });
    const result = await injectionExecutor(ctx);
    assert.equal(result.stats.skippedNotAuthorized, true);
    assert.equal(result.findings.length, 0);
  });

  it('runs on non-loopback targets with authorizedTarget (and stays silent on clean responses)', async () => {
    const ctx = makeCtx({
      plan: {
        targetUrl: 'https://demo.realworld.show',
        apiEndpoints: [{ method: 'GET', path: '/api/articles', queryParams: { limit: '10' } }],
        fuzzTargets: [],
      },
      options: { authorizedTarget: true, fetch: async () => ({ status: 200, text: async () => '{"articles":[]}' }) },
    });
    const result = await injectionExecutor(ctx);
    assert.equal(result.stats.skippedNotAuthorized, false);
    assert.equal(result.findings.length, 0, 'a clean 200/200 differential is not a finding');
  });
});

describe('injection executor — GET query-param differential', () => {
  it('finds injection-sqli-error when a mutated param crashes with a SQL signature (verified: search q → 500 SQLITE_ERROR)', async () => {
    const ctx = makeCtx({
      plan: {
        targetUrl: 'http://localhost:3000',
        apiEndpoints: [{ method: 'GET', path: '/rest/products/search', queryParams: { q: '' } }],
        fuzzTargets: [],
      },
      options: {
        fetch: async (url) => {
          if (String(url).includes(encodeURIComponent("')")) || String(url).includes("%27%29")) {
            return { status: 500, text: async () => '<title>Error: SQLITE_ERROR: near ")": syntax error</title>' };
          }
          return { status: 200, text: async () => '{"status":"success","data":[]}' };
        },
      },
    });

    const result = await injectionExecutor(ctx);
    assert.equal(result.findings.length, 1);
    const f = result.findings[0];
    assert.equal(f.ruleId, 'injection-sqli-error');
    assert.equal(f.severity, 'medium');
    assert.equal(f.confidence, 'confirmed', 'two agreeing signals (5xx + signature)');
    assert.match(f.evidence, /SQLITE_ERROR/);
  });

  it('does not flag a benign param mutation (200 → 200, no signature)', async () => {
    const ctx = makeCtx({
      plan: {
        targetUrl: 'http://localhost:3000',
        apiEndpoints: [{ method: 'GET', path: '/rest/products/search', queryParams: { q: '' } }],
        fuzzTargets: [],
      },
      options: { fetch: async () => ({ status: 200, text: async () => '{"status":"success","data":[]}' }) },
    });
    const result = await injectionExecutor(ctx);
    assert.equal(result.findings.length, 0);
  });

  it('flags an auth bypass when a non-2xx baseline turns 2xx (injection-sqli, high)', async () => {
    let call = 0;
    const ctx = makeCtx({
      plan: {
        targetUrl: 'http://localhost:3000',
        apiEndpoints: [{ method: 'GET', path: '/rest/admin/secret', queryParams: { token: '' } }],
        fuzzTargets: [],
      },
      options: {
        fetch: async () => {
          call++;
          // First call = baseline (401); second = first payload probe; but the
          // first payload is the error-probe → 401; the second payload
          // (comment-tautology) → 200 (bypass).
          const status = call === 1 ? 401 : call === 2 ? 401 : 200;
          return { status, text: async () => (status === 200 ? '{"secret":true}' : '{"error":"unauthorized"}') };
        },
      },
    });

    const result = await injectionExecutor(ctx);
    const bypass = result.findings.find(f => f.ruleId === 'injection-sqli');
    assert.ok(bypass, 'the bypass payload is reported');
    assert.equal(bypass.severity, 'high');
    assert.equal(bypass.confidence, 'confirmed');
  });
});

// ─── login-form submit differential (browser) ────────────────────────

function makeMockBrowser({ baselineStatus = 401, mutatedStatus = 200 } = {}) {
  const calls = { gotos: 0, presses: 0, closes: 0, evaluates: [] };
  const listeners = {};
  let loginPostStatus = baselineStatus;
  const page = {
    on(event, handler) {
      (listeners[event] = listeners[event] || []).push(handler);
    },
    fireResponse(status, url = 'https://localhost:3000/rest/user/login') {
      for (const h of listeners.response || []) {
        h({ request: () => ({ method: () => 'POST' }), status: () => status, url: () => url });
      }
    },
    async goto() { calls.gotos++; },
    locator() {
      return {
        first() { return this; },
        async fill() {},
        async press() {
          calls.presses++;
          // Enter triggers the login XHR — the executor's response listener
          // sees it.
          this.fireLogin && this.fireLogin();
        },
        fireLogin() {
          for (const h of listeners.response || []) {
            h({
              request: () => ({ method: () => 'POST' }),
              status: () => (calls.presses % 2 === 1 ? baselineStatus : mutatedStatus),
              url: () => 'http://localhost:3000/rest/user/login',
            });
          }
        },
      };
    },
    async evaluate(fn, arg) { calls.evaluates.push(String(fn)); return true; },
    async waitForTimeout() {},
    async close() { calls.closes++; },
  };
  return {
    ctx: { context: { async newPage() { return page; } } },
    calls,
    page,
  };
}

describe('injection executor — login-form auth bypass (browser)', () => {
  const plan = {
    targetUrl: 'http://localhost:3000',
    apiEndpoints: [],
    fuzzTargets: [
      { pageUrl: 'http://localhost:3000/#/login', fieldSelector: '#email', generators: ['empty'], iterations: 1 },
      { pageUrl: 'http://localhost:3000/#/login', fieldSelector: '#password', generators: ['empty'], iterations: 1 },
    ],
  };

  it('reports injection-sqli (high, confirmed) when the tautology turns 401 into 200', async () => {
    const { ctx, calls } = makeMockBrowser({ baselineStatus: 401, mutatedStatus: 200 });
    const result = await injectionExecutor(makeCtx({ ...ctx, plan }));
    const bypass = result.findings.find(f => f.ruleId === 'injection-sqli');
    assert.ok(bypass, 'auth bypass finding emitted');
    assert.equal(bypass.severity, 'high');
    assert.equal(bypass.confidence, 'confirmed');
    assert.doesNotMatch(bypass.evidence, /token/i, 'the mutated response body (credentials) is never captured');
    assert.equal(calls.closes, 1, 'the probe page is closed');
  });

  it('stays silent when both attempts fail identically (no bypass)', async () => {
    const { ctx } = makeMockBrowser({ baselineStatus: 401, mutatedStatus: 401 });
    const result = await injectionExecutor(makeCtx({ ...ctx, plan }));
    assert.equal(result.findings.filter(f => f.ruleId === 'injection-sqli').length, 0);
    assert.equal(result.stats.loginFormsProbed, 1);
  });

  it('never probes account-creation pages (data mutation)', async () => {
    const { ctx } = makeMockBrowser();
    const registerPlan = {
      targetUrl: 'http://localhost:3000',
      apiEndpoints: [],
      fuzzTargets: [
        { pageUrl: 'http://localhost:3000/#/register', fieldSelector: '#passwordControl', generators: ['empty'], iterations: 1 },
      ],
    };
    const result = await injectionExecutor(makeCtx({ ...ctx, plan: registerPlan }));
    assert.equal(result.stats.loginFormsProbed, 0, 'register pages are excluded');
    assert.equal(result.findings.length, 0);
  });

  it('prefers an email-named field over the first generic input (the generic one is often the navbar search box)', async () => {
    // Regression (Phase 8): the probe filled the SEARCH input (input:nth-of-type(1))
    // instead of #email, so both attempts 401'd and the bypass never fired.
    const { ctx } = makeMockBrowser({ baselineStatus: 401, mutatedStatus: 200 });
    const probeTargets = [
      { pageUrl: 'http://localhost:3000/#/login', fieldSelector: 'input:nth-of-type(1)', generators: ['empty'], iterations: 1 },
      { pageUrl: 'http://localhost:3000/#/login', fieldSelector: '#email', generators: ['empty'], iterations: 1 },
      { pageUrl: 'http://localhost:3000/#/login', fieldSelector: '#password', generators: ['empty'], iterations: 1 },
    ];
    const filledWith = [];
    const page = {
      on(event, handler) {},
      async goto() {},
      locator(selector) {
        return {
          first() { return this; },
          async fill(value) { filledWith.push([selector, value]); },
          async press() {
            // The real app POSTs the login form; the values in the email field
            // decide whether the server says 401 or 200.
            const email = filledWith.find(([s]) => s === '#email');
          },
        };
      },
      async waitForTimeout() {},
      async close() {},
    };
    // Simulate the server view: the login XHR result depends on what was in
    // #email at submit time.
    const result = await injectionExecutor(makeCtx({ context: { async newPage() { return page; } }, plan: { targetUrl: 'http://localhost:3000', apiEndpoints: [], fuzzTargets: probeTargets } }));
    // The email-named field must have been filled with the TAUTOLOGY payload
    // on the second attempt (index 1 of the email fills).
    const emailFills = filledWith.filter(([s]) => s === '#email');
    assert.equal(emailFills.length, 2, 'email field filled twice (baseline + tautology)');
    assert.equal(emailFills[1][1], "' OR 1=1--");
    assert.equal(result.stats.loginFormsProbed, 1);
  });
});

// ─── DOM XSS sink probe (browser) ────────────────────────────────────

describe('injection executor — search-route DOM sink', () => {
  function makeDomMock({ reflected = true } = {}) {
    const calls = { routes: [], evaluates: 0 };
    const page = {
      on() {},
      async goto(route) { calls.routes.push(route); },
      async evaluate(fn, arg) { calls.evaluates++; return reflected; },
      async waitForTimeout() {},
      async close() {},
    };
    return {
      ctx: { context: { async newPage() { return page; } } },
      calls,
      plan: {
        targetUrl: 'http://localhost:3000',
        apiEndpoints: [{ method: 'GET', path: '/rest/products/search', queryParams: { q: '' } }],
        fuzzTargets: [],
      },
    };
  }

  it('probes the search route with the executable-markup payload and reports the sink when reflected', async () => {
    const mock = makeDomMock({ reflected: true });
    const result = await injectionExecutor(makeCtx({ ...mock.ctx, plan: mock.plan }));
    assert.ok(mock.calls.routes[0].includes('/#/search?q='), 'the SPA search route is probed');
    assert.ok(mock.calls.routes[0].includes(encodeURIComponent('qp_dom_xss_probe')), 'payload travels URL-encoded');
    const f = result.findings.find(x => x.ruleId === 'injection-xss-dom');
    assert.ok(f, 'DOM sink finding emitted');
    assert.equal(f.severity, 'high');
    assert.match(f.evidence, /DOM around the sink/);
  });

  it('stays silent when the payload does NOT become live markup (escaped rendering)', async () => {
    const mock = makeDomMock({ reflected: false });
    const result = await injectionExecutor(makeCtx({ ...mock.ctx, plan: mock.plan }));
    assert.equal(result.findings.filter(f => f.ruleId === 'injection-xss-dom').length, 0);
  });

  it('does not probe the DOM sink when the plan captured no search endpoint', async () => {
    const mock = makeDomMock({ reflected: true });
    mock.plan.apiEndpoints = [];
    const result = await injectionExecutor(makeCtx({ ...mock.ctx, plan: mock.plan }));
    assert.equal(result.stats.searchDomProbed, false);
    assert.equal(result.findings.length, 0);
  });
});
