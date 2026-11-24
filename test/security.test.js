import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import securityExecutor, { analyzeCookie, analyzeCors, analyzeCsp, detectMixedContent } from '../src/executors/security.js';
import { createFindingFactory } from '../src/services/findingFactory.js';

// ─── mock fetch helper ───────────────────────────────────────────────

function makeMockFetch(routes) {
  return async (url) => {
    const u = typeof url === 'string' ? url : url.toString();
    const match = routes.find(r => u.includes(r.url));
    if (!match) throw new Error(`No mock for ${u}`);
    const headers = new Headers();
    for (const [k, v] of Object.entries(match.headers || {})) headers.set(k, v);
    if (match.cookies) {
      // Headers polyfill: simulate set-cookie via raw set
      const setCookie = headers.setRaw ? headers.setRaw : (k, v) => headers.set(k, v);
      for (const c of match.cookies) {
        headers.append('set-cookie', c);
      }
      // Some implementations need getSetCookie(); mock it on the Headers instance
      headers.getSetCookie = () => match.cookies;
    } else {
      headers.getSetCookie = () => [];
    }
    return { status: match.status || 200, headers };
  };
}

const baseCtx = (overrides = {}) => ({
  plan: { targetUrl: 'https://example.com', pages: [] },
  createFinding: createFindingFactory(),
  onEvent: () => {},
  signal: undefined,
  options: {},
  ...overrides,
});

// ─── analyzeCookie ──────────────────────────────────────────────────

describe('analyzeCookie', () => {
  it('flags HTTPS cookie missing Secure flag', () => {
    const issues = analyzeCookie('session=abc123; Path=/', 'https://example.com');
    assert.ok(issues.some(i => i.ruleId === 'cookie-no-secure'));
    assert.ok(issues.some(i => i.ruleId === 'cookie-no-httponly'));
    assert.ok(issues.some(i => i.ruleId === 'cookie-no-samesite'));
  });

  it('does NOT flag missing Secure over HTTP', () => {
    const issues = analyzeCookie('session=abc123; Path=/', 'http://example.com');
    assert.ok(!issues.some(i => i.ruleId === 'cookie-no-secure'));
  });

  it('passes when all attributes present (HTTPS)', () => {
    const issues = analyzeCookie(
      'session=abc123; Path=/; Secure; HttpOnly; SameSite=Lax',
      'https://example.com'
    );
    assert.equal(issues.length, 0);
  });

  it('flags SameSite=None without Secure', () => {
    const issues = analyzeCookie(
      'tracking=xyz; SameSite=None',
      'https://example.com'
    );
    assert.ok(issues.some(i => i.ruleId === 'cookie-samesite-none-insecure'));
  });

  it('passes SameSite=None with Secure', () => {
    const issues = analyzeCookie(
      'tracking=xyz; SameSite=None; Secure',
      'https://example.com'
    );
    assert.ok(!issues.some(i => i.ruleId === 'cookie-samesite-none-insecure'));
  });

  it('handles malformed cookie string', () => {
    const issues = analyzeCookie('just-a-name', 'https://example.com');
    // Should still flag missing attributes
    assert.ok(issues.some(i => i.ruleId === 'cookie-no-httponly'));
  });
});

// ─── detectMixedContent ─────────────────────────────────────────────

describe('detectMixedContent', () => {
  it('flags HTTP apiCalls on HTTPS page as active mixed content', () => {
    const issues = detectMixedContent({
      url: 'https://example.com/secure',
      apiCalls: [
        { method: 'GET', url: 'http://insecure.example.com/data' },
        { method: 'GET', url: 'https://api.example.com/ok' },
      ],
      imageDetails: [],
    });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].ruleId, 'mixed-content-active');
    assert.equal(issues[0].severity, 'high');
  });

  it('flags HTTP image src on HTTPS page as passive mixed content', () => {
    const issues = detectMixedContent({
      url: 'https://example.com/secure',
      apiCalls: [],
      imageDetails: [
        { src: 'http://insecure.example.com/logo.png' },
        { src: 'https://cdn.example.com/icon.png' },
      ],
    });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].ruleId, 'mixed-content-passive');
    assert.equal(issues[0].severity, 'medium');
  });

  it('returns no issues for HTTP page (mixed content only applies to HTTPS)', () => {
    const issues = detectMixedContent({
      url: 'http://example.com/insecure',
      apiCalls: [{ method: 'GET', url: 'http://other.com/data' }],
      imageDetails: [{ src: 'http://other.com/img.png' }],
    });
    assert.equal(issues.length, 0);
  });

  it('returns no issues for clean HTTPS page', () => {
    const issues = detectMixedContent({
      url: 'https://example.com',
      apiCalls: [{ method: 'GET', url: 'https://api.example.com/data' }],
      imageDetails: [{ src: 'https://cdn.example.com/img.png' }],
    });
    assert.equal(issues.length, 0);
  });

  it('handles page without apiCalls or imageDetails', () => {
    const issues = detectMixedContent({ url: 'https://example.com' });
    assert.equal(issues.length, 0);
  });
});

