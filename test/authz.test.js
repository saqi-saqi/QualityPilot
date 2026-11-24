/**
 * test/authz.test.js — Phase 9 anonymous-reachability probe for
 * admin-namespaced APIs. The verified Juice Shop behavior this tests against:
 * GET /rest/admin/application-configuration → 200 anonymously (36KB of
 * config), while /rest/user/whoami returning an empty user anonymously is
 * CORRECT behavior and must not be flagged (hence the /admin scoping).
 */
import { describe, it, beforeEach, before, after } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import authzExecutor from '../src/executors/authz.js';
import { createFindingFactory } from '../src/services/findingFactory.js';

const makeCtx = (overrides = {}) => ({
  plan: { targetUrl: 'http://localhost:3000', apiEndpoints: [] },
  options: {},
  createFinding: createFindingFactory(),
  onEvent: () => {},
  signal: undefined,
  ...overrides,
});

const fetchJson = (status, body) => async () => ({ status, text: async () => body });

describe('authz executor', () => {
  let ctx;
  beforeEach(() => { ctx = makeCtx(); });

  it('flags an admin-namespaced GET endpoint reachable anonymously (verified: /rest/admin/application-configuration → 200)', async () => {
    ctx.plan.apiEndpoints = [
      { method: 'GET', path: '/rest/admin/application-configuration', queryParams: {} },
    ];
    ctx.options.fetch = fetchJson(200, '{"config":{}}');

    const result = await authzExecutor(ctx);
    assert.equal(result.findings.length, 1);
    const f = result.findings[0];
    assert.equal(f.ruleId, 'authz-missing');
    assert.equal(f.severity, 'medium');
    assert.equal(f.confidence, 'confirmed');
    assert.match(f.title, /admin/i);
    assert.doesNotMatch(f.evidence, /config/, 'admin response bodies are not recorded as evidence');
  });

  it('stays silent when the admin endpoint correctly requires authentication', async () => {
    ctx.plan.apiEndpoints = [
      { method: 'GET', path: '/rest/admin/application-configuration', queryParams: {} },
    ];
    ctx.options.fetch = fetchJson(401, '{"error":"unauthorized"}');

    const result = await authzExecutor(ctx);
    assert.equal(result.findings.length, 0);
  });

  it('does not flag non-admin endpoints (whoami returning an empty user anonymously is correct)', async () => {
    ctx.plan.apiEndpoints = [
      { method: 'GET', path: '/rest/user/whoami', queryParams: { fields: 'id,email' } },
    ];
    ctx.options.fetch = fetchJson(200, '{}');

    const result = await authzExecutor(ctx);
    assert.equal(result.stats.adminEndpointsProbed, 0, 'no /admin namespace → no probing');
    assert.equal(result.findings.length, 0);
  });

  it('caps probing at 10 endpoints', async () => {
    ctx.plan.apiEndpoints = Array.from({ length: 14 }, (_, i) => ({
      method: 'GET',
      path: `/rest/admin/endpoint-${i}`,
    }));
    let calls = 0;
    ctx.options.fetch = async () => { calls++; return { status: 200, text: async () => '{}' }; };

    await authzExecutor(ctx);
    assert.equal(calls, 10);
  });

  it('announces cap truncation instead of silently dropping endpoints (audit L-7)', async () => {
    const events = [];
    ctx = makeCtx({ onEvent: (m) => events.push(String(m)) });
    ctx.plan.apiEndpoints = Array.from({ length: 14 }, (_, i) => ({ method: 'GET', path: `/rest/admin/endpoint-${i}` }));
    ctx.options.fetch = fetchJson(401, '{}');
    await authzExecutor(ctx);
    assert.ok(events.some((m) => /first 10 of 14 admin endpoints/.test(m)), events.join(' | '));
  });

  it('one unusable baseUrl does not abort probing of later endpoints (audit L-7)', async () => {
    const events = [];
    ctx = makeCtx({ onEvent: (m) => events.push(String(m)) });
    ctx.plan.apiEndpoints = [
      { method: 'GET', path: '/rest/admin/broken', baseUrl: 'http://[not-a-url' },
      { method: 'GET', path: '/rest/admin/application-configuration' },
    ];
    ctx.options.fetch = fetchJson(200, '{"config":{}}');

    const result = await authzExecutor(ctx);
    assert.equal(result.findings.length, 1, 'the reachable endpoint after the broken one is still probed');
    assert.equal(result.findings[0].pageUrl.includes('/rest/admin/application-configuration'), true);
    assert.equal(result.stats.skippedNoBase, 1);
  });

  it('never records admin response bodies in evidence (may contain secrets)', async () => {
    ctx.plan.apiEndpoints = [{ method: 'GET', path: '/rest/admin/secret' }];
    ctx.options.fetch = fetchJson(200, '{"apiKey":"SUPER-SECRET-VALUE","users":["admin"]}');

    const result = await authzExecutor(ctx);
    const serialized = JSON.stringify(result.findings);
    assert.doesNotMatch(serialized, /SUPER-SECRET-VALUE/);
  });
});

describe('authz probe transport — per-hop SSRF validation (audit L-3)', () => {
  let server;
  let baseUrl;

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"config":{"deployed":true}}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('uses safeFetch: with the SSRF boundary ON, a loopback admin endpoint is never connected to', async () => {
    const prev = {
      SQA_ALLOW_PRIVATE: process.env.SQA_ALLOW_PRIVATE,
      ALLOW_PRIVATE_HOSTS: process.env.ALLOW_PRIVATE_HOSTS,
      ALLOW_PRIVATE_TARGETS: process.env.ALLOW_PRIVATE_TARGETS,
    };
    delete process.env.SQA_ALLOW_PRIVATE;
    delete process.env.ALLOW_PRIVATE_HOSTS;
    delete process.env.ALLOW_PRIVATE_TARGETS;
    try {
      const events = [];
      const ctx = makeCtx({
        plan: {
          targetUrl: baseUrl,
          apiEndpoints: [{ method: 'GET', path: '/rest/admin/application-configuration', queryParams: {} }],
        },
        options: {}, // NO injected fetch — the production transport (safeFetch) runs
        onEvent: (m) => events.push(String(m)),
      });
      const result = await authzExecutor(ctx);
      assert.equal(result.findings.length, 0, 'a loopback target must be blocked before any probe connects');
      assert.equal(result.stats.adminEndpointsProbed, 1);
      assert.equal(result.stats.reachableAnonymously, 0);
      assert.ok(
        events.some((m) => /blocked|Private hostname/i.test(m)),
        `expected a blocked-probe event, got: ${events.join(' | ')}`,
      );
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
