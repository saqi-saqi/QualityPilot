/**
 * matrix/matrixRunner.js — run executors across the execution matrix.
 *
 * For each MatrixCell:
 *   1. Get a BrowserContext from BrowserPool (browser, viewport, role)
 *   2. Build a per-cell executor context with the right plan slice
 *   3. Run each executor in cell.executors via runExecutor()
 *   4. Tag findings with cell metadata (browser, viewport, role)
 *   5. Aggregate + dedup findings across cells
 *
 * Dedup strategy: findings with the same ruleId + pageUrl are merged —
 * occurrences + affectedPages are unioned; severity kept at the worst.
 *
 * Concurrency: `runMatrix()` runs cells sequentially by default. Pass
 * `options.concurrency` (e.g. 2 or 4) to run multiple cells in parallel via
 * `runMatrixConcurrently()`. Browser-bound cells are gated by the
 * BrowserPool's internal limit (one context per browser at a time by default).
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { runExecutor, hasExecutor } from '../services/executorRegistry.js';
import { canonicalizeUrl } from '../utils/classify.js';
import {
  pageScopeAgreement,
  promotePageLoadFailures,
  crossCellAgreement,
  retryReconcile,
  isRetriableFinding,
} from './matrixClassifier.js';

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

function worstSeverity(a, b) {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/**
 * Sanitize a matrix cell id for use as a filesystem path component. Cell ids
 * are '<browser>:<viewport>:<role>' — ':' is illegal in NTFS directory names
 * (Windows parses it as an alternate data stream), so every browser cell
 * failed with ENOENT on Windows before this (2026-11-16 Juice Shop recall
 * run: mkdir 'chromium:desktop:anon' can never succeed there).
 * services/evidenceBundle.js must sanitize the SAME way when reading back.
 */
export function cellDirName(cellId) {
  return String(cellId).replace(/:/g, '-');
}

/**
 * Short content hash — used when a finding has no selector/target so that
 * identical text findings still dedup across cells (instead of every
 * '' signature collapsing unrelated findings into one).
 */
function shortHash(text) {
  return createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
}

/**
 * Build a per-cell executor context.
 * The plan is sliced so each executor sees only the rows it needs.
 * (Executors that don't care about viewport/role see the same plan.)
 */
function buildCellContext(cell, baseCtx) {
  const baseFailures = baseCtx.pageFailures || (baseCtx.pageFailures = new Map());

  const cellCtx = {
    ...baseCtx,
    plan: baseCtx.plan,  // executors read plan.* arrays themselves
    options: { ...baseCtx.options },
    // Cell-specific metadata — executors can read this for tagging
    matrixCell: {
      browser: cell.browser,
      viewport: cell.viewport,
      role: cell.role,
      cellId: cell.id,
    },
    isPageFailed: (url) => {
      const norm = canonicalizeUrl(url || '');
      return baseFailures.has(norm);
    },
    recordPageFailure: ({ url, error, executor }) => {
      const norm = canonicalizeUrl(url || '');
      if (!baseFailures.has(norm)) {
        baseFailures.set(norm, {
          url,
          error: error || 'Page load failure',
          blockedExecutors: new Set(executor ? [executor] : []),
        });
      } else {
        if (executor) baseFailures.get(norm).blockedExecutors.add(executor);
      }
    },
  };

  // Provide a wrapped createFinding that tags findings with cell metadata
  const innerCreateFinding = baseCtx.createFinding;
  cellCtx.createFinding = (opts) => {
    const finding = innerCreateFinding(opts);
    finding.matrixCell = cellCtx.matrixCell;
    // Add cell info to affectedPages if not already there
    const cellTag = `[${cell.browser || 'no-browser'}|${cell.viewport?.name || 'n/a'}|${cell.role}]`;
    if (finding.pageUrl && !finding.pageUrl.includes(cellTag)) {
      // We don't modify pageUrl — that should stay clean. Add as separate field.
      finding.context = cellTag;
    }
    return finding;
  };

  return cellCtx;
}

/**
 * Run a single matrix cell — execute each of cell.executors in turn.
 * Returns { findings, stats }.
 */
