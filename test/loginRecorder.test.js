import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LoginRecorder } from '../src/services/loginRecorder.js';
import { SessionStore } from '../src/services/sessionStore.js';

/**
 * Fake Playwright chromium + browser/context/page.
 * The recorder installs a `__sqaSave` binding via context.exposeBinding —
 * tests simulate the user clicking a banner button by invoking the captured
 * binding callback with a fake source ({ page }).
 */
function makeFakeChromium({ state, failGoto = false, pageUrl = 'https://app.com/login' } = {}) {
  const calls = { launched: false, headless: null, initScripts: [], bindings: [], storageStateRequests: 0 };
  const fakeContext = {
    addInitScript: async (script) => { calls.initScripts.push(script); },
    exposeBinding: async (name, fn) => { calls.bindings.push({ name, fn }); },
    newPage: async () => fakeContext._page,
    pages: () => [fakeContext._page],
    _page: {
      url: () => pageUrl,
      goto: async () => { if (failGoto) throw new Error('net down'); },
    },
    storageState: async () => {
      calls.storageStateRequests++;
      return state || { cookies: [{ name: 'sid', value: 'v', domain: '.app.com' }], origins: [] };
    },
    close: async () => { calls.contextClosed = true; },
  };
  const fakeBrowser = {
    newContext: async () => fakeContext,
    close: async () => { calls.browserClosed = true; },
  };
  const chromium = {
    launch: async (opts) => {
      calls.launched = true;
      calls.headless = opts?.headless;
      return fakeBrowser;
    },
  };
  /** Simulate the banner button invoking the binding from a given page. */
  const clickBanner = (action, sourcePageUrl = pageUrl) => {
    const binding = calls.bindings[calls.bindings.length - 1];
    binding.fn({ page: { url: () => sourcePageUrl } }, action);
  };
  return { chromium, calls, fakeContext, clickBanner };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sqa-recorder-'));
}

async function waitForDone(doneResults) {
  for (let i = 0; i < 50 && doneResults.length === 0; i++) await new Promise(r => setTimeout(r, 10));
}

