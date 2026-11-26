/**
 * matrix/sharding.js — deterministic CI matrix sharding and report merging.
 *
 * Design:
 *   • Keeps the zero-infrastructure single-SQLite-file promise intact: each
 *     shard runs with its own isolated SQLite DB + screenshot/evidence directory
 *     under <dataDir>/shards/shard-<i>-of-<N>/ and emits a portable JSON artifact.
 *   • `mergeShardReports()` unifies shard artifacts by re-running the same
 *     dedup, site-wide/document-template rollup, matrix agreement classifiers,
 *     coverage computation, and quality scoring as a single unsharded run.
 */
import path from 'node:path';
import { canonicalizeUrl } from '../utils/classify.js';
import { dedupFindings } from './matrixRunner.js';
import {
  pageScopeAgreement,
  crossCellAgreement,
  promotePageLoadFailures,
} from './matrixClassifier.js';
import { rollupAcrossPages } from '../services/findingRollup.js';
import { isSiteWideHeaderFinding } from '../executors/security.js';
import { isDocumentScopedAxeFinding } from '../executors/a11yDeep.js';
import { calculateScore, summarizeFindings, isCoverageFailure } from '../services/scoring.js';
import { createFindingFactory } from '../services/findingFactory.js';

/**
 * Parse a `--shard i/N` specification. Both parts must be positive integers
 * with 1 <= index <= total.
 */
export function parseShardSpec(raw) {
  const value = String(raw || '').trim();
  const match = value.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!match) {
    throw new Error(`Invalid --shard value "${raw}": expected format <index>/<total> (e.g. 1/4)`);
  }
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || index < 1 || index > total) {
    throw new Error(`Invalid --shard value "${raw}": require 1 <= index <= total and total >= 1`);
  }
  return { index, total, spec: `${index}/${total}` };
}

/**
 * Isolated per-shard storage locations so parallel CI workers (or local
 * multi-shard processes) never share a SQLite DB or screenshot directory.
 */
export function resolveShardStorage(shard, baseDataDir = './data') {
  const root = path.resolve(baseDataDir || './data');
  const shardDir = path.join(root, 'shards', `shard-${shard.index}-of-${shard.total}`);
  return {
    dataDir: shardDir,
    dbPath: path.join(shardDir, 'testigator.sqlite'),
    screenshotsDir: path.join(shardDir, 'screenshots'),
    evidenceDir: path.join(shardDir, 'evidence'),
  };
}

function cellWeight(cell) {
  if (!cell.needsBrowser) return 1;
  const execs = new Set(cell.executors || []);
  let w = 4;
  if (execs.has('accessibility-deep')) w += 3;
  if (execs.has('perf')) w += 3;
  if (execs.has('visual')) w += 3;
  if (execs.has('e2e')) w += 2;
  if (execs.has('injection')) w += 2;
  return w;
}

function filterItemsByPages(items, allowedCanonUrls, urlKey = 'pageUrl') {
  if (!Array.isArray(items)) return [];
  return items.filter((item) => {
    const u = item?.[urlKey] || item?.url;
    if (!u) return true;
    return allowedCanonUrls.has(canonicalizeUrl(u));
  });
}

function roundRobinSlice(items, shardIndex, shardTotal) {
  if (!Array.isArray(items)) return [];
  const targetBucket = shardIndex - 1;
  return items.filter((_, idx) => (idx % shardTotal) === targetBucket);
}

/**
 * Partition work across N shards deterministically:
 *   1. Multi-cell matrices (browser cells >= total): distribute whole cells via
 *      weighted greedy load balancing across buckets 1..N.
 *   2. Single-browser / small-cell plans with multiple pages: split the page set,
 *      matching per-page targets (a11yRules, perfBudgets, visualBaselines,
 *      fuzzTargets), apiEndpoints, and flows round-robin across shards, and run
 *      zero-navigation site-wide cells on shard 1 so wall time scales down even
 *      when only one browser/viewport is configured.
 *
 * Always preserves `coveredPages` = the full plan page set so coverage and
 * page-scope agreement behave identically to an unsharded run.
 */
