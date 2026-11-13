/**
 * executors/perf.js — performance metrics via CDP (Chrome DevTools Protocol).
 *
 * Consumes: plan.perfBudgets[]
 * Produces: findings when a budget is exceeded
 *
 * Uses Playwright's CDP session to capture LCP, CLS, FCP, TTFB, plus
 * per-request timing to compute TBT and resource counts.
 *
 * Phase 2 limitation: this executor requires a real Chromium browser with
 * CDP enabled. Tests use a mock CDP session; production runs use the
 * Playwright context's CDP session.
 */

import { config } from '../utils/config.js';

// Metric → threshold unit (for human-readable finding)
const METRIC_UNITS = {
  LCP: 'ms',
  CLS: 'unitless',
  TBT: 'ms',
  FCP: 'ms',
  TTFB: 'ms',
  INP: 'ms',
  pageSizeBytes: 'bytes',
  requestCount: 'requests',
};

// Fast 3G + 4x CPU throttling — applied only when plan.perfThrottle === true
export const THROTTLE_PRESET = {
  // Fast 3G (Lighthouse mobile preset)
  latencyMs: 150,
  downloadThroughputBytesPerSec: Math.floor((1.6 * 1024 * 1024) / 8),  // 1.6 Mbps
  uploadThroughputBytesPerSec: Math.floor((750 * 1024) / 8),           // 750 Kbps
  cpuThrottlingRate: 4,
};

/**
 * Capture performance metrics for a single page via CDP.
 *
 * @param {object} page       — Playwright Page
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.settleMs=2500] — time to wait after load for LCP to settle
 * @param {boolean} [opts.throttle=false] — emulate Fast 3G network + 4x CPU
 * @returns {Promise<{ metrics: { LCP, CLS, TBT, FCP, TTFB, INP, pageSizeBytes, requestCount, measured, throttled } }>}
 */
