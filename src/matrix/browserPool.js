/**
 * matrix/browserPool.js — manage Playwright browsers + contexts across matrix runs.
 *
 * Goal: launch one Browser per browser type (chromium/firefox/webkit),
 * spawn fresh BrowserContexts per (viewport × role), apply auth state
 * from StateManager. Closes everything on shutdown.
 *
 * Without a pool, the matrix would launch dozens of browser processes —
 * slow + memory-hungry. With the pool, each browser launches once.
 */

import { chromium, firefox, webkit } from 'playwright';
import { config } from '../utils/config.js';
import { getSharedEgressProxy, stopSharedEgressProxy } from '../security/egressProxy.js';

const BROWSER_LAUNCHERS = {
  chromium,
  firefox,
  webkit,
};

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Chromium launch args honoring config.chromiumNoSandbox (default: sandboxed —
 * set SQA_CHROMIUM_NO_SANDBOX=true only when a container truly requires it)
 * plus an optional SSRF-pinned host resolver rule and proxy bypass list.
 */
function launchArgs({ hostResolverRules, hasProxy } = {}) {
  const args = ['--disable-setuid-sandbox', '--disable-dev-shm-usage'];
  if (config?.chromiumNoSandbox === true) {
    args.unshift('--no-sandbox');
  }
  if (hostResolverRules) {
    args.push(`--host-resolver-rules=${hostResolverRules}`);
  }
  if (hasProxy) {
    args.push('--proxy-bypass-list=<-loopback>');
  }
  return args;
}

export class BrowserPool {
  constructor({ stateManager, options = {} } = {}) {
    this.stateManager = stateManager;
    this.options = options;
    this.browsers = new Map();        // browserName → Browser
    this.contexts = [];                // tracking for shutdown
    this.launching = new Map();        // browserName → Promise<Browser> (de-dupe concurrent launches)
    this.egressProxy = null;
    this._shutdown = false;
  }

  /**
   * Get-or-launch a Playwright Browser for the given browser type.
   * Concurrent calls for the same browser share a single launch.
   *
   * Resilience:
   *   • a failed launch never poisons the pool — the pending entry is removed
   *     before the rejection propagates, so the next call retries cleanly;
   *   • a browser that disconnects (crash / OOM-kill / explicit close) is
   *     removed from the pool, so the next createContext relaunches it.
   */
  async getBrowser(browserName) {
    if (this._shutdown) {
      throw new Error('BrowserPool has been shut down');
    }
    const launcher = BROWSER_LAUNCHERS[browserName];
    if (!launcher) {
      throw new Error(`Unknown browser: ${browserName}. Supported: ${Object.keys(BROWSER_LAUNCHERS).join(', ')}`);
    }

    if (this.browsers.has(browserName)) {
      return this.browsers.get(browserName);
    }

    // De-dupe concurrent launches
    if (this.launching.has(browserName)) {
      return this.launching.get(browserName);
    }

    const launchPromise = (async () => {
      try {
        let proxy = this.options.proxy;
        if (!proxy && !config.allowPrivateTargets && this.options.allowPrivateTargets !== true) {
          if (!this.egressProxy) {
            this.egressProxy = await getSharedEgressProxy();
          }
          proxy = { server: this.egressProxy.proxyUrl };
        }

        const browser = await launcher.launch({
          args: browserName === 'chromium'
            ? launchArgs({ hostResolverRules: this.options.hostResolverRules, hasProxy: !!proxy })
            : undefined,
          headless: this.options.headless !== false,
          ...(proxy ? { proxy } : {}),
        });
        // Crash/kill resilience: drop the dead browser so the next
        // createContext transparently relaunches.
        browser.on('disconnected', () => {
          this.browsers.delete(browserName);
        });
        this.browsers.set(browserName, browser);
        return browser;
      } finally {
        // ALWAYS clear the pending entry — on success and on failure. A
        // rejected launch promise left in `this.launching` would make every
        // future getBrowser() await the same failure forever.
        this.launching.delete(browserName);
      }
    })();

    this.launching.set(browserName, launchPromise);
    return launchPromise;
  }

  /**
   * Create a fresh BrowserContext configured for a specific
   * (browser, viewport, role) combination.
   *
   * Applies auth state from StateManager if available.
   */
  async createContext({ browserName, viewport, role = 'anon', evidence = null }) {
    const browser = await this.getBrowser(browserName);
    const storageState = role === 'anon'
      ? undefined
      : (this.options.storageStates?.[role] || this.options.storageState);

    const context = await browser.newContext({
      viewport: viewport || { width: 1280, height: 720 },
      userAgent: this.options.userAgent || DEFAULT_USER_AGENT,
      locale: 'en-US',
      ignoreHTTPSErrors: this.options.ignoreHTTPSErrors || false,
      // The agent injects its own tooling (axe-core) into scanned pages;
      // hardened sites' CSP/Trusted-Types would otherwise block that.
      // Plan option `bypassCsp` defaults to true (overridable per plan).
      bypassCSP: this.options.bypassCsp !== false,
      // Phase 4 evidence capture: record video for browser cells (kept only
      // when the cell produced failures — see matrixRunner runCell).
      ...(evidence?.videoDir ? { recordVideo: { dir: evidence.videoDir, size: { width: 800, height: 600 } } } : {}),
      ...(storageState ? { storageState } : {}),
    });

    // Phase 4 evidence capture: start tracing at context creation; the
    // caller stops it with a path (failure) or without one (discard).
    if (evidence?.tracing) {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false }).catch(() => {});
    }

    this.contexts.push(context);

    // Apply auth state if we have a snapshot for this (role, browser)
    if (this.stateManager && role !== 'anon') {
      const applied = await this.stateManager.applyTo(context, role, browserName);
      if (!applied && !storageState) {
        await context.close().catch(() => {});
        const idx = this.contexts.indexOf(context);
        if (idx >= 0) this.contexts.splice(idx, 1);
        throw new Error(`Authentication state unavailable for role "${role}" on ${browserName}`);
      }
    }

    return context;
  }

  /**
   * Close a single context (called by executors when done with a matrix cell).
   */
  async releaseContext(context) {
    const idx = this.contexts.indexOf(context);
    if (idx >= 0) this.contexts.splice(idx, 1);
    await context.close().catch(() => {});
  }

  /**
   * Close everything — browsers + contexts.
   * Safe to call multiple times.
   */
  async shutdown() {
    if (this._shutdown) return;
    this._shutdown = true;

    // Close contexts first (faster, doesn't block on browsers)
    await Promise.allSettled(
      this.contexts.splice(0).map(c => c.close())
    );

    // Then browsers
    const browsers = Array.from(this.browsers.values());
    this.browsers.clear();
    await Promise.allSettled(browsers.map(b => b.close()));

    this.launching.clear();

    if (this.egressProxy) {
      await stopSharedEgressProxy().catch(() => {});
      this.egressProxy = null;
    }
  }

  /**
   * List currently-open contexts (for stats / debugging).
   */
  stats() {
    return {
      browsers: Array.from(this.browsers.keys()),
      openContexts: this.contexts.length,
      launching: Array.from(this.launching.keys()),
    };
  }
}