export function partitionShardWorkload({ plan, cells, shard }) {
  if (!plan) throw new Error('partitionShardWorkload requires plan');
  if (!Array.isArray(cells)) throw new Error('partitionShardWorkload requires cells');
  if (!shard || shard.total <= 1) {
    return {
      mode: 'unsharded',
      plan,
      cells,
      coveredPages: (plan.pages || []).map((p) => p.url).filter(Boolean),
      totalMatrixCells: cells.length,
    };
  }

  const coveredPages = (plan.pages || []).map((p) => p.url).filter(Boolean);
  const totalMatrixCells = cells.length;
  const browserCellCount = cells.filter((c) => c.needsBrowser).length;

  // Case 1: Enough browser cells to spread across shards directly.
  if (browserCellCount >= shard.total) {
    const loads = Array.from({ length: shard.total }, () => 0);
    const buckets = Array.from({ length: shard.total }, () => []);
    const indexed = cells.map((cell, origIdx) => ({ cell, origIdx, weight: cellWeight(cell) }));
    indexed.sort((a, b) => (b.weight - a.weight) || (a.origIdx - b.origIdx));

    for (const item of indexed) {
      let best = 0;
      for (let b = 1; b < shard.total; b++) {
        if (loads[b] < loads[best]) best = b;
      }
      buckets[best].push(item);
      loads[best] += item.weight;
    }

    const assigned = buckets[shard.index - 1]
      .sort((a, b) => a.origIdx - b.origIdx)
      .map((item) => item.cell);

    return {
      mode: 'cell-partition',
      plan,
      cells: assigned,
      coveredPages,
      totalMatrixCells,
    };
  }

  // Case 2: Fewer browser cells than shards (e.g. 1 browser × 1 viewport across
  // N pages). Slice page-bound work and endpoints deterministically per shard.
  const shardPages = roundRobinSlice(plan.pages || [], shard.index, shard.total);
  const allowedCanon = new Set(shardPages.map((p) => canonicalizeUrl(p.url)));

  const slicedFlows = roundRobinSlice(plan.flows || [], shard.index, shard.total);
  const slicedEndpoints = roundRobinSlice(plan.apiEndpoints || [], shard.index, shard.total);
  const slicedA11y = filterItemsByPages(plan.a11yRules || [], allowedCanon, 'pageUrl');
  const slicedPerf = filterItemsByPages(plan.perfBudgets || [], allowedCanon, 'pageUrl');
  const slicedVisual = filterItemsByPages(plan.visualBaselines || [], allowedCanon, 'pageUrl');
  const slicedFuzz = (plan.fuzzTargets || []).filter((t) => {
    if (t.pageUrl) return allowedCanon.has(canonicalizeUrl(t.pageUrl));
    return true;
  });

  const slicedPlan = {
    ...plan,
    pages: shardPages,
    flows: slicedFlows,
    apiEndpoints: slicedEndpoints,
    a11yRules: slicedA11y,
    perfBudgets: slicedPerf,
    visualBaselines: slicedVisual,
    fuzzTargets: slicedFuzz,
  };

  // Site-wide no-browser cells (legacy-links/console/network) only inspect crawled
  // pages in memory — run once on shard 1 so findings don't duplicate N times.
  // Keep browser/API cells only when this shard actually owns work for them.
  const hasEndpoints = slicedEndpoints.length > 0;
  const hasPages = shardPages.length > 0;
  const hasFlows = slicedFlows.length > 0;

  const assignedCells = cells.filter((cell) => {
    if (cell.id === 'no-browser::site') return shard.index === 1;
    if (!cell.needsBrowser) {
      // api-contract / authz / security
      return hasPages || hasEndpoints;
    }
    const execs = new Set(cell.executors || []);
    if (execs.has('accessibility-deep') || execs.has('perf') || execs.has('visual')) {
      return slicedA11y.length > 0 || slicedPerf.length > 0 || slicedVisual.length > 0 || hasPages;
    }
    return hasPages || hasFlows || hasEndpoints;
  });

  return {
    mode: 'page-partition',
    plan: slicedPlan,
    cells: assignedCells,
    coveredPages,
    totalMatrixCells,
  };
}