export async function capturePerfMetrics(page, url, opts = {}) {
  const settleMs = opts.settleMs ?? 2500;
  const timeoutMs = opts.timeout ?? (config?.pageTimeoutMs || 30000);
  const throttle = opts.throttle === true;

  // Create a CDP session if supported
  let client = null;
  let throttleApplied = false;
  try {
    client = await page.context().newCDPSession(page);
    await client.send('Performance.enable').catch(() => {});
    await client.send('Network.enable').catch(() => {});
    await client.send('Network.clearBrowserCache').catch(() => {});
    if (throttle) {
      // Throttling must be in place BEFORE navigation to affect the load.
      await client.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: THROTTLE_PRESET.latencyMs,
        downloadThroughput: THROTTLE_PRESET.downloadThroughputBytesPerSec,
        uploadThroughput: THROTTLE_PRESET.uploadThroughputBytesPerSec,
      }).then(() => { throttleApplied = true; }).catch(() => {});
      await client.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE_PRESET.cpuThrottlingRate }).catch(() => {});
    }
  } catch {
    // CDP not available (e.g. mock context in tests)
  }
  if (throttle && !throttleApplied) {
    console.warn('[perf] throttle requested but CDP network emulation unavailable — metrics are UNTHROTTLED');
  }

  // Pre-inject PerformanceObserver on the new document to buffer entries from the very start of navigation
  try {
    await page.addInitScript(() => {
      window.__perfEntries = [];
      try {
        const po = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            window.__perfEntries.push({
              entryType: entry.entryType,
              name: entry.name,
              value: entry.value,
              startTime: entry.startTime,
              duration: entry.duration,
              hadRecentInput: entry.hadRecentInput,
              interactionId: entry.interactionId ?? null,
            });
          }
        });
        po.observe({ type: 'largest-contentful-paint', buffered: true });
        po.observe({ type: 'layout-shift', buffered: true });
        po.observe({ type: 'paint', buffered: true });
        po.observe({ type: 'longtask', buffered: true });
        // Event Timing — 'event' entries carry interaction timing (INP-ish).
        // durationThreshold is required for the entry type to be delivered.
        try {
          po.observe({ type: 'event', buffered: true, durationThreshold: 16 });
        } catch {}
      } catch {}
    });
  } catch {}

  // Navigate to target URL
  await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });

  // Wait for settle
  await page.waitForTimeout(settleMs);

  // Evaluate performance metrics on the loaded page
  const evalResults = await page.evaluate(() => {
    const result = {
      LCP: null,
      CLS: 0,
      FCP: null,
      TTFB: null,
      TBT: 0,
      INP: null,
      measured: {
        LCP: false,
        CLS: false,
        FCP: false,
        TTFB: false,
        TBT: false,
        INP: false,
      },
    };

    // 1. Navigation / TTFB
    try {
      const navList = performance.getEntriesByType('navigation');
      if (navList.length > 0) {
        const nav = navList[0];
        if (nav.responseStart > 0 && nav.requestStart >= 0) {
          const ttfb = nav.responseStart - nav.requestStart;
          if (ttfb > 0) {
            result.TTFB = ttfb;
            result.measured.TTFB = true;
          }
        }
      }
    } catch {}

    if (result.TTFB == null && performance.timing) {
      const pt = performance.timing;
      if (pt.responseStart > 0 && pt.requestStart > 0) {
        const ttfb = pt.responseStart - pt.requestStart;
        if (ttfb > 0) {
          result.TTFB = ttfb;
          result.measured.TTFB = true;
        }
      }
    }

    // 2. Paint / FCP
    try {
      const paintList = performance.getEntriesByType('paint');
      for (const p of paintList) {
        if (p.name === 'first-contentful-paint' && p.startTime > 0) {
          result.FCP = p.startTime;
          result.measured.FCP = true;
        }
      }
    } catch {}

    // 3. LCP from getEntriesByType
    try {
      const lcpList = performance.getEntriesByType('largest-contentful-paint');
      if (lcpList.length > 0) {
        const lastLcp = lcpList[lcpList.length - 1];
        if (lastLcp.startTime > 0) {
          result.LCP = lastLcp.startTime;
          result.measured.LCP = true;
        }
      }
    } catch {}

    // 4. CLS & TBT from observer / buffered entries
    const buffered = window.__perfEntries || [];
    let clsSum = 0;
    let tbtSum = 0;
    let clsObserved = false;
    let tbtObserved = false;
    let inpObserved = false;
    let inpWorst = 0;

    try {
      const clsEntries = performance.getEntriesByType('layout-shift');
      for (const c of clsEntries) {
        clsObserved = true;
        if (!c.hadRecentInput) {
          clsSum += (c.value || 0);
        }
      }
    } catch {}

    try {
      const longtasks = performance.getEntriesByType('longtask');
      for (const lt of longtasks) {
        tbtObserved = true;
        tbtSum += Math.max(0, (lt.duration || 0) - 50);
      }
    } catch {}

    for (const e of buffered) {
      if ((e.entryType === 'largest-contentful-paint' || e.name === 'largest-contentful-paint') && (e.startTime || e.value) > 0) {
        result.LCP = Math.max(result.LCP || 0, e.startTime ?? e.value);
        result.measured.LCP = true;
      }
      if ((e.entryType === 'paint' && e.name === 'first-contentful-paint') && (e.startTime || e.value) > 0) {
        result.FCP = Math.max(result.FCP || 0, e.startTime ?? e.value);
        result.measured.FCP = true;
      }
      if (e.entryType === 'layout-shift' || e.name === 'layout-shift') {
        clsObserved = true;
        if (!e.hadRecentInput && e.value != null) {
          clsSum += e.value;
        }
      }
      if (e.entryType === 'longtask' || e.name === 'longtask') {
        tbtObserved = true;
        const dur = e.duration ?? e.value ?? 0;
        tbtSum += Math.max(0, dur - 50);
      }
      // Event Timing entries with an interactionId are real user
      // interactions — the worst interaction duration is our honest INP-ish
      // approximation (real INP is a 98th-percentile over interactions).
      if (e.entryType === 'event' && e.interactionId != null && e.interactionId > 0) {
        inpObserved = true;
        const dur = e.duration ?? 0;
        if (dur > inpWorst) inpWorst = dur;
      }
    }

    result.CLS = Number(clsSum.toFixed(3));
    result.measured.CLS = clsObserved;
    result.TBT = Math.round(tbtSum);
    result.measured.TBT = tbtObserved;
    result.measured.INP = inpObserved;
    result.INP = inpObserved ? Math.round(inpWorst) : null;

    return result;
  });

  // Resource count and size
  const resourceStats = await page.evaluate(() => {
    let totalSize = 0;
    const navEntries = performance.getEntriesByType('navigation');
    if (navEntries.length > 0) {
      totalSize += (navEntries[0].transferSize || navEntries[0].encodedBodySize || 0);
    }
    const entries = performance.getEntriesByType('resource');
    for (const e of entries) {
      totalSize += (e.transferSize || e.encodedBodySize || 0);
    }
    return { requestCount: entries.length, pageSizeBytes: totalSize };
  });

  if (client) {
    await client.detach().catch(() => {});
  }

  // Ensure "always measured" metrics (LCP, FCP, TTFB) are never bare 0:
  // If measured and > 0, return the number. If not measured, mark "unmeasured"
  const LCP = evalResults.measured.LCP && evalResults.LCP > 0
    ? Math.round(evalResults.LCP)
    : 'unmeasured';
  const FCP = evalResults.measured.FCP && evalResults.FCP > 0
    ? Math.round(evalResults.FCP)
    : 'unmeasured';
  const TTFB = evalResults.measured.TTFB && evalResults.TTFB > 0
    ? Math.round(evalResults.TTFB)
    : 'unmeasured';
  const CLS = evalResults.CLS;
  const TBT = evalResults.TBT;
  // INP-ish: worst observed interaction duration; 'unmeasured' when the page
  // produced no interaction-timing entries (same honest-unmeasured pattern
  // as the other metrics). Note: this approximates INP with the worst
  // interaction rather than the official 98th percentile.
  const INP = evalResults.measured.INP && evalResults.INP > 0
    ? Math.round(evalResults.INP)
    : 'unmeasured';

  return {
    metrics: {
      LCP,
      CLS,
      TBT,
      FCP,
      TTFB,
      INP,
      pageSizeBytes: resourceStats.pageSizeBytes,
      requestCount: resourceStats.requestCount,
      measured: {
        LCP: evalResults.measured.LCP && evalResults.LCP > 0,
        CLS: evalResults.measured.CLS,
        TBT: evalResults.measured.TBT,
        FCP: evalResults.measured.FCP && evalResults.FCP > 0,
        TTFB: evalResults.measured.TTFB && evalResults.TTFB > 0,
        INP: evalResults.measured.INP && evalResults.INP > 0,
      },
      throttled: throttleApplied,
      throttleRequested: throttle,
    },
  };
}

