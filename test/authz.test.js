/**
 * test/authz.test.js — Phase 9 anonymous-reachability probe for
 * admin-namespaced APIs. The verified Juice Shop behavior this tests against:
 * GET /rest/admin/application-configuration → 200 anonymously (36KB of
 * config), while /rest/user/whoami returning an empty user anonymously is
 * CORRECT behavior and must not be flagged (hence the /admin scoping).
 */
import { describe, it, beforeEach } from 'node:test';
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

  it('never records admin response bodies in evidence (may contain secrets)', async () => {
    ctx.plan.apiEndpoints = [{ method: 'GET', path: '/rest/admin/secret' }];
    ctx.options.fetch = fetchJson(200, '{"apiKey":"SUPER-SECRET-VALUE","users":["admin"]}');

    const result = await authzExecutor(ctx);
    const serialized = JSON.stringify(result.findings);
    assert.doesNotMatch(serialized, /SUPER-SECRET-VALUE/);
  });
});