async function runCell(cell, baseCtx) {
  let context = null;
  let cellCtx = null;
  let evidence = null;
  const cellFindings = [];
  const cellStats = { cellId: cell.id, status: 'ok', executors: [] };

  try {
    if (cell.needsBrowser && baseCtx.browserPool) {
      // Phase 4 evidence capture: trace + video on browser cells. Both are
      // KEPT only when the cell produced failures, discarded otherwise
      // (bounded storage).
      evidence = baseCtx.evidenceDir
        ? { videoDir: path.join(baseCtx.evidenceDir, cellDirName(cell.id), 'video'), tracing: true }
        : null;
      // Playwright's recordVideo.dir must already exist — it does not create
      // the directory itself.
      if (evidence) fs.mkdirSync(evidence.videoDir, { recursive: true });
      context = await baseCtx.browserPool.createContext({
        browserName: cell.browser,
        viewport: cell.viewport,
        role: cell.role,
        evidence,
      });
    }

    cellCtx = buildCellContext(cell, baseCtx);
    if (context) cellCtx.context = context;
    if (evidence) cellCtx.evidence = evidence;

    for (const executorName of cell.executors) {
      if (baseCtx.signal?.aborted) {
        cellStats.executors.push({ name: executorName, status: 'aborted' });
        cellStats.status = 'aborted';
        break;
      }
      if (!hasExecutor(executorName)) {
        cellStats.executors.push({ name: executorName, status: 'missing' });
        cellStats.status = 'error';
        continue;
      }

      const start = Date.now();
      try {
        const result = await runExecutor(executorName, cellCtx);
        cellFindings.push(...(result.findings || []));
        cellStats.executors.push({
          name: executorName,
          status: 'ok',
          durationMs: Date.now() - start,
          findingCount: (result.findings || []).length,
        });
      } catch (err) {
        cellStats.executors.push({
          name: executorName,
          status: 'error',
          error: err.message,
          durationMs: Date.now() - start,
        });
        cellStats.status = 'error';
      }
    }
  } finally {
    if (context && baseCtx.browserPool) {
      // Phase 4: stop tracing BEFORE the context closes — saved to a file
      // only when the cell produced failures (or a screenshot), discarded
      // otherwise. Videos finalize on context close; kept for failing
      // cells, deleted for clean ones (bounded storage).
      const cellHasFailures = cellFindings.some(
        (f) => f.ruleId === 'e2e-flow-failure' || f.ruleId === 'e2e-flow-selector-timeout' || f.screenshot,
      );
      if (cellCtx?.evidence?.tracing) {
        if (cellHasFailures) {
          const tracePath = path.join(baseCtx.evidenceDir, cellDirName(cell.id), 'trace.zip');
          fs.mkdirSync(path.dirname(tracePath), { recursive: true });
          await context.tracing.stop({ path: tracePath }).catch(() => {});
          for (const f of cellFindings) {
            if (String(f.ruleId || '').startsWith('e2e-')) {
              f.evidenceRef = { cellId: cell.id, hasTrace: true, hasVideo: true };
            }
          }
        } else {
          await context.tracing.stop().catch(() => {}); // discard
        }
      }
      await baseCtx.browserPool.releaseContext(context);
      if (cellCtx?.evidence?.videoDir && !cellHasFailures) {
        fs.rmSync(cellCtx.evidence.videoDir, { recursive: true, force: true });
      }
    }
  }

  return { findings: cellFindings, stats: cellStats };
}

/**
 * Extract a stable selector or affected node signature from a finding.
 *
 * Findings with no selector/target at all fall back to a hash of the title +
 * first 120 chars of evidence — so two genuinely identical text findings
 * merge, while two different ones never collide under the old shared ''
 * signature.
 */
