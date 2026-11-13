import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StateManager, isAuthFlow, resolveAuthRoles } from '../src/matrix/stateManager.js';

/** Minimal Playwright browser double: records cookies, closes cleanly. */
function makeFakeBrowser({ cookieCount = 2 } = {}) {
  const contexts = [];
  return {
    contexts,
    newContext: async () => {
      const context = {
        addCookies: async () => { context.cookiesApplied = true; },
        addInitScript: async () => { context.initScriptApplied = true; },
        cookies: async () => Array.from({ length: cookieCount }, (_, i) => ({
          name: `sid${i}`, value: 'v', domain: 'x.com', path: '/',
        })),
        newPage: async () => ({
          goto: async () => ({}),
          evaluate: async () => [],
          url: () => 'https://x.com/dashboard',
          close: async () => {},
        }),
        close: async () => {},
      };
      contexts.push(context);
      return context;
    },
  };
}

const loginPlan = {
  flows: [{
    name: 'Login',
    startUrl: 'https://x.com/login',
    steps: [{ action: 'fill', selector: '#user', value: 'u' }],
  }],
};

describe('StateManager cross-browser auth reuse', () => {
  it('priming captures one chromium snapshot per auth role', async () => {
    const events = [];
    const mgr = new StateManager({ runStep: async () => {}, onEvent: (m) => events.push(m) });
    const browser = makeFakeBrowser();
    await mgr.prime({ plan: loginPlan, browser, browserName: 'chromium', viewport: { width: 1280, height: 720 } });

    const snaps = mgr.listSnapshots();
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0].key, 'user:chromium');
    assert.equal(snaps[0].cookieCount, 2);
  });

  it('getSnapshot falls back to the chromium capture for other browsers (cookies are portable)', async () => {
    const events = [];
    const mgr = new StateManager({ runStep: async () => {}, onEvent: (m) => events.push(m) });
    await mgr.prime({ plan: loginPlan, browser: makeFakeBrowser(), browserName: 'chromium' });

    const firefoxSnap = mgr.getSnapshot('user', 'firefox');
    assert.ok(firefoxSnap, 'firefox role must reuse the chromium capture');
    assert.equal(firefoxSnap.role, 'user');
    assert.ok(events.some(e => /auth reused from chromium capture/.test(e)), 'fallback must emit an event');

    const webkitSnap = mgr.getSnapshot('user', 'webkit');
    assert.ok(webkitSnap);

    // anon never falls back — anonymous is intentionally unauthenticated
    assert.equal(mgr.getSnapshot('anon', 'firefox'), null);
  });

  it('applyTo uses the fallback for non-chromium cells', async () => {
    const mgr = new StateManager({ runStep: async () => {} });
    await mgr.prime({ plan: loginPlan, browser: makeFakeBrowser(), browserName: 'chromium' });

    const context = await makeFakeBrowser().newContext();
    const applied = await mgr.applyTo(context, 'user', 'firefox');
    assert.equal(applied, true);
    assert.equal(context.cookiesApplied, true);
  });

  it('re-primes ONCE when the TTL expires mid-run instead of going anonymous', async () => {
    const events = [];
    const mgr = new StateManager({
      runStep: async () => {},
      ttlMs: 10, // expire almost immediately
      onEvent: (m) => events.push(m),
    });
    const browser = makeFakeBrowser();
    await mgr.prime({ plan: loginPlan, browser, browserName: 'chromium' });

    // Wait past the 10ms TTL
    await new Promise(r => setTimeout(r, 30));
    assert.equal(mgr.getSnapshot('user', 'chromium'), null, 'snapshot expired');

    const context = await makeFakeBrowser().newContext();
    const applied = await mgr.applyTo(context, 'user', 'chromium');
    assert.equal(applied, true, 're-prime must restore auth');
    assert.ok(events.some(e => /expired — re-capturing login once/.test(e)));
    // captureAuthState ran a second time (2 contexts: prime + re-prime)
    assert.equal(browser.contexts.length, 2);

    // A SECOND expiry does not re-capture again — only once per role.
    await new Promise(r => setTimeout(r, 30));
    const secondContext = await makeFakeBrowser().newContext();
    // Note: the re-primed snapshot has a fresh TTL — force expiry by clearing
    mgr.snapshots.clear();
    const secondAttempt = await mgr.applyTo(secondContext, 'user', 'chromium');
    assert.equal(secondAttempt, false, 'no second re-prime — falls back to anonymous');
    assert.equal(browser.contexts.length, 2);
  });
});

describe('isAuthFlow', () => {
  it('flags flows named "Login" or "Sign In"', () => {
    assert.equal(isAuthFlow({ name: 'Login' }), true);
    assert.equal(isAuthFlow({ name: 'Sign In' }), true);
    assert.equal(isAuthFlow({ name: 'Authenticate' }), true);
  });

  it('flags flows tagged with auth:*', () => {
    assert.equal(isAuthFlow({ name: 'X', tags: ['auth'] }), true);
    assert.equal(isAuthFlow({ name: 'X', tags: ['login'] }), true);
  });

  it('does NOT flag non-auth flows', () => {
    assert.equal(isAuthFlow({ name: 'Browse Products' }), false);
    assert.equal(isAuthFlow({ name: 'Add to Cart' }), false);
    assert.equal(isAuthFlow({}), false);
    assert.equal(isAuthFlow(null), false);
  });

  it('is case-insensitive on flow name', () => {
    assert.equal(isAuthFlow({ name: 'login' }), true);
    assert.equal(isAuthFlow({ name: 'LOGIN' }), true);
    assert.equal(isAuthFlow({ name: 'sign in' }), true);
  });
});

describe('resolveAuthRoles', () => {
  it('always includes "anon" role', () => {
    const roles = resolveAuthRoles({ flows: [] });
    assert.ok('anon' in roles);
    assert.equal(roles.anon.flow, null);
  });

  it('maps "Login" flow to "user" role', () => {
    const flow = { name: 'Login', startUrl: 'https://x.com/login', steps: [] };
    const roles = resolveAuthRoles({ flows: [flow] });
    assert.ok('user' in roles);
    assert.equal(roles.user.flow, flow);
  });

  it('maps "Admin Login" flow to "admin" role', () => {
    const flow = { name: 'Admin Login', startUrl: 'https://x.com/admin', steps: [] };
    const roles = resolveAuthRoles({ flows: [flow] });
    assert.ok('admin' in roles);
    assert.equal(roles.admin.flow, flow);
  });

  it('maps "auth:editor" tag to "editor" role', () => {
    const flow = { name: 'Editor Flow', tags: ['auth:editor'], startUrl: 'https://x.com', steps: [] };
    const roles = resolveAuthRoles({ flows: [flow] });
    assert.ok('editor' in roles);
  });

  it('handles multiple roles from multiple flows', () => {
    const flows = [
      { name: 'Login', startUrl: 'https://x.com/login', steps: [] },
      { name: 'Admin Login', startUrl: 'https://x.com/admin', steps: [] },
      { name: 'Browse', startUrl: 'https://x.com', steps: [] },
    ];
    const roles = resolveAuthRoles({ flows });
    assert.ok('anon' in roles);
    assert.ok('user' in roles);
    assert.ok('admin' in roles);
    assert.ok(!('Browse' in roles));
  });

  it('handles null/undefined plan', () => {
    const roles = resolveAuthRoles(null);
    assert.ok('anon' in roles);
  });
});
