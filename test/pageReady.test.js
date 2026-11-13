import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixtureServer } from '../test/fixtures/site/server.js';
import { waitForPageReady, DEFAULT_LOADING_SELECTORS } from '../src/utils/pageReady.js';

describe('Smart Page Readiness & Animation Settle Engine (waitForPageReady)', () => {
  let browser = null;
  let fixture = null;

  before(async () => {
    browser = await chromium.launch({ headless: true });
    fixture = await startFixtureServer(0);
  });

  after(async () => {
    if (browser) await browser.close();
    if (fixture) await fixture.close();
  });

  it('resolves quickly on static pages loaded over HTTP', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${fixture.url}/page-ok.html`, { waitUntil: 'domcontentloaded' });

      const start = Date.now();
      const result = await waitForPageReady(page, {
        networkIdleTimeoutMs: 1000,
        animationsTimeoutMs: 500,
      });
      const duration = Date.now() - start;

      assert.equal(result.ok, true);
      assert.deepEqual(result.timedOut, []);
      assert.ok(duration < 1500, `Expected static page to resolve quickly, took ${duration}ms`);
    } finally {
      await page.close();
    }
  });

  it('waits for a delayed loading spinner to detach before proceeding', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <!DOCTYPE html>
        <html>
          <head><title>Delayed Spinner Page</title></head>
          <body>
            <div id="loader" class="spinner" style="width: 50px; height: 50px;">Loading data...</div>
            <div id="content" style="display: none;">Ready</div>
            <script>
              setTimeout(() => {
                const loader = document.getElementById('loader');
                if (loader) loader.remove();
                document.getElementById('content').style.display = 'block';
              }, 200);
            </script>
          </body>
        </html>
      `);

      const start = Date.now();
      const result = await waitForPageReady(page, {
        networkIdle: false,
        indicatorsTimeoutMs: 2000,
        animationsTimeoutMs: 500,
      });
      const duration = Date.now() - start;

      assert.equal(result.ok, true);
      assert.deepEqual(result.timedOut, []);
      // Should have waited for the 200ms timer to detach the element
      assert.ok(duration >= 180, `Expected wait for spinner detachment, took ${duration}ms`);

      // Confirm loader is actually gone
      const remaining = await page.$('.spinner');
      assert.equal(remaining, null);
    } finally {
      await page.close();
    }
  });

  it('safely bounds infinite CSS animations and proceeds without hanging or throwing', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <!DOCTYPE html>
        <html>
          <head>
            <style>
              @keyframes spin {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
              }
              .infinite-spinner {
                width: 40px;
                height: 40px;
                animation: spin 0.4s linear infinite;
              }
            </style>
          </head>
          <body>
            <div class="infinite-spinner"></div>
          </body>
        </html>
      `);

      const events = [];
      const start = Date.now();
      // Bound animation settling to 300ms ceiling for fast test execution
      const result = await waitForPageReady(page, {
        networkIdle: false,
        animationsTimeoutMs: 300,
        onEvent: (msg) => events.push(msg),
      });
      const duration = Date.now() - start;

      // Must never throw or reject
      assert.equal(result.ok, true);
      // Must record that animations timed out
      assert.ok(result.timedOut.includes('animations'), 'Expected timedOut to include "animations"');
      // Must have proceeded right around the 300ms ceiling
      assert.ok(duration >= 250 && duration < 800, `Expected bounded duration ~300ms, took ${duration}ms`);

      // Must log progress event
      const logMsg = events.find(e => e.includes('animations settling reached 300ms ceiling'));
      assert.ok(logMsg, `Expected timeout event log, got: ${JSON.stringify(events)}`);
    } finally {
      await page.close();
    }
  });

  it('respects settleAnimations: false and settleIndicators: false override flags', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <!DOCTYPE html>
        <html>
          <head>
            <style>
              @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0; } 100% { opacity: 1; } }
              .active-anim { animation: pulse 0.5s infinite; }
            </style>
          </head>
          <body>
            <div class="active-anim spinner" style="width: 20px; height: 20px;"></div>
          </body>
        </html>
      `);

      const start = Date.now();
      const result = await waitForPageReady(page, {
        networkIdle: false,
        settleAnimations: false,
        settleIndicators: false,
      });
      const duration = Date.now() - start;

      assert.equal(result.ok, true);
      assert.deepEqual(result.timedOut, []);
      // Bypasses waiting for either spinner or infinite animation
      assert.ok(duration < 200, `Expected fast bypass with flags false, took ${duration}ms`);
    } finally {
      await page.close();
    }
  });

  it('handles invalid or mock page objects gracefully without throwing', async () => {
    const resNull = await waitForPageReady(null);
    assert.equal(resNull.ok, true);
    assert.equal(resNull.durationMs, 0);

    const resEmpty = await waitForPageReady({});
    assert.equal(resEmpty.ok, true);
    assert.equal(resEmpty.durationMs, 0);
  });
});
