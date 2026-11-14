import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fuzzExecutor, {
  generators,
  generateInputs,
  isAcceptableOutcome,
  fuzzApiField,
  fuzzFormField,
} from '../src/executors/fuzz.js';
import { createFindingFactory } from '../src/services/findingFactory.js';

// ─── generators ──────────────────────────────────────────────────────

describe('generators', () => {
  it('empty returns empty string', () => {
    assert.equal(generators.empty(), '');
  });

  it('oversize returns 10000 chars', () => {
    assert.equal(generators.oversize().length, 10000);
  });

  it('unicode returns non-ASCII string', () => {
    const v = generators.unicode();
    assert.ok(/[^\x00-\x7F]/.test(v));
  });

  it('sql returns array of payloads', () => {
    const v = generators.sql();
    assert.ok(Array.isArray(v));
    assert.ok(v.length >= 3);
    assert.ok(v.some(p => /OR.*1.*1/i.test(p)));
  });

  it('xss returns array of payloads', () => {
    const v = generators.xss();
    assert.ok(Array.isArray(v));
    assert.ok(v.some(p => /<script>/i.test(p)));
  });

  it('path returns array of traversal strings', () => {
    const v = generators.path();
    assert.ok(v.some(p => /\.\./.test(p)));
  });

  it('numeric-overflow returns string of large number', () => {
    const v = generators['numeric-overflow']();
    assert.ok(Number(v) > Number.MAX_SAFE_INTEGER);
  });

  it('negative returns -1', () => {
    assert.equal(generators.negative(), '-1');
  });

  it('null-byte contains \\0', () => {
    const v = generators['null-byte']();
    assert.ok(v.includes('\0'));
  });

  it('random returns 10-char alphanumeric', () => {
    const v = generators.random();
    assert.equal(v.length, 10);
    assert.ok(/^[a-z0-9]+$/i.test(v));
  });
});

// ─── generateInputs ──────────────────────────────────────────────────

describe('generateInputs', () => {
  it('expands multi-value generators (sql/xss/path)', () => {
    const target = { generators: ['sql', 'xss'], iterations: 100 };
    const inputs = generateInputs(target);
    // Each multi-value generator should expand
    const sqlInputs = inputs.filter(i => i.generator.startsWith('sql#'));
    const xssInputs = inputs.filter(i => i.generator.startsWith('xss#'));
    assert.ok(sqlInputs.length >= 3);
    assert.ok(xssInputs.length >= 3);
  });

  it('single-value generators get a single entry', () => {
    const target = { generators: ['empty', 'oversize'], iterations: 100 };
    const inputs = generateInputs(target);
    assert.equal(inputs.length, 2);
    assert.equal(inputs[0].generator, 'empty');
    assert.equal(inputs[1].generator, 'oversize');
  });

  it('caps total inputs to iterations', () => {
    const target = { generators: ['sql', 'xss', 'path'], iterations: 3 };
    const inputs = generateInputs(target);
    assert.equal(inputs.length, 3);
  });

  it('skips unknown generator names', () => {
    const target = { generators: ['unknown-gen', 'empty'], iterations: 10 };
    const inputs = generateInputs(target);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].generator, 'empty');
  });

  it('returns empty array for empty generators', () => {
    const target = { generators: [], iterations: 10 };
    assert.equal(generateInputs(target).length, 0);
  });
});

// ─── isAcceptableOutcome ────────────────────────────────────────────

describe('isAcceptableOutcome', () => {
  it('no-5xx: accepts 4xx', () => {
    assert.equal(isAcceptableOutcome(400, false, 'no-5xx'), true);
    assert.equal(isAcceptableOutcome(404, false, 'no-5xx'), true);
  });

  it('no-5xx: rejects 5xx', () => {
    assert.equal(isAcceptableOutcome(500, false, 'no-5xx'), false);
    assert.equal(isAcceptableOutcome(503, false, 'no-5xx'), false);
  });

  it('any-2xx-or-4xx: accepts 2xx and 4xx, rejects 5xx', () => {
    assert.equal(isAcceptableOutcome(200, false, 'any-2xx-or-4xx'), true);
    assert.equal(isAcceptableOutcome(404, false, 'any-2xx-or-4xx'), true);
    assert.equal(isAcceptableOutcome(500, false, 'any-2xx-or-4xx'), false);
    assert.equal(isAcceptableOutcome(302, false, 'any-2xx-or-4xx'), false);  // redirects
  });

  it('no-crash: rejects when threw=true', () => {
    assert.equal(isAcceptableOutcome(null, true, 'no-crash'), false);
    assert.equal(isAcceptableOutcome(200, false, 'no-crash'), true);
  });
});