describe('LoginRecorder', () => {
  let recorder;
  let dir;
  let doneResults;

  beforeEach(() => {
    dir = tmpDir();
    doneResults = [];
  });

  it('launches a HEADED browser, installs the __sqaSave binding, and saves on "save"', async () => {
    const fake = makeFakeChromium();
    recorder = new LoginRecorder({ chromium: fake.chromium, pollMs: 10, log: () => {} });
    const started = await recorder.start({
      monitorId: 'm1',
      url: 'https://app.com/login',
      onDone: (r) => doneResults.push(r),
    });
    assert.equal(started.started, true);
    assert.equal(fake.calls.launched, true);
    assert.equal(fake.calls.headless, false, 'recorder must be headed so the user can log in');
    assert.equal(fake.calls.initScripts.length, 1);
    assert.ok(fake.calls.initScripts[0].includes('__sqaSave'), 'banner must trigger via the __sqaSave binding');
    assert.ok(!fake.calls.initScripts[0].includes('__sqaRecorder'), 'no page-writable recorder state may remain');
    assert.equal(fake.calls.bindings[0].name, '__sqaSave');

    // user clicks Save in the banner (onDone fires asynchronously)
    fake.clickBanner('save');
    await recorder._checkBanner();
    await waitForDone(doneResults);

    assert.equal(doneResults.length, 1);
    assert.equal(doneResults[0].ok, true);
    assert.equal(doneResults[0].monitorId, 'm1');
    assert.equal(doneResults[0].state.cookies[0].name, 'sid');
    assert.equal(fake.calls.browserClosed, true);
    assert.equal(recorder.isActive(), false);
  });

  it('ignores page-set window state (no evaluate polling path)', async () => {
    const fake = makeFakeChromium();
    recorder = new LoginRecorder({ chromium: fake.chromium, pollMs: 10, log: () => {} });
    await recorder.start({ monitorId: 'm1', url: 'https://app.com/login', onDone: (r) => doneResults.push(r) });
    // A scanned page fakes the old flag — nothing polls window state anymore.
    fake.fakeContext._page.evaluate = async () => 'save';
    await recorder._checkBanner();
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(doneResults.length, 0, 'page-writable state must not trigger a save');
    await recorder.cancel('cleanup');
  });

  it('rejects a save triggered from a cross-origin page', async () => {
    const fake = makeFakeChromium();
    recorder = new LoginRecorder({ chromium: fake.chromium, pollMs: 10, log: () => {} });
    await recorder.start({ monitorId: 'm1', url: 'https://app.com/login', onDone: (r) => doneResults.push(r) });

    fake.clickBanner('save', 'https://evil.example/steal');
    await recorder._checkBanner();
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(doneResults.length, 0, 'cross-origin save must be ignored');
    assert.equal(recorder.isActive(), true, 'recording continues after an ignored save');

    // A same-origin save afterwards still works (user returns to the site)
    fake.clickBanner('save', 'https://app.com/dashboard');
    await recorder._checkBanner();
    await waitForDone(doneResults);
    assert.equal(doneResults[0].ok, true);
  });

  it('accepts a role option and reports it in the onDone result', async () => {
    const fake = makeFakeChromium();
    recorder = new LoginRecorder({ chromium: fake.chromium, pollMs: 10, log: () => {} });
    const started = await recorder.start({
      monitorId: 'm1',
      url: 'https://app.com/login',
      role: 'admin',
      onDone: (r) => doneResults.push(r),
    });
    assert.equal(started.role, 'admin');
    fake.clickBanner('save');
    await recorder._checkBanner();
    await waitForDone(doneResults);
    assert.equal(doneResults[0].role, 'admin');
  });

  it('rejects invalid roles', async () => {
    const fake = makeFakeChromium();
    recorder = new LoginRecorder({ chromium: fake.chromium, pollMs: 10, log: () => {} });
    await assert.rejects(
      () => recorder.start({ monitorId: 'm1', url: 'https://app.com/login', role: '../evil', onDone: () => {} }),
      /Invalid role/
    );
    assert.equal(recorder.isActive(), false);
  });

  it('cancels without saving when the user clicks Cancel', async () => {
    const fake = makeFakeChromium();
    recorder = new LoginRecorder({ chromium: fake.chromium, pollMs: 10, log: () => {} });
    await recorder.start({ monitorId: 'm1', url: 'https://app.com/login', onDone: (r) => doneResults.push(r) });
    fake.clickBanner('cancel');
    await recorder._checkBanner();
    await waitForDone(doneResults);
    assert.equal(doneResults[0].ok, false);
    assert.equal(doneResults[0].reason, 'user-cancel');
    assert.equal(doneResults[0].state, undefined);
  });

  it('supports user-initiated cancel from the dashboard', async () => {
    const fake = makeFakeChromium();
    recorder = new LoginRecorder({ chromium: fake.chromium, pollMs: 10, log: () => {} });
    await recorder.start({ monitorId: 'm1', url: 'https://app.com/login', onDone: (r) => doneResults.push(r) });
    const result = await recorder.cancel('user-cancel-dashboard');
    assert.equal(result.ok, true);
    await waitForDone(doneResults);
    assert.equal(doneResults[0].reason, 'user-cancel-dashboard');
    assert.equal(recorder.isActive(), false);
  });

  it('refuses to start two recordings at once', async () => {
    const fake = makeFakeChromium();
    recorder = new LoginRecorder({ chromium: fake.chromium, pollMs: 10000, log: () => {} });
    await recorder.start({ monitorId: 'm1', url: 'https://app.com/login', onDone: () => {} });
    await assert.rejects(
      () => recorder.start({ monitorId: 'm2', url: 'https://app.com/login', onDone: () => {} }),
      /already in progress/
    );
    await recorder.cancel('cleanup');
  });

  it('end-to-end: saved recording is encrypted in the SessionStore and loadable', async () => {
    const fake = makeFakeChromium();
    recorder = new LoginRecorder({ chromium: fake.chromium, pollMs: 10, log: () => {} });
    const store = new SessionStore({ dataDir: dir, secret: 'test-secret' });

    await recorder.start({
      monitorId: 'm1',
      url: 'https://app.com/login',
      onDone: (r) => doneResults.push(r),
    });
    fake.clickBanner('save');
    await recorder._checkBanner();
    await assert.doesNotReject(async () => {
      // wait for the async onDone persist path
      for (let i = 0; i < 20 && doneResults.length === 0; i++) {
        await new Promise(r => setTimeout(r, 10));
      }
    });

    await store.saveSession('m1', doneResults[0].state, doneResults[0].role);
    const loaded = await store.loadSession('m1');
    assert.equal(loaded.cookies[0].domain, '.app.com');
  });

  it('throws NO_DISPLAY error on Linux when DISPLAY is missing', async () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const origDisplay = process.env.DISPLAY;
    const origWayland = process.env.WAYLAND_DISPLAY;

    try {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      delete process.env.DISPLAY;
      delete process.env.WAYLAND_DISPLAY;

      const fake = makeFakeChromium();
      const rec = new LoginRecorder({ chromium: fake.chromium });
      await assert.rejects(
        async () => {
          await rec.start({
            monitorId: 'm1',
            url: 'https://app.com/login',
            onDone: () => {},
          });
        },
        (err) => {
          assert.equal(err.code, 'NO_DISPLAY');
          assert.match(err.message, /Login recording needs a display/);
          return true;
        }
      );
    } finally {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
      if (origDisplay !== undefined) process.env.DISPLAY = origDisplay;
      if (origWayland !== undefined) process.env.WAYLAND_DISPLAY = origWayland;
    }
  });
});
