import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserPool } from '../src/matrix/browserPool.js';

function fakeBrowser() {
  return {
    newContext: async (options) => ({
      options,
      close: async () => {},
    }),
    close: async () => {},
    on: () => {},
  };
}

describe('BrowserPool authentication isolation', () => {
  it('does not apply recorded storage state to the anonymous role', async () => {
    const browser = fakeBrowser();
    const pool = new BrowserPool({
      options: {
        storageStates: {
          user: { cookies: [{ name: 'sid', value: 'secret' }] },
        },
      },
    });
    pool.browsers.set('chromium', browser);

    const context = await pool.createContext({
      browserName: 'chromium',
      role: 'anon',
    });

    assert.equal(context.options.storageState, undefined);
    await pool.shutdown();
  });

  it('fails authenticated contexts when no authentication state is available', async () => {
    const browser = fakeBrowser();
    const pool = new BrowserPool({
      stateManager: { applyTo: async () => false },
    });
    pool.browsers.set('chromium', browser);

    await assert.rejects(
      () => pool.createContext({ browserName: 'chromium', role: 'user' }),
      /Authentication state unavailable for role "user"/
    );
    await pool.shutdown();
  });
});