// ─── fuzzApiField ───────────────────────────────────────────────────

describe('fuzzApiField', () => {
  let ctx;
  beforeEach(() => {
    ctx = {
      plan: {
        targetUrl: 'https://api.example.com',
        apiEndpoints: [
          {
            method: 'POST',
            path: '/login',
            body: { email: 'test@example.com', password: 'secret' },
          },
        ],
      },
      options: {},
    };
  });

  it('sends mutated field value in request body', async () => {
    let capturedBody;
    ctx.options.fetch = async (url, init) => {
      capturedBody = JSON.parse(init.body);
      return { status: 200, headers: new Headers() };
    };

    const target = { apiEndpointRef: '/login', field: 'email' };
    const result = await fuzzApiField(target, 'INJECTED-VALUE', ctx);

    assert.equal(capturedBody.email, 'INJECTED-VALUE');
    assert.equal(capturedBody.password, 'secret');  // unchanged
    assert.equal(result.threw, false);
  });

  it('returns threw=true on fetch error', async () => {
    ctx.options.fetch = async () => { throw new Error('boom'); };
    const target = { apiEndpointRef: '/login', field: 'email' };
    const result = await fuzzApiField(target, 'x', ctx);
    assert.equal(result.threw, true);
    assert.match(result.error, /boom/);
  });

  it('flags timeout/abort errors as environmental (Fix E2)', async () => {
    ctx.options.fetch = async () => { throw new Error('The operation was aborted due to timeout'); };
    const target = { apiEndpointRef: '/login', field: 'email' };
    const result = await fuzzApiField(target, 'x', ctx);
    assert.equal(result.threw, true);
    assert.equal(result.environmental, true);
  });

  it('does not flag generic fetch errors as environmental (Fix E2)', async () => {
    ctx.options.fetch = async () => { throw new Error('boom'); };
    const target = { apiEndpointRef: '/login', field: 'email' };
    const result = await fuzzApiField(target, 'x', ctx);
    assert.equal(result.threw, true);
    assert.equal(result.environmental, false);
  });

  it('throws when endpoint not found', async () => {
    ctx.options.fetch = async () => ({ status: 200, headers: new Headers() });
    const target = { apiEndpointRef: '/nonexistent', field: 'email' };
    await assert.rejects(
      () => fuzzApiField(target, 'x', ctx),
      /unknown endpoint/i,
    );
  });

  it('skips GET endpoints (no body to fuzz)', async () => {
    ctx.plan.apiEndpoints = [{ method: 'GET', path: '/users' }];
    const target = { apiEndpointRef: '/users', field: 'id' };
    const result = await fuzzApiField(target, '1', ctx);
    assert.equal(result.skipped, true);
  });
});

describe('fuzzFormField', () => {
  it('fills a browser field without submitting in safe mode', async () => {
    const calls = [];
    const page = {
      on() {},
      async goto() { return { status: () => 200 }; },
      locator(selector) {
        return {
          first() { return this; },
          async fill(value) { calls.push(['fill', selector, value]); },
        };
      },
      async close() { calls.push(['close']); },
    };
    const result = await fuzzFormField({
      pageUrl: 'https://example.com/form', fieldSelector: 'input[name="email"]',
    }, 'mutated@example.com', { context: { async newPage() { return page; } }, options: {} });

    assert.equal(result.threw, false);
    assert.deepEqual(calls, [
      ['fill', 'input[name="email"]', 'mutated@example.com'],
      ['close'],
    ]);
  });

  it('submits only for an authorized active scan with a submit selector', async () => {
    const calls = [];
    const page = {
      on() {},
      async goto() { return { status: () => 200 }; },
      locator(selector) {
        return {
          first() { return this; },
          async fill(value) { calls.push(['fill', selector, value]); },
          async click() { calls.push(['click', selector]); },
        };
      },
      async close() { calls.push(['close']); },
    };
    await fuzzFormField({
      pageUrl: 'https://example.com/form', fieldSelector: 'input', submitSelector: 'button[type="submit"]',
    }, 'value', {
      context: { async newPage() { return page; } },
      options: { allowActiveFuzz: true },
    });

    assert.ok(calls.some(call => call[0] === 'click'));
  });
});