describe('security policy analysis', () => {
  it('flags CSP values that allow unsafe script execution', () => {
    const issues = analyzeCsp("default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'");
    assert.ok(issues.some(issue => issue.ruleId === 'csp-unsafe-inline'));
    assert.ok(issues.some(issue => issue.ruleId === 'csp-unsafe-eval'));
  });

  it('flags wildcard CORS paired with credentials', () => {
    const issues = analyzeCors({
      'access-control-allow-origin': '*',
      'access-control-allow-credentials': 'true',
    });
    assert.equal(issues[0].ruleId, 'cors-wildcard-credentials');
  });
});

// ─── executor end-to-end ────────────────────────────────────────────

describe('security executor', () => {
  let ctx;
  let events;

  beforeEach(() => {
    events = [];
    ctx = baseCtx({ onEvent: (e) => events.push(e) });
  });

  it('flags missing security headers', async () => {
    ctx.options.fetch = makeMockFetch([
      { url: 'https://example.com', headers: {} },
    ]);
    ctx.plan.pages = [{ url: 'https://example.com' }];

    const result = await securityExecutor(ctx);
    // Missing: CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy,
    // Permissions-Policy, COOP, CORP
    assert.ok(result.findings.length >= 6);
    const ruleIds = result.findings.map(f => f.ruleId);
    assert.ok(ruleIds.includes('header-content-security-policy'));
    assert.ok(ruleIds.includes('header-strict-transport-security'));
    assert.ok(ruleIds.includes('header-x-content-type-options'));
  });

  it('passes when all security headers are present', async () => {
    ctx.options.fetch = makeMockFetch([
      {
        url: 'https://example.com',
        headers: {
          'content-security-policy': "default-src 'self'",
          'strict-transport-security': 'max-age=31536000; includeSubDomains',
          'x-frame-options': 'DENY',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'strict-origin-when-cross-origin',
          'permissions-policy': 'camera=()',
          'cross-origin-opener-policy': 'same-origin',
          'cross-origin-resource-policy': 'same-site',
        },
      },
    ]);
    ctx.plan.pages = [{ url: 'https://example.com' }];

    const result = await securityExecutor(ctx);
    const headerFindings = result.findings.filter(f => f.ruleId.startsWith('header-'));
    assert.equal(headerFindings.length, 0);
  });

  it('skips HSTS check on HTTP pages', async () => {
    ctx.options.fetch = makeMockFetch([
      { url: 'http://example.com', headers: {} },
    ]);
    ctx.plan.pages = [{ url: 'http://example.com' }];

    const result = await securityExecutor(ctx);
    assert.ok(!result.findings.some(f => f.ruleId === 'header-strict-transport-security'));
    assert.ok(result.findings.some(f => f.ruleId === 'transport-http'));
  });

  it('emits cookie findings when cookies lack attributes', async () => {
    ctx.options.fetch = makeMockFetch([
      {
        url: 'https://example.com',
        headers: {
          'content-security-policy': "default-src 'self'",
          'strict-transport-security': 'max-age=31536000',
          'x-frame-options': 'DENY',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'permissions-policy': 'camera=()',
          'cross-origin-opener-policy': 'same-origin',
          'cross-origin-resource-policy': 'same-site',
        },
        cookies: ['session=abc; Path=/'],
      },
    ]);
    ctx.plan.pages = [{ url: 'https://example.com' }];

    const result = await securityExecutor(ctx);
    const cookieFindings = result.findings.filter(f => f.ruleId.startsWith('cookie-'));
    assert.ok(cookieFindings.length >= 2);
  });

  it('includes mixed content findings from crawler data', async () => {
    ctx.options.fetch = makeMockFetch([
      { url: 'https://example.com', headers: {
        'content-security-policy': "default-src 'self'",
        'strict-transport-security': 'max-age=31536000',
        'x-frame-options': 'DENY',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'permissions-policy': 'camera=()',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-resource-policy': 'same-site',
      } },
    ]);
    ctx.plan.pages = [{
      url: 'https://example.com',
      apiCalls: [{ method: 'GET', url: 'http://insecure.com/data' }],
      imageDetails: [],
    }];

    const result = await securityExecutor(ctx);
    assert.ok(result.findings.some(f => f.ruleId === 'mixed-content-active'));
  });

  it('deduplicates URLs across pages + viewports', async () => {
    let callCount = 0;
    ctx.options.fetch = async () => { callCount++; return { status: 200, headers: new Headers() }; };
    ctx.plan.pages = [
      { url: 'https://example.com' },
      { url: 'https://example.com' },  // same URL, different viewport
      { url: 'https://example.com/about' },
    ];

    await securityExecutor(ctx);
    assert.equal(callCount, 2);  // dedup
  });

  it('handles fetch failure gracefully (skip page)', async () => {
    ctx.options.fetch = async () => { throw new Error('ECONNREFUSED'); };
    ctx.plan.pages = [{ url: 'https://down.example.com' }];

    const result = await securityExecutor(ctx);
    // Should not throw, just produce no header findings
    assert.equal(result.findings.length, 0);
    // Audit M-6: the failure must be visible and must not inflate the count.
    assert.equal(result.stats.pagesAudited, 0, 'a failed probe is not an audited page');
    assert.equal(result.stats.pagesProbeFailed, 1);
    assert.ok(events.some((e) => /security header probe failed for https:\/\/down\.example\.com/.test(e)));
  });
});