export function getNodeSignature(finding) {
  if (finding.selector) return String(finding.selector).trim();
  if (finding.target) return Array.isArray(finding.target) ? finding.target.join(' ') : String(finding.target).trim();
  if (finding.evidence) {
    const targets = [];
    const matches = String(finding.evidence).matchAll(/Target:\s*([^\n]+)/g);
    for (const match of matches) {
      targets.push(match[1].trim());
    }
    if (targets.length > 0) return targets.sort().join('; ');
  }
  // Fallback signature: title + first 120 chars of evidence (hashed).
  const basis = `${finding.title || ''}|${String(finding.evidence || '').slice(0, 120)}`;
  return shortHash(basis);
}

/**
 * Dedup findings across cells. Same ruleId + affected node signature + pageUrl → merge into one finding.
 * - occurrences: sum across cells
 * - affectedPages: union
 * - severity: worst
 * - matrixCells: list of cell IDs where observed
 */
export function dedupFindings(findings) {
  const merged = new Map();

  for (const finding of findings) {
    const ruleId = finding.ruleId || 'gen';
    const selector = getNodeSignature(finding);
    const rawUrl = finding.pageUrl || finding.url || '';
    const normUrl = canonicalizeUrl(rawUrl);
    const key = `${ruleId}::${selector}::${normUrl}`;

    if (!merged.has(key)) {
      // Seed the first finding's affectedPages with its own pageUrl — a
      // finding always affected at least the page it was found on, even when
      // the executor forgot to pass affectedPages (or passed an empty array).
      merged.set(key, {
        ...finding,
        occurrences: finding.occurrences || 1,
        affectedPages: new Set([...(finding.affectedPages || []), ...(rawUrl ? [rawUrl] : [])]),
        matrixCells: new Set(finding.matrixCell?.cellId ? [finding.matrixCell.cellId] : []),
      });
    } else {
      const existing = merged.get(key);
      existing.occurrences += (finding.occurrences || 1);
      for (const p of (finding.affectedPages || [])) existing.affectedPages.add(p);
      if (rawUrl) existing.affectedPages.add(rawUrl);
      if (finding.matrixCell?.cellId) existing.matrixCells.add(finding.matrixCell.cellId);
      existing.severity = worstSeverity(existing.severity, finding.severity);
      // Don't lose non-empty evidence/description/selector
      if (!existing.description && finding.description) existing.description = finding.description;
      if (!existing.evidence && finding.evidence) existing.evidence = finding.evidence;
      if (!existing.selector && finding.selector) existing.selector = finding.selector;
    }
  }

  // Convert Sets to arrays for serialization
  return Array.from(merged.values()).map(f => ({
    ...f,
    affectedPages: Array.from(f.affectedPages),
    matrixCells: Array.from(f.matrixCells),
  }));
}

/**
 * Run a cell; when it produced retriable application findings (BUILD_PLAN
 * step 4), re-run the cell once and reconcile: findings that did not
 * reproduce are demoted to suspected + flaky; reproduced ones are confirmed
 * and marked `retriedConfirmed` (exempt from cross-cell demotion).
 * Environmental findings are never retried (retrying a dead network proves
 * nothing). Disabled with options.retryBeforeConfirm === false.
 */
async function runCellWithOptionalRetry(cell, baseCtx, options, onEvent) {
  const run1 = await runCell(cell, baseCtx);
  if (options.retryBeforeConfirm === false) return run1;
  const hasRetriable = run1.findings.some(isRetriableFinding);
  if (!hasRetriable || baseCtx.signal?.aborted) return run1;
  onEvent?.(`Retry (step 4): re-running cell ${cell.id} once to confirm application findings`);
  let run2 = null;
  try {
    run2 = await runCell(cell, baseCtx);
  } catch {
    return run1; // retry run failed — keep run-1 findings as-is
  }
  retryReconcile(run1.findings, run2.findings, options);
  const stats = { ...(run2.stats || run1.stats), retried: true };
  return { findings: [...run1.findings, ...run2.findings], stats };
}