function dedupPageObjects(pages = []) {
  const byUrl = new Map();
  for (const p of pages) {
    if (!p || !p.url) continue;
    const key = canonicalizeUrl(p.url);
    if (!byUrl.has(key)) byUrl.set(key, p);
  }
  return Array.from(byUrl.values());
}

/**
 * Unify an array of shard run JSON objects into a single consistent run/verdict.
 */
export function mergeShardReports(shardReports, { expectShards = null } = {}) {
  if (!Array.isArray(shardReports) || shardReports.length === 0) {
    throw new Error('mergeShardReports requires at least one shard report');
  }

  // Validate shard completeness when shard metadata is present.
  const seenIndices = new Set();
  const declaredTotals = new Set();
  for (let i = 0; i < shardReports.length; i++) {
    const r = shardReports[i];
    if (!r || !Array.isArray(r.findings)) {
      throw new Error(`Shard report #${i + 1} is missing a findings array`);
    }
    if (r.shard && Number.isInteger(r.shard.index) && Number.isInteger(r.shard.total)) {
      if (seenIndices.has(r.shard.index)) {
        throw new Error(`Duplicate shard index ${r.shard.index}/${r.shard.total} in merge inputs`);
      }
      seenIndices.add(r.shard.index);
      declaredTotals.add(r.shard.total);
    }
  }

  if (declaredTotals.size > 1) {
    throw new Error(`Shard total mismatch across inputs: ${[...declaredTotals].join(', ')}`);
  }
  const expectedTotal = expectShards ?? (declaredTotals.size === 1 ? [...declaredTotals][0] : null);
  if (expectedTotal != null && seenIndices.size > 0 && seenIndices.size !== expectedTotal) {
    const missing = [];
    for (let k = 1; k <= expectedTotal; k++) {
      if (!seenIndices.has(k)) missing.push(k);
    }
    throw new Error(`Incomplete shard set: expected ${expectedTotal} shards, got ${seenIndices.size} (missing: ${missing.join(', ')})`);
  }

  // Fail closed if any shard failed or had incomplete matrix cells.
  const shardErrors = [];
  for (let i = 0; i < shardReports.length; i++) {
    const r = shardReports[i];
    const label = r.shard?.spec || r.runId || `#${i + 1}`;
    if (r.status === 'failed' || r.status === 'cancelled') {
      shardErrors.push(`Shard ${label} ended with status "${r.status}"${r.error ? `: ${r.error}` : ''}`);
    }
    const failedCells = r.matrixStats?.failedCells ?? 0;
    const abortedCells = r.matrixStats?.abortedCells ?? 0;
    if (failedCells > 0 || abortedCells > 0) {
      shardErrors.push(`Shard ${label} had ${failedCells} failed / ${abortedCells} aborted matrix cell(s)`);
    }
  }

  // Aggregate covered pages & matrix cell count across shards.
  const coveredSet = new Set();
  let maxMatrixCells = 0;
  let totalCompletedCells = 0;
  for (const r of shardReports) {
    for (const u of (r.coveredPages || [])) {
      if (u) coveredSet.add(u);
    }
    for (const p of (r.pages || [])) {
      const u = typeof p === 'string' ? p : p?.url;
      if (u) coveredSet.add(u);
    }
    maxMatrixCells = Math.max(maxMatrixCells, r.totalMatrixCells || r.matrixStats?.totalCells || 0);
    totalCompletedCells += r.matrixStats?.completedCells || 0;
  }
  const coveredPages = Array.from(coveredSet);

  // Separate raw non-coverage findings from coverage-failure findings, then
  // re-run site-wide rollup + cross-cell dedup + matrix classification so
  // merged output matches an unsharded run.
  const rawFindings = [];
  const rawCoverageFailures = [];
  for (const r of shardReports) {
    for (const f of (r.findings || [])) {
      if (!f || typeof f !== 'object') continue;
      if (isCoverageFailure(f)) {
        rawCoverageFailures.push({ ...f });
      } else if (f.ruleId === 'page-unresponsive') {
        // Re-computed uniformly below across the unified pageFailureMap + coveredPages.
        continue;
      } else {
        rawFindings.push({ ...f });
      }
    }
  }

  const rolledSecurity = rollupAcrossPages(rawFindings, isSiteWideHeaderFinding);
  const rolledAll = rollupAcrossPages(rolledSecurity, isDocumentScopedAxeFinding);
  let mergedFindings = dedupFindings(rolledAll);

  mergedFindings = pageScopeAgreement({
    findings: mergedFindings,
    coveredPages,
  }).findings;

  const effectiveCellCount = Math.max(maxMatrixCells, totalCompletedCells, 1);
  crossCellAgreement(mergedFindings, effectiveCellCount);

  // Reconcile coverage failures per unique failing page URL so the same failed
  // page isn't counted multiple times across shards.
  const pageFailureMap = new Map();
  const otherCovFailures = [];
  for (const cf of rawCoverageFailures) {
    if (cf.ruleId === 'page-load-failure' && cf.pageUrl) {
      const norm = canonicalizeUrl(cf.pageUrl);
      if (!pageFailureMap.has(norm)) {
        pageFailureMap.set(norm, {
          ...cf,
          blockedSet: new Set(cf.blockedExecutors || []),
        });
      } else {
        const cur = pageFailureMap.get(norm);
        for (const ex of (cf.blockedExecutors || [])) cur.blockedSet.add(ex);
      }
    } else {
      otherCovFailures.push(cf);
    }
  }

  const dedupedCovFailures = [
    ...Array.from(pageFailureMap.values()).map(({ blockedSet, ...cf }) => ({
      ...cf,
      occurrences: 1,
      blockedExecutors: Array.from(blockedSet),
    })),
    ...dedupFindings(otherCovFailures),
  ];

  mergedFindings.push(...dedupedCovFailures);

  if (pageFailureMap.size > 0 && coveredPages.length > 0) {
    const createFinding = createFindingFactory();
    const pageFailures = Array.from(pageFailureMap.values()).map((cf) => ({
      url: cf.pageUrl,
      error: cf.evidence || cf.description || 'Page failed to load',
      blockedExecutors: cf.blockedSet,
    }));
    const { promoted } = promotePageLoadFailures({
      pageFailures,
      coveredPages,
      createFinding,
      options: { pageScopePromotion: true },
    });
    mergedFindings.push(...promoted);
  }

  const failedPageCount = pageFailureMap.size;
  const pagesAttempted = coveredPages.length;
  const pagesScanned = pagesAttempted > 0 ? Math.max(0, pagesAttempted - failedPageCount) : 0;
  const coverageRatio = pagesAttempted > 0 ? pagesScanned / pagesAttempted : 1.0;
  const coverage = pagesAttempted > 0 ? { pagesAttempted, pagesScanned, coverageRatio } : null;

  const scoreOpts = coverage || {};
  const score = calculateScore(mergedFindings, scoreOpts);
  const summary = summarizeFindings(mergedFindings, Math.max(pagesAttempted, effectiveCellCount), scoreOpts);
  const allPages = dedupPageObjects(shardReports.flatMap((r) => r.pages || []));

  const first = shardReports[0];
  return {
    runId: `merged_${Date.now()}`,
    url: first.url || null,
    status: shardErrors.length > 0 ? 'failed' : 'completed',
    ...(shardErrors.length > 0 ? { error: shardErrors.join('; ') } : {}),
    score,
    summary,
    coverage: coverage || { pagesAttempted: allPages.length, pagesScanned: allPages.length },
    coveredPages,
    pages: allPages,
    findings: mergedFindings,
    coverageFailures: dedupedCovFailures,
    matrixStats: {
      totalCells: effectiveCellCount,
      completedCells: totalCompletedCells,
      failedCells: shardReports.reduce((s, r) => s + (r.matrixStats?.failedCells ?? 0), 0),
      abortedCells: shardReports.reduce((s, r) => s + (r.matrixStats?.abortedCells ?? 0), 0),
    },
    mergedFrom: shardReports.map((r, i) => ({
      runId: r.runId || null,
      shard: r.shard || null,
      index: r.shard?.index ?? (i + 1),
      status: r.status || 'completed',
      findingsCount: r.findings?.length ?? 0,
    })),
    timestamp: new Date().toISOString(),
  };
}