// ─── cross-page rollup (Phase 6) ─────────────────────────────────────

describe('security executor — cross-page rollup', () => {
  it('reports one finding per header rule per origin, with affectedPages', async () => {
    const ctx = baseCtx();
    ctx.options.fetch = makeMockFetch([
      { url: 'https://example.com', headers: {} },
    ]);
    ctx.plan.pages = [
      { url: 'https://example.com' },
      { url: 'https://example.com/about' },
      { url: 'https://example.com/pricing' },
    ];

    const result = await securityExecutor(ctx);
    const csp = result.findings.filter(f => f.ruleId === 'header-content-security-policy');
    assert.equal(csp.length, 1, 'one CSP finding for the whole origin, not one per page');
    assert.equal(csp[0].occurrences, 3);
    assert.deepEqual([...csp[0].affectedPages].sort(), [
      'https://example.com',
      'https://example.com/about',
      'https://example.com/pricing',
    ]);
    assert.equal(csp[0].pageUrl, 'https://example.com', 'stable alphabetically-first pageUrl for runDiff identity');
  });

  it('keeps cookie findings per page — the cookie identity is part of the finding', async () => {
    const ctx = baseCtx();
    ctx.options.fetch = makeMockFetch([
      {
        url: 'https://example.com',
        headers: {
          'content-security-policy': "default-src 'self'",
          'strict-transport-security': 'max-age=31536000',
          'x-frame-options': 'DENY',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'permissions-policy': 'camera=()',
          'cross-origin-opener-policy': 'same-origin',
          'cross-origin-resource-policy': 'same-site',
        },
        cookies: ['session=abc; Path=/'],
      },
    ]);
    ctx.plan.pages = [
      { url: 'https://example.com/login' },
      { url: 'https://example.com/settings' },
    ];

    const result = await securityExecutor(ctx);
    const httponly = result.findings.filter(f => f.ruleId === 'cookie-no-httponly');
    assert.equal(httponly.length, 2, 'cookie findings stay page-scoped');
  });

  it('keeps mixed content page-scoped — it depends on the page resources', async () => {
    const ctx = baseCtx();
    ctx.options.fetch = makeMockFetch([
      {
        url: 'https://example.com',
        headers: {
          'content-security-policy': "default-src 'self'",
          'strict-transport-security': 'max-age=31536000',
          'x-frame-options': 'DENY',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'permissions-policy': 'camera=()',
          'cross-origin-opener-policy': 'same-origin',
          'cross-origin-resource-policy': 'same-site',
        },
      },
    ]);
    ctx.plan.pages = [
      { url: 'https://example.com/a', apiCalls: [{ method: 'GET', url: 'http://insecure.com/x' }], imageDetails: [] },
      { url: 'https://example.com/b', apiCalls: [{ method: 'GET', url: 'http://insecure.com/y' }], imageDetails: [] },
    ];

    const result = await securityExecutor(ctx);
    const mixed = result.findings.filter(f => f.ruleId === 'mixed-content-active');
    assert.equal(mixed.length, 2, 'mixed content remains page-scoped');
  });
});

// ─── supply chain (audit L-2) ────────────────────────────────────────

describe('supply chain — scanned pages never execute remote scripts', () => {
  it('axe-core is injected only from the local install (no CDN fallback)', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const file of ['../src/executors/a11yDeep.js', '../src/mcp/scanEngine.js']) {
      const src = await readFile(new URL(file, import.meta.url), 'utf8');
      const cdn = new RegExp('unpkg' + '\\.com|jsdelivr' + '\\.net', 'i');
      assert.doesNotMatch(src, cdn, `${file} must not load remote scripts into a scanned page`);
    }
  });
});