/**
 * Compare captured metrics against the plan's budgets.
 * Returns an array of { budget, actual, exceededBy } for each exceeded budget.
 */
export function checkBudgets(metrics, budgets) {
  const exceeded = [];
  for (const budget of budgets) {
    const rawActual = metrics[budget.metric];
    if (rawActual == null || rawActual === 'unmeasured') continue;
    const actual = typeof rawActual === 'object' && rawActual !== null ? rawActual.value : rawActual;
    if (typeof actual !== 'number' || isNaN(actual)) continue;
    if (actual > budget.threshold) {
      exceeded.push({
        budget,
        actual,
        exceededBy: actual - budget.threshold,
      });
    }
  }
  return exceeded;
}

/** Main executor entry — registered as 'perf' in the registry. */
export default async function perfExecutor(ctx) {
  if (!ctx.context) {
    ctx.onEvent?.('perf skipped — no Playwright context available');
    return { findings: [], stats: { skipped: true, reason: 'no-browser-context' } };
  }

  const pages = ctx.plan?.pages || [];
  const budgets = ctx.plan?.perfBudgets || [];
  const findings = [];

  ctx.onEvent?.(`Measuring performance on ${pages.length} pages`);

  for (const pageInfo of pages) {
    if (ctx.signal?.aborted) break;

    if (ctx.isPageFailed?.(pageInfo.url)) {
      ctx.recordPageFailure?.({ url: pageInfo.url, executor: 'perf' });
      continue;
    }

    const page = await ctx.context.newPage();
    try {
      const throttle = ctx.plan?.perfThrottle === true;
      const { metrics } = await capturePerfMetrics(page, pageInfo.url, { throttle });
      const exceeded = checkBudgets(metrics, budgets);

      const throttleNote = metrics.throttled
        ? `\nThrottling: metrics measured under simulated Fast 3G network (${THROTTLE_PRESET.downloadThroughputBytesPerSec * 8} bps down / ${THROTTLE_PRESET.uploadThroughputBytesPerSec * 8} bps up / ${THROTTLE_PRESET.latencyMs}ms RTT) and ${THROTTLE_PRESET.cpuThrottlingRate}x CPU throttling (plan.perfThrottle = true).`
        : (metrics.throttleRequested
          ? '\nThrottling: requested but CDP emulation unavailable — metrics are UNTHROTTLED.'
          : '');

      for (const ex of exceeded) {
        const unit = METRIC_UNITS[ex.budget.metric] || '';
        findings.push(ctx.createFinding({
          title: `Perf budget exceeded: ${ex.budget.metric} (${ex.actual}${unit} > ${ex.budget.threshold}${unit})`,
          severity: ex.budget.severity,
          confidence: 'confirmed',
          category: 'performance',
          findingType: ex.budget.severity === 'info' ? 'informational' : 'warning',
          origin: 'first-party',
          ruleId: `perf-budget-${ex.budget.metric}`,
          pageUrl: pageInfo.url,
          description: `Metric ${ex.budget.metric} exceeded its budget by ${Math.round(ex.exceededBy)}${unit}.${metrics.throttled ? ' Measured under simulated Fast 3G + 4x CPU throttling (plan.perfThrottle).' : ''}`,
          evidence: `Budget: ${ex.budget.threshold}${unit}\nActual: ${ex.actual}${unit}\nAll metrics: ${JSON.stringify(metrics)}${throttleNote}`,
          suggestedFix: getPerfFix(ex.budget.metric),
          metrics,
        }));
      }
    } catch (err) {
      if (ctx.recordPageFailure) {
        ctx.recordPageFailure({ url: pageInfo.url, error: err.message, executor: 'perf' });
      } else {
        findings.push(ctx.createFinding({
          title: `Page load failed: ${pageInfo.url}`,
          severity: 'info',
          confidence: 'high',
          category: 'Scan Coverage',
          findingType: 'coverage-failure',
          origin: 'first-party',
          ruleId: 'page-load-failure',
          pageUrl: pageInfo.url,
          description: err.message,
          evidence: err.message,
          blockedExecutors: ['perf'],
        }));
      }
    } finally {
      await page.close().catch(() => {});
    }
  }

  ctx.onEvent?.(`perf complete: ${findings.length} findings`);
  return { findings, stats: { pagesMeasured: pages.length, budgets: budgets.length } };
}

function getPerfFix(metric) {
  const fixes = {
    LCP: 'Optimize the largest above-the-fold element: preload hero images, reduce render-blocking JS, lazy-load below-the-fold.',
    CLS: 'Reserve space for ads/images with explicit width/height. Avoid injecting DOM above existing content.',
    TBT: 'Code-split long-running JS. Defer non-critical scripts. Use requestIdleCallback for low-priority work.',
    FCP: 'Reduce server response time (TTFB). Inline critical CSS. Eliminate render-blocking resources.',
    TTFB: 'Use a CDN. Optimize server-side rendering. Cache responses at the edge.',
    pageSizeBytes: 'Compress assets (Brotli/Gzip). Serve modern image formats (AVIF/WebP). Tree-shake JS.',
    requestCount: 'Bundle assets. Use HTTP/2 multiplexing. Inline small assets. Lazy-load below-the-fold.',
  };
  return fixes[metric] || 'Investigate the metric regression.';
}