/**
 * Main matrix runner entry.
 *
 * @param {object} input
 * @param {object} input.plan       — approved TestPlan
 * @param {Array}  [input.cells]    — pre-computed matrix (else computed from plan)
 * @param {object} input.browserPool — BrowserPool instance (or null for no-browser tests)
 * @param {object} input.createFinding — finding factory
 * @param {object} input.onEvent   — SSE progress
 * @param {object} [input.signal]  — AbortSignal
 * @param {object} [input.options] — { concurrency, dedup, screenshotsDir, runId, roles,
 *                                   coveredPages, pageScopeAgreement, pageScopePromotion,
 *                                   crossCellAgreement, retryBeforeConfirm }
 * @returns {Promise<{ findings, stats }>}
 *
 * Concurrency:
 *   • options.concurrency = 1 (default): run cells sequentially via runCell()
 *   • options.concurrency > 1: run cells in parallel via runMatrixConcurrently()
 */
export async function runMatrix({
  plan,
  cells,
  browserPool,
  createFinding,
  onEvent,
  signal,
  options = {},
}) {
  const { dedup = true, concurrency = 1 } = options;

  if (!cells) {
    const { planMatrix } = await import('./matrixPlanner.js');
    cells = planMatrix(plan, Array.isArray(options.roles) && options.roles.length ? options.roles : null);
  }

  onEvent?.(`Running matrix of ${cells.length} cells (concurrency=${concurrency})`);

  const baseCtx = {
    plan,
    browserPool,
    createFinding,
    onEvent,
    signal,
    options: { ...options },
    screenshotsDir: options.screenshotsDir || '/tmp/screenshots',
    evidenceDir: options.evidenceDir || '',
    runId: options.runId || `run_${Date.now()}`,
  };

  const matrixStart = Date.now();
  let allFindings = [];
  const allStats = {
    totalCells: cells.length,
    completedCells: 0,
    failedCells: 0,
    abortedCells: 0,
    cells: [],
    totalDurationMs: 0,
    concurrency,
  };

  if (concurrency > 1) {
    const result = await runMatrixConcurrently(cells, baseCtx, concurrency, signal, onEvent, options);
    allFindings = result.findings;
    allStats.cells = result.cellStats;
    // A cell "succeeded" if it ran without throwing (even if some inner executors errored).
    // A cell "failed" if runCell itself threw (rare — usually executor errors are caught inside).
    allStats.completedCells = result.cellStats.filter(c => c.status === 'ok').length;
    allStats.failedCells = result.cellStats.filter(c => c.status === 'error').length;
    allStats.abortedCells = result.cellStats.filter(c => c.status === 'aborted').length;
  } else {
    for (const cell of cells) {
      if (signal?.aborted) {
        allStats.cells.push({ cellId: cell.id, status: 'aborted' });
        break;
      }
      onEvent?.(`Matrix cell: ${cell.id}`);
      try {
        const { findings, stats } = await runCellWithOptionalRetry(cell, baseCtx, options, onEvent);
        allFindings.push(...findings);
        if (stats.status === 'ok') allStats.completedCells++;
        else if (stats.status === 'error') allStats.failedCells++;
        else if (stats.status === 'aborted') allStats.abortedCells = (allStats.abortedCells || 0) + 1;
        allStats.cells.push(stats);
      } catch (err) {
        allStats.failedCells++;
        allStats.cells.push({ cellId: cell.id, status: 'error', error: err.message });
      }

    }
  }

  allStats.totalDurationMs = Date.now() - matrixStart;

  // Dedup across cells
  let finalFindings = dedup ? dedupFindings(allFindings) : allFindings;

  // ─── Phase D: matrix-level classification (BUILD_PLAN steps 2–4) ────
  // Step 2 — page-scope agreement over environmental findings: an isolated
  // timeout amid healthy covered pages is promoted to a suspected bug;
  // failures spanning every covered page stay environmental. No-op unless
  // the caller provided coveredPages.
  finalFindings = pageScopeAgreement({
    findings: finalFindings,
    coveredPages: options.coveredPages || [],
    options,
  }).findings;
  // Step 3 — cross-cell agreement: confirmed-but-single-cell nondeterministic
  // findings demoted as flaky candidates (G1). Deterministic executors and
  // retry-confirmed findings are exempt.
  crossCellAgreement(finalFindings, cells.length, options);

  // Build unified coverage failure findings if any page load failures occurred
  const coverageFailures = [];
  const incompleteCells = allStats.cells.filter(cell => cell.status === 'error');
  for (const cell of incompleteCells) {
    const failedExecutors = (cell.executors || [])
      .filter(executor => executor.status === 'error' || executor.status === 'missing')
      .map(executor => `${executor.name} (${executor.status})`);
    coverageFailures.push(createFinding({
      title: `Matrix cell failed: ${cell.cellId}`,
      severity: 'info',
      confidence: 'high',
      category: 'Scan Coverage',
      findingType: 'coverage-failure',
      origin: 'first-party',
      ruleId: 'matrix-cell-failure',
      description: `The matrix cell did not complete successfully. Failed executors: ${failedExecutors.join(', ') || 'unknown'}.`,
      evidence: JSON.stringify(cell),
      occurrences: 1,
      affectedPages: [],
      blockedExecutors: failedExecutors,
    }));
  }
  if (baseCtx.pageFailures?.size > 0) {
    for (const failure of baseCtx.pageFailures.values()) {
      const blocked = Array.from(failure.blockedExecutors);
      const covFinding = createFinding({
        title: `Page load failed: ${failure.url}`,
        severity: 'info',
        confidence: 'high',
        category: 'Scan Coverage',
        findingType: 'coverage-failure',
        origin: 'first-party',
        ruleId: 'page-load-failure',
        pageUrl: failure.url,
        description: `Page failed to load (${(failure.error || '').split('\n')[0]}). The following executors could not run: ${blocked.join(', ')}`,
        evidence: failure.error || '',
        occurrences: 1,
        affectedPages: [failure.url],
        blockedExecutors: blocked,
      });
      coverageFailures.push(covFinding);
    }
  }

  // Include coverage failure records in findings
  finalFindings.push(...coverageFailures);

  // Step 2 (coverage variant): isolated page-LOAD failures promoted to
  // suspected bug findings. Opt-in via the caller (runManager enables it);
  // direct runMatrix callers keep the classic coverage-only behavior, so
  // golden fixture ground truth is unchanged.
  if (baseCtx.pageFailures?.size > 0) {
    const { promoted } = promotePageLoadFailures({
      pageFailures: Array.from(baseCtx.pageFailures.values()),
      coveredPages: options.coveredPages || [],
      createFinding,
      options,
    });
    finalFindings.push(...promoted);
  }

  onEvent?.(`Matrix complete: ${finalFindings.length} findings across ${allStats.completedCells} cells`);

  return { findings: finalFindings, coverageFailures, stats: allStats };
}

