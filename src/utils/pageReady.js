/**
 * src/utils/pageReady.js — Smart Page Readiness & Animation Settle Engine
 *
 * Implements a robust composite readiness probe for web applications:
 *   1. Confirms DOMContentLoaded load state.
 *   2. Waits for a short bounded networkidle window (swallows timeouts so keep-alives don't hang).
 *   3. Waits for active loading indicators, busy states, and skeletons to detach.
 *   4. Waits for running CSS/Web animations to finish (with a strict ceiling for infinite spinners).
 *
 * Guarantees:
 *   • Never throws on timeout — returns diagnostic status so runners can proceed safely.
 *   • Records exactly which conditions timed out in `timedOut[]`.
 *   • Fully configurable timeouts and indicator selectors via options and environment variables.
 */

import { config } from './config.js';

/** Default loading indicator selectors searched when settling indicators. */
export const DEFAULT_LOADING_SELECTORS = [
  '[aria-busy="true"]',
  '[aria-label*="loading" i]',
  '.loading',
  '.spinner',
  '.skeleton',
  'progress:not([value])',
];

/**
 * Race a promise against a timeout, returning a fallback or timing out cleanly.
 */
function withTimeout(promise, ms, timeoutVal = 'timeout') {
  let timer;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve(timeoutVal), ms);
  });
  return Promise.race([
    promise.then((val) => {
      clearTimeout(timer);
      return val;
    }),
    timeoutPromise,
  ]);
}

/**
 * Wait for a page to be ready for interaction, scraping, or snapshotting.
 *
 * @param {import('playwright').Page} page — Playwright Page instance
 * @param {object} [options]
 * @param {number} [options.timeoutMs=5000] — overall fallback timeout ceiling
 * @param {string} [options.loadState='domcontentloaded'] — load state to wait for
 * @param {boolean} [options.networkIdle=true] — whether to wait for bounded networkidle
 * @param {number} [options.networkIdleTimeoutMs=1500] — maximum wait for network idle
 * @param {boolean} [options.settleIndicators] — wait for loading indicators to detach (default from env or true)
 * @param {number} [options.indicatorsTimeoutMs=3000] — maximum wait for indicators to disappear
 * @param {string[]} [options.indicatorSelectors] — list of selectors for loading elements
 * @param {boolean} [options.settleAnimations] — wait for Web Animations to settle (default from env or true)
 * @param {number} [options.animationsTimeoutMs=2000] — ceiling for animation settling
 * @param {function} [options.onEvent] — progress/diagnostic event callback
 * @returns {Promise<{ ok: boolean, durationMs: number, timedOut: string[] }>}
 */
export async function waitForPageReady(page, options = {}) {
  const startTime = Date.now();
  const timedOut = [];

  if (!page || typeof page.evaluate !== 'function') {
    return { ok: true, durationMs: 0, timedOut: [] };
  }

  const timeoutMs = options.timeoutMs ?? 5000;
  const loadState = options.loadState ?? 'domcontentloaded';
  const checkNetworkIdle = options.networkIdle !== false;
  const networkIdleTimeoutMs = Math.min(options.networkIdleTimeoutMs ?? 1500, timeoutMs);

  const shouldSettleIndicators = options.settleIndicators ??
    (process.env.SQA_SETTLE_INDICATORS !== 'false' && config?.settleIndicators !== false);
  const indicatorsTimeoutMs = Math.min(options.indicatorsTimeoutMs ?? 3000, timeoutMs);
  const indicatorSelectors = options.indicatorSelectors || DEFAULT_LOADING_SELECTORS;

  const shouldSettleAnimations = options.settleAnimations ??
    (process.env.SQA_SETTLE_ANIMATIONS !== 'false' && config?.settleAnimations !== false);
  const animationsTimeoutMs = Math.min(options.animationsTimeoutMs ?? 2000, timeoutMs);

  // ─── 1. Load State (domcontentloaded) ──────────────────────────────
  if (typeof page.waitForLoadState === 'function') {
    try {
      const loadResult = await withTimeout(
        page.waitForLoadState(loadState).catch(() => 'error'),
        Math.min(3000, timeoutMs),
        'timeout'
      );
      if (loadResult === 'timeout') {
        timedOut.push(`loadState:${loadState}`);
        options.onEvent?.(`pageReady: loadState (${loadState}) timed out`);
      }
    } catch {
      // Ignore navigation race errors
    }
  }

  // ─── 2. Bounded Network Idle ───────────────────────────────────────
  if (checkNetworkIdle && typeof page.waitForLoadState === 'function') {
    try {
      const netResult = await withTimeout(
        page.waitForLoadState('networkidle').catch(() => 'error'),
        networkIdleTimeoutMs,
        'timeout'
      );
      if (netResult === 'timeout') {
        timedOut.push('networkidle');
        options.onEvent?.('pageReady: networkidle timed out (background requests active)');
      }
    } catch {
      // Ignore
    }
  }

  // ─── 3. Loading Indicator Detachment ───────────────────────────────
  if (shouldSettleIndicators && indicatorSelectors.length > 0) {
    const combinedSelector = indicatorSelectors.join(', ');
    const deadline = Date.now() + indicatorsTimeoutMs;

    try {
      while (Date.now() < deadline) {
        // Query in browser whether any visible indicators remain
        const hasVisibleIndicator = await page.evaluate((sel) => {
          const els = document.querySelectorAll(sel);
          for (let i = 0; i < els.length; i++) {
            const el = els[i];
            const style = window.getComputedStyle(el);
            if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) return true;
            }
          }
          return false;
        }, combinedSelector).catch(() => false);

        if (!hasVisibleIndicator) {
          break;
        }

        // Wait a short poll step before re-checking
        await new Promise((r) => setTimeout(r, 50));
      }

      if (Date.now() >= deadline) {
        timedOut.push('indicators');
        options.onEvent?.(`pageReady: indicators timed out after ${indicatorsTimeoutMs}ms (${combinedSelector})`);
      }
    } catch {
      // Swallowed safely
    }
  }

  // ─── 4. Animation Settling ─────────────────────────────────────────
  if (shouldSettleAnimations) {
    const deadline = Date.now() + animationsTimeoutMs;

    try {
      while (Date.now() < deadline) {
        const hasRunningAnimations = await page.evaluate(() => {
          if (typeof document.getAnimations !== 'function') return false;
          const anims = document.getAnimations();
          return anims.some((a) => a.playState === 'running');
        }).catch(() => false);

        if (!hasRunningAnimations) {
          break;
        }

        await new Promise((r) => setTimeout(r, 50));
      }

      if (Date.now() >= deadline) {
        timedOut.push('animations');
        options.onEvent?.(`pageReady: animations settling reached ${animationsTimeoutMs}ms ceiling (proceeding)`);
      }
    } catch {
      // Swallowed safely
    }
  }

  const durationMs = Date.now() - startTime;
  return {
    ok: true,
    durationMs,
    timedOut,
  };
}