// ─── executor end-to-end ────────────────────────────────────────────

describe('fuzzExecutor end-to-end', () => {
  let ctx;
  beforeEach(() => {
    ctx = {
      plan: {
        targetUrl: 'https://api.example.com',
        apiEndpoints: [],
        fuzzTargets: [],
      },
      options: {},
      createFinding: createFindingFactory(),
      onEvent: () => {},
      signal: undefined,
    };
  });

  it('emits finding when fuzz causes 5xx', async () => {
    ctx.plan.apiEndpoints = [{
      method: 'POST',
      path: '/login',
      body: { email: 'test@example.com', password: 'x' },
    }];
    ctx.plan.fuzzTargets = [{
      apiEndpointRef: '/login',
      field: 'email',
      generators: ['empty', 'oversize'],
      iterations: 5,
      expectStatus: 'no-5xx',
    }];
    ctx.options.allowActiveFuzz = true;
    ctx.options.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      // Return 500 for oversize input
      if (body.email && body.email.length > 1000) {
        return { status: 500, headers: new Headers() };
      }
      return { status: 200, headers: new Headers() };
    };

    const result = await fuzzExecutor(ctx);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].severity, 'high');
    assert.equal(result.findings[0].ruleId, 'fuzz-failure');
    assert.match(result.findings[0].title, /oversize/);
  });

  it('reports form fuzz failures with the page and selector instead of undefined fields', async () => {
    const ctx = {
      plan: { targetUrl: 'https://example.com', apiEndpoints: [], fuzzTargets: [] },
      options: {},
      createFinding: createFindingFactory(),
      onEvent: () => {},
      signal: undefined,
    };
    ctx.plan.fuzzTargets = [{
      pageUrl: 'https://example.com/signup',
      fieldSelector: '#email',
      generators: ['empty'],
      iterations: 1,
      expectStatus: 'no-crash',
    }];
    ctx.context = {
      newPage: async () => ({
        goto: async () => ({ status: () => 200 }),
        on: (event, handler) => {
          if (event === 'pageerror') handler(new Error('form crashed'));
        },
        locator: () => ({ first: () => ({ fill: async () => {} }) }),
        close: async () => {},
      }),
    };

    const result = await fuzzExecutor(ctx);
    assert.equal(result.findings.length, 1);
    assert.match(result.findings[0].title, /https:\/\/example\.com\/signup #email/);
    assert.doesNotMatch(result.findings[0].title, /undefined/);
    assert.equal(result.findings[0].pageUrl, 'https://example.com/signup');
  });

  it('does NOT emit findings when all fuzz responses are acceptable', async () => {
    ctx.plan.apiEndpoints = [{
      method: 'POST',
      path: '/login',
      body: { email: 'x' },
    }];
    ctx.plan.fuzzTargets = [{
      apiEndpointRef: '/login',
      field: 'email',
      generators: ['empty'],
      iterations: 1,
      expectStatus: 'no-5xx',
    }];
    ctx.options.allowActiveFuzz = true;
    ctx.options.fetch = async () => ({ status: 400, headers: new Headers() });

    const result = await fuzzExecutor(ctx);
    assert.equal(result.findings.length, 0);
    assert.equal(result.stats.skippedInputs, 0);
  });

  it('does not mutate API targets unless active testing is authorized', async () => {
    ctx.plan.apiEndpoints = [{ method: 'POST', path: '/x', body: { value: 'safe' } }];
    ctx.plan.fuzzTargets = [{
      apiEndpointRef: '/x', field: 'value', generators: ['empty'], iterations: 1,
    }];
    let requestCount = 0;
    ctx.options.fetch = async () => { requestCount++; return { status: 200, headers: new Headers() }; };

    const result = await fuzzExecutor(ctx);
    assert.equal(requestCount, 0);
    assert.equal(result.stats.skippedActiveTargets, 1);
  });

  it('handles empty fuzz targets (no-op)', async () => {
    const result = await fuzzExecutor(ctx);
    assert.equal(result.findings.length, 0);
    assert.equal(result.stats.skippedInputs, 0);
    assert.equal(result.stats.targetsRun, 0);
  });

  it('skips form-based fuzz targets when no Playwright context', async () => {
    ctx.plan.fuzzTargets = [{
      pageUrl: 'https://example.com/form',
      formSelector: 'form',
      fieldSelector: 'input',
      generators: ['empty'],
      iterations: 1,
    }];
    const result = await fuzzExecutor(ctx);
    assert.equal(result.findings.length, 0);
    assert.equal(result.stats.skippedInputs, 1);
  });

  it('respects abort signal', async () => {
    ctx.signal = { aborted: true, addEventListener: () => {} };
    ctx.plan.apiEndpoints = [{ method: 'POST', path: '/x', body: {} }];
    ctx.plan.fuzzTargets = [{
      apiEndpointRef: '/x',
      field: 'x',
      generators: ['empty'],
      iterations: 5,
    }];
    ctx.options.fetch = async () => ({ status: 200, headers: new Headers() });
    const result = await fuzzExecutor(ctx);
    assert.equal(result.findings.length, 0);
  });

  it('backs off on 429 — stops hammering and records no finding', async () => {
    ctx.plan.apiEndpoints = [{ method: 'POST', path: '/login', body: { email: 'x' } }];
    ctx.plan.fuzzTargets = [{
      apiEndpointRef: '/login', field: 'email',
      generators: ['oversize'], iterations: 5, expectStatus: 'no-5xx',
    }];
    ctx.options.allowActiveFuzz = true;
    ctx.options.delayMs = 0;
    const events = [];
    ctx.onEvent = (m) => events.push(m);
    let requests = 0;
    ctx.options.fetch = async () => { requests++; return { status: 429, headers: new Headers() }; };

    const result = await fuzzExecutor(ctx);
    assert.equal(requests, 1, 'must NOT hammer after a 429');
    assert.equal(result.findings.length, 0, 'rate limiting is not a fuzz failure');
    assert.equal(result.stats.rateLimitedTargets, 1);
    assert.ok(events.some(e => /rate limited — backing off/.test(e)));
  });

  it('backs off on 503 too', async () => {
    ctx.plan.apiEndpoints = [{ method: 'POST', path: '/login', body: { email: 'x' } }];
    ctx.plan.fuzzTargets = [{
      apiEndpointRef: '/login', field: 'email',
      generators: ['oversize'], iterations: 4, expectStatus: 'no-5xx',
    }];
    ctx.options.allowActiveFuzz = true;
    ctx.options.delayMs = 0;
    let requests = 0;
    ctx.options.fetch = async () => { requests++; return { status: 503, headers: new Headers() }; };

    const result = await fuzzExecutor(ctx);
    assert.equal(requests, 1);
    assert.equal(result.findings.length, 0);
    assert.equal(result.stats.rateLimitedTargets, 1);
  });

  it('applies delayMs between iterations (default 100ms, configurable)', async () => {
    ctx.plan.apiEndpoints = [{ method: 'POST', path: '/login', body: { email: 'x' } }];
    ctx.plan.fuzzTargets = [{
      apiEndpointRef: '/login', field: 'email',
      generators: ['empty', 'oversize'], iterations: 2, expectStatus: 'no-5xx',
    }];
    ctx.options.allowActiveFuzz = true;
    ctx.options.delayMs = 30;  // small but measurable
    const start = Date.now();
    ctx.options.fetch = async () => ({ status: 200, headers: new Headers() });
    await fuzzExecutor(ctx);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 25, `expected at least one 30ms delay between the 2 iterations, elapsed=${elapsed}ms`);
  });

  it('classifies an API fuzz timeout as suspected/environmental, not a confirmed bug (Fix E2)', async () => {
    ctx.plan.apiEndpoints = [{ method: 'POST', path: '/login', body: { email: 'x' } }];
    ctx.plan.fuzzTargets = [{
      apiEndpointRef: '/login', field: 'email',
      generators: ['empty'], iterations: 1, expectStatus: 'no-5xx',
    }];
    ctx.options.allowActiveFuzz = true;
    ctx.options.delayMs = 0;
    ctx.options.fetch = async () => { throw new Error('The operation was aborted due to timeout'); };

    const result = await fuzzExecutor(ctx);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].ruleId, 'fuzz-environmental');
    assert.equal(result.findings[0].findingType, 'environmental');
    assert.equal(result.findings[0].confidence, 'suspected');
    assert.equal(result.findings[0].severity, 'low');
  });

  it('classifies third-party console noise as INFO, not a confirmed bug (Fix E2)', async () => {
    const local = {
      plan: { targetUrl: 'https://example.com', apiEndpoints: [], fuzzTargets: [{
        pageUrl: 'https://example.com/checkout',
        fieldSelector: '#card',
        generators: ['empty'],
        iterations: 1,
        expectStatus: 'no-crash',
      }] },
      options: {},
      createFinding: createFindingFactory(),
      onEvent: () => {},
      signal: undefined,
    };
    local.context = {
      newPage: async () => ({
        goto: async () => ({ status: () => 200 }),
        on: (event, handler) => {
          if (event === 'console') {
            handler({ type: () => 'error', text: () => 'Stripe widget failed', location: () => ({ url: 'https://js.stripe.com/v3/bundle.js' }) });
          }
        },
        locator: () => ({ first: () => ({ fill: async () => {} }) }),
        close: async () => {},
      }),
    };

    const result = await fuzzExecutor(local);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].findingType, 'informational');
    assert.equal(result.findings[0].ruleId, 'fuzz-third-party-console');
    assert.equal(result.findings[0].severity, 'info');
    assert.equal(result.findings[0].origin, 'third-party');
    // Signature-first rule: the noise is kept as a signal, NOT discarded.
    assert.match(result.findings[0].evidence, /Stripe widget failed/);
  });

  it('keeps first-party console errors as confirmed bug signals (Fix E2)', async () => {
    const local = {
      plan: { targetUrl: 'https://example.com', apiEndpoints: [], fuzzTargets: [{
        pageUrl: 'https://example.com/checkout',
        fieldSelector: '#card',
        generators: ['empty'],
        iterations: 1,
        expectStatus: 'no-crash',
      }] },
      options: {},
      createFinding: createFindingFactory(),
      onEvent: () => {},
      signal: undefined,
    };
    local.context = {
      newPage: async () => ({
        goto: async () => ({ status: () => 200 }),
        on: (event, handler) => {
          if (event === 'console') {
            handler({ type: () => 'error', text: () => 'app code blew up', location: () => ({ url: 'https://example.com/app.js' }) });
          }
        },
        locator: () => ({ first: () => ({ fill: async () => {} }) }),
        close: async () => {},
      }),
    };

    const result = await fuzzExecutor(local);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].ruleId, 'fuzz-failure');
    assert.equal(result.findings[0].findingType, 'bug');
    assert.equal(result.findings[0].confidence, 'confirmed');
  });

  it('classifies a page.goto timeout as suspected/environmental (Fix E2)', async () => {
    const local = {
      plan: { targetUrl: 'https://example.com', apiEndpoints: [], fuzzTargets: [{
        pageUrl: 'https://example.com/checkout',
        fieldSelector: '#card',
        generators: ['empty'],
        iterations: 1,
        expectStatus: 'no-crash',
      }] },
      options: {},
      createFinding: createFindingFactory(),
      onEvent: () => {},
      signal: undefined,
    };
    local.context = {
      newPage: async () => ({
        goto: async () => { throw new Error('Timeout 10000ms exceeded'); },
        on: () => {},
        locator: () => ({ first: () => ({ fill: async () => {} }) }),
        close: async () => {},
      }),
    };

    const result = await fuzzExecutor(local);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].ruleId, 'fuzz-environmental');
    assert.equal(result.findings[0].findingType, 'environmental');
    assert.equal(result.findings[0].confidence, 'suspected');
    assert.equal(result.findings[0].severity, 'low');
  });
});