/**
 * Run matrix cells with limited parallelism.
 *
 * Uses a worker-pool pattern: pull cells off the queue, dispatch up to
 * `concurrency` cells in parallel, refill as workers complete.
 *
 * Browser-bound cells naturally serialize per browser via BrowserPool
 * (one context per browser at a time), but no-browser cells can fully
 * parallelize. Recommended concurrency: 2-4 for browser-heavy matrices,
 * higher for no-browser-heavy matrices.
 */
async function runMatrixConcurrently(cells, baseCtx, concurrency, signal, onEvent, options = {}) {
  const queue = [...cells];
  const workers = [];
  const allFindings = [];
  const cellStats = [];

  async function worker(workerId) {
    while (queue.length > 0) {
      if (signal?.aborted) break;

      const cell = queue.shift();
      if (!cell) break;

      onEvent?.(`[worker ${workerId}] Cell: ${cell.id}`);

      try {
        const { findings, stats } = await runCellWithOptionalRetry(cell, baseCtx, options, onEvent);
        allFindings.push(...findings);
        cellStats.push(stats);
      } catch (err) {
        cellStats.push({ cellId: cell.id, status: 'error', error: err.message });
      }
    }
  }

  // Spawn N workers
  for (let i = 0; i < concurrency; i++) {
    workers.push(worker(i + 1));
  }

  await Promise.all(workers);

  while (queue.length > 0) {
    const cell = queue.shift();
    cellStats.push({ cellId: cell.id, status: 'aborted', executors: [] });
  }

  return { findings: allFindings, cellStats };
}
