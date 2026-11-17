import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from '../utils/config.js';
import { info, error as logError, warn } from '../utils/logger.js';
import * as ssrf from './ssrf.js';
import { crawlSite, closeCrawlSession, resolvePinRulesSafe } from './crawler.js';
import { createFindingFactory } from './findingFactory.js';
import { calculateScore, summarizeFindings } from './scoring.js';
import { dedupFindings } from '../matrix/matrixRunner.js';
import { composeEndpointUrl, validateTestPlan } from './testPlan.js';
import { checkLinks } from './checks/links.js';
import { checkConsole } from './checks/console.js';
import { checkNetwork } from './checks/network.js';
import { checkAccessibility } from './checks/accessibility.js';
import { checkSeo } from './checks/seo.js';
import { checkPerformance } from './checks/performance.js';
import { checkWorkflows } from './checks/workflows.js';
import {
  saveRun as dbSaveRun,
  getRun as dbGetRun,
  listRuns as dbListRuns,
  deleteRun as dbDeleteRun,
  cleanupOldRuns as dbCleanupOldRuns,
  savePlan as dbSavePlan
} from '../storage/runStore.js';
import { closeDatabase } from '../storage/db.js';
import * as planDraftStore from '../storage/planDraftStore.js';
import { JobQueue } from '../storage/jobQueue.js';

const runs = new Map();
const sseClients = new Map();
const activeAbortControllers = new Map();
// Per-run emergency cleanup (close the run's browser/pool) used by the hard
// timeout when the normal execution path is hung and its finally never runs.
const activeCleanups = new Map();
let activeRuns = 0;
const jobQueue = new JobQueue();

const MAX_CONCURRENT_RUNS = Math.max(1, config.maxConcurrentRuns || 2);
const DATA_DIR = path.resolve(config.dataDir || path.join(process.cwd(), 'data'));
const SCREENSHOTS_DIR = path.join(DATA_DIR, 'screenshots');

/** Evidence artifacts for a run (traces, videos) — Phase 4 evidence bundles. */
export function evidenceDirFor(runId) {
  return path.join(DATA_DIR, 'evidence', runId);
}

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];
const MAX_TERMINAL_RUNS_KEPT = 50;   // in-memory LRU cap; SQLite stays durable
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;  // every 6 hours
const SHUTDOWN_DRAIN_TIMEOUT_MS = 10000;

// Schemes that must never reach a browser or HTTP client, wherever they
// appear in a plan (defense-in-depth on top of ssrf.validateUrl).
const BLOCKED_URL_SCHEMES = /^(file|data|ftp):/i;

function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

export async function ensureDataDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
}

export function emitEvent(runId, message) {
  const clients = sseClients.get(runId);
  const timestamp = new Date().toISOString();
  if (clients) {
    const data = JSON.stringify({ type: 'progress', message, timestamp });
    for (const res of clients) {
      res.write(`data: ${data}\n\n`);
    }
  }
  const run = runs.get(runId);
  if (run) {
    if (!run.events) run.events = [];
    run.events.push({ message, timestamp });
  }
}

/**
 * Emit the terminal SSE marker exactly once per run. Every terminal path
 * (completed, failed, cancelled, hard timeout) MUST emit __DONE__ so
 * SSE subscribers are never left hanging.
 */
function emitDone(runId) {
  const run = runs.get(runId);
  if (run) {
    if (run.doneEmitted) return;
    run.doneEmitted = true;
  }
  emitEvent(runId, '__DONE__');
}

export function addSSEClient(runId, res) {
  if (!sseClients.has(runId)) {
    sseClients.set(runId, new Set());
  }
  sseClients.get(runId).add(res);

  res.on('close', () => {
    removeSSEClient(runId, res);
  });
}

export function removeSSEClient(runId, res) {
  const clients = sseClients.get(runId);
  if (clients) {
    clients.delete(res);
    if (clients.size === 0) {
      sseClients.delete(runId);
    }
  }
}

// ─── URL / plan validation ───────────────────────────────────────────

/**
 * Reject non-http(s) schemes (file:, data:, ftp:, …) with a clear error.
 */
function assertUrlSchemeAllowed(rawUrl, label) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${label} is not a valid URL: ${rawUrl}`);
  }
  if (BLOCKED_URL_SCHEMES.test(parsed.protocol)) {
    throw new Error(`${label} uses a blocked scheme (${parsed.protocol.replace(':', '')}:) — only http(s) targets are allowed`);
  }
}

/**
 * Collect every URL a plan will make the agent visit or call and validate it
 * through ssrf.validateUrl() BEFORE any browser launches. Runs are aborted
 * with a clear error when anything fails. Blocks file:/data:/ftp: schemes
 * everywhere, closing the plan-level SSRF bypass.
 */
export async function validatePlanUrls(plan, targetUrl) {
  if (!plan) return;
  const entries = [];

  for (const flow of plan.flows || []) {
    entries.push([flow.startUrl, `flow "${flow.name}" startUrl`]);
    for (const step of flow.steps || []) {
      if (step.action === 'navigate' && step.value) {
        entries.push([step.value, `flow "${flow.name}" navigate target`]);
      }
      if (step.action === 'api-request' && step.url) {
        entries.push([step.url, `flow "${flow.name}" api-request URL`]);
      }
    }
  }
  for (const page of plan.pages || []) {
    entries.push([page.url, 'page assertion URL']);
  }
  for (const baseline of plan.visualBaselines || []) {
    entries.push([baseline.pageUrl, 'visual baseline URL']);
  }
  for (const target of plan.fuzzTargets || []) {
    if (target.pageUrl) entries.push([target.pageUrl, 'fuzz target URL']);
  }
  for (const endpoint of plan.apiEndpoints || []) {
    let composed;
    try {
      composed = composeEndpointUrl(endpoint, targetUrl);
    } catch {
      throw new Error(`ApiEndpoint ${endpoint.method} ${endpoint.path} could not be composed into a valid URL`);
    }
    entries.push([composed, `api endpoint ${endpoint.method} ${endpoint.path}`]);
  }

  for (const [rawUrl, label] of entries) {
    if (!rawUrl) continue;
    assertUrlSchemeAllowed(rawUrl, label);
    try {
      await ssrf.validateUrl(rawUrl);
    } catch (err) {
      throw new Error(`Plan URL failed SSRF validation (${label} → ${rawUrl}): ${err.message}`);
    }
  }
}

/** Validate legacy workflow URLs (startUrl + navigate values). */
async function validateWorkflowUrls(workflows = []) {
  for (const workflow of workflows) {
    assertUrlSchemeAllowed(workflow.startUrl, `workflow "${workflow.name}" startUrl`);
    try {
      await ssrf.validateUrl(workflow.startUrl);
    } catch (err) {
      throw new Error(`Workflow URL failed SSRF validation (${workflow.name}): ${err.message}`);
    }
    for (const step of workflow.steps || []) {
      if (step.action === 'navigate' && step.value) {
        assertUrlSchemeAllowed(step.value, `workflow "${workflow.name}" navigate target`);
        try {
          await ssrf.validateUrl(step.value);
        } catch (err) {
          throw new Error(`Workflow navigate URL failed SSRF validation (${workflow.name}): ${err.message}`);
        }
      }
    }
  }
}

export async function createRun(url, options) {
  if (!acceptingRuns()) throw new Error('Server is shutting down — not accepting new runs');
  const runId = `run_${Date.now()}_${randomUUID().slice(0, 8)}`;

  await ssrf.validateUrl(url);
  if (options.webhookUrl) {
    await ssrf.validateUrl(options.webhookUrl);
  }
  for (const workflow of options.workflows || []) {
    await ssrf.validateUrl(workflow.startUrl);
  }

  const maxPages = Math.min(Math.max(options.maxPages || 1, 1), config.maxPagesHardLimit || 100);
  const maxDepth = options.maxDepth || 2;
  const checks = options.checks || [];
  const workflows = options.workflows || [];

  const run = {
    runId,
    url,
    status: 'queued',
    startedAt: new Date().toISOString(),
    options: {
      maxPages,
      maxDepth,
      checks,
      workflows
    },
    events: [],
    findings: [],
    workflowResults: [],
    pages: [],
    score: null,
    summary: null
  };

  runs.set(runId, run);
  await saveRun(run);

  jobQueue.enqueue({
    runId,
    payload: { mode: 'legacy', runId, url, options: run.options },
  });

  processQueue();
  return runId;
}

export async function saveRun(run) {
  try {
    dbSaveRun(run);
    runs.set(run.runId, run);
    evictTerminalRuns();
  } catch (err) {
    logError(`Failed to save run ${run.runId}`, err);
  }
}

/**
 * Keep at most the last MAX_TERMINAL_RUNS_KEPT terminal runs in the
 * in-memory Map (LRU by completion time). SQLite remains the durable store;
 * getRun() transparently falls back to it for evicted runs.
 */
function evictTerminalRuns() {
  const terminal = [];
  for (const [id, run] of runs) {
    if (isTerminal(run.status) && run.completedAt) {
      terminal.push({ id, completedAt: run.completedAt });
    }
  }
  if (terminal.length <= MAX_TERMINAL_RUNS_KEPT) return;

  terminal.sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt)));
  const toEvict = terminal.slice(0, terminal.length - MAX_TERMINAL_RUNS_KEPT);
  for (const { id } of toEvict) {
    runs.delete(id);
  }
}

export async function getRun(runId) {
  if (runs.has(runId)) {
    return runs.get(runId);
  }
  try {
    const run = dbGetRun(runId);
    if (run) {
      runs.set(runId, run);
      return run;
    }
    return null;
  } catch (err) {
    logError(`Failed to get run ${runId}`, err);
    return null;
  }
}

export async function listRuns(opts = {}) {
  try {
    return dbListRuns(opts);
  } catch (err) {
    logError('Failed to list runs', err);
    return [];
  }
}

export async function cancelRun(runId) {
  const run = runs.get(runId) || await getRun(runId);
  if (!run) return { ok: false, reason: 'not-found' };
  if (isTerminal(run.status)) {
    return { ok: false, reason: 'not-active', status: run.status };
  }

  const controller = activeAbortControllers.get(runId);
  if (controller) controller.abort();
  jobQueue.cancel(runId);

  run.status = 'cancelled';
  run.completedAt = new Date().toISOString();
  run.error = 'Cancelled by user';
  emitEvent(runId, 'Run cancelled by user');
  emitDone(runId);
  await saveRun(run);

  return { ok: true, status: 'cancelled' };
}

/**
 * Hard run timeout: race the execution promise against a timer. When the
 * timer wins (the normal cooperative abort wasn't enough — the body is
 * hung), the run is marked failed, its browser/pool is force-closed via the
 * tracked cleanup, and __DONE__ is emitted so SSE clients are released.
 */
async function raceWithHardTimeout(runId, run, abortController, execPromise) {
  const maxRunTimeMs = config.maxRunTimeMs || 300000;
  let timer;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), maxRunTimeMs);
  });

  const outcome = await Promise.race([
    execPromise.then(() => 'settled', () => 'settled'),
    timeoutPromise,
  ]);
  clearTimeout(timer);

  if (outcome !== 'timeout') return;

  // Mark failed FIRST (single-threaded — the inner body can't race us before
  // the terminal guard is set), then abort + force-close the browsers.
  if (!isTerminal(run.status)) {
    run.status = 'failed';
    run.completedAt = new Date().toISOString();
    run.error = `Run exceeded maximum execution time (${Math.round(maxRunTimeMs / 1000)}s)`;
    emitEvent(runId, `Run failed: ${run.error}`);
    emitDone(runId);
    await saveRun(run);
  }

  abortController.abort();
  const cleanup = activeCleanups.get(runId);
  if (cleanup) {
    try {
      await cleanup();
    } catch (err) {
      warn(`Hard-timeout cleanup failed for ${runId}: ${err.message}`);
    }
  }
}

export async function executeRun(runId) {
  const run = runs.get(runId) || await getRun(runId);
  if (!run) return;

  run.status = 'running';
  await saveRun(run);
  emitEvent(runId, 'Starting QA run');

  const abortController = new AbortController();
  activeAbortControllers.set(runId, abortController);

  let browser = null;
  let crawlEgressProxy = null;

  const exec = (async () => {
    try {
      emitEvent(runId, 'Validating URL');
      await ssrf.validateUrl(run.url);
      await validateWorkflowUrls(run.options.workflows || []);
      const pinRules = await resolvePinRulesSafe(run.url);

      const createFinding = createFindingFactory();

      emitEvent(runId, 'Crawling site');
      const crawlResult = await crawlSite({
        url: run.url,
        options: {
          maxPages: run.options.maxPages,
          maxDepth: run.options.maxDepth,
          ...(pinRules ? { hostResolverRules: pinRules } : {}),
        },
        onEvent: (msg) => emitEvent(runId, msg),
        signal: abortController.signal
      });

      const { pages, siteOrigin, context } = crawlResult;
      browser = crawlResult.browser;
      crawlEgressProxy = crawlResult.egressProxy;
      // Register the emergency cleanup for the hard timeout path
      activeCleanups.set(runId, () => closeCrawlSession(browser, crawlResult.egressProxy));

      if (!pages || pages.length === 0) {
        const rootError = crawlResult.errors?.[0]?.error || 'Target URL could not be crawled (no pages reached)';
        throw new Error(`Target page failed to load (${run.url}): ${rootError}`);
      }

      let findings = [];

      if (run.options.checks.length > 0) {
        emitEvent(runId, 'Running checks');

        const onEvent = (msg) => emitEvent(runId, msg);
        const signal = abortController.signal;

        for (const checkName of run.options.checks) {
          if (signal.aborted) {
            emitEvent(runId, 'Time limit reached, finalizing report...');
            break;
          }

          emitEvent(runId, `Running check: ${checkName}`);
          try {
            let checkFindings = [];
            switch (checkName) {
              case 'links':
                checkFindings = await checkLinks(pages, createFinding, onEvent, signal, siteOrigin);
                break;
              case 'console':
                checkFindings = await checkConsole(pages, createFinding, onEvent, siteOrigin);
                break;
              case 'network':
                checkFindings = await checkNetwork(pages, createFinding, onEvent, siteOrigin);
                break;
              case 'accessibility':
                checkFindings = await checkAccessibility(pages, createFinding, onEvent, SCREENSHOTS_DIR, runId, signal, context);
                break;
              case 'seo':
                checkFindings = await checkSeo(pages, createFinding, onEvent, SCREENSHOTS_DIR, runId, signal);
                break;
              case 'performance':
                checkFindings = await checkPerformance(pages, createFinding, onEvent, SCREENSHOTS_DIR, runId, signal);
                break;
            }
            findings = findings.concat(checkFindings || []);
            run.findings = findings;
            run.score = calculateScore(findings);
            await saveRun(run);
          } catch (err) {
            logError(`Check ${checkName} failed`, err);
            emitEvent(runId, `Check ${checkName} failed: ${err.message}`);
          }
        }
      }

      if (run.options.workflows?.length && !abortController.signal.aborted) {
        emitEvent(runId, 'Running workflow assertions');
        const workflowRun = await checkWorkflows(context, run.options.workflows, createFinding, (msg) => emitEvent(runId, msg), SCREENSHOTS_DIR, runId, abortController.signal);
        findings = findings.concat(workflowRun.findings);
        run.workflowResults = workflowRun.results;
      }

      // Dedup on the legacy path too — the matrix path has always merged
      // duplicate (ruleId, selector, pageUrl) findings; the legacy checks
      // deserve the same collapsing before scoring.
      findings = dedupFindings(findings);

      // Close all Playwright pages before saving
      for (const p of pages) {
        if (p.page) {
          await p.page.close().catch(() => {});
        }
      }

      run.findings = findings;
      run.score = calculateScore(findings);
      run.summary = summarizeFindings(findings, pages);

      // Invariant check in non-production / test mode
      if (process.env.NODE_ENV !== 'production' || process.env.SQA_STRICT === 'true') {
        try {
          const { validateReport } = await import('../reporting/invariants.js');
          validateReport(run, { throwOnError: process.env.NODE_ENV === 'test' || process.env.SQA_STRICT === 'true' });
        } catch (invErr) {
          logError(`Invariant validation failure in run ${runId}: ${invErr.message}`);
          if (process.env.NODE_ENV === 'test' || process.env.SQA_STRICT === 'true') throw invErr;
        }
      }

      // Strip Playwright page instances and raw capture data before persisting
      run.pages = pages.map(p => {
        const { page, consoleLogs, pageExceptions, networkFailures, networkErrors, ...rest } = p;
        return rest;
      });

      if (isTerminal(run.status)) {
        // A hard timeout / cancel already finalized this run — don't overwrite.
        return;
      }
      if (abortController.signal.aborted) {
        run.status = 'cancelled';
        run.completedAt ||= new Date().toISOString();
        emitDone(runId);
      } else {
        run.status = 'completed';
        run.completedAt = new Date().toISOString();
        emitEvent(runId, 'Completed');
        emitDone(runId);
      }

    } catch (err) {
      if (isTerminal(run.status)) {
        return; // hard timeout already finalized the run
      }
      if (abortController.signal.aborted) {
        run.status = 'cancelled';
        run.completedAt ||= new Date().toISOString();
        emitDone(runId);
      } else {
        logError(`Run ${runId} failed`, err);
        run.status = 'failed';
        run.completedAt = new Date().toISOString();
        run.error = err.message;
        emitEvent(runId, `Run failed: ${err.message}`);
        emitDone(runId);
      }
    } finally {
      activeCleanups.delete(runId);
      await closeCrawlSession(browser, crawlEgressProxy);
      await saveRun(run);
      // Flaky tracking — record every terminal run (single shared algorithm
      // analyzes the history; see matrix/flakyTracker.js).
      if (isTerminal(run.status)) {
        await recordFlakyRun(run);
      }
    }
  })();

  try {
    await raceWithHardTimeout(runId, run, abortController, exec);
  } catch (err) {
    logError(`Hard timeout supervision failed for ${runId}`, err);
  } finally {
    activeAbortControllers.delete(runId);
  }
}

export function processQueue() {
  if (_shuttingDown) return; // stop accepting new work during shutdown drain
  while (activeRuns < MAX_CONCURRENT_RUNS) {
    const job = jobQueue.acquireNextJob({ maxConcurrent: MAX_CONCURRENT_RUNS });
    if (!job) break;

    activeRuns++;
    const isMatrix = job.payload?.mode === 'matrix';
    const executeFn = isMatrix ? executeRunWithMatrix : executeRun;

    executeFn(job.runId, job.payload)
      .then(async () => {
        const run = runs.get(job.runId) || await getRun(job.runId);
        if (run?.status === 'cancelled') jobQueue.cancel(job.runId);
        else jobQueue.completeJob(job.runId);
      })
      .catch((err) => {
        logError(`Execution error in job ${job.runId}`, err);
        jobQueue.failJob(job.runId, err.message);
      })
      .finally(() => {
        activeRuns--;
        processQueue();
      });
  }
}

export async function cleanupOldRuns(maxAgeMs = config.cleanupMaxAgeMs || 24 * 60 * 60 * 1000) {
  try {
    dbCleanupOldRuns(maxAgeMs);
    if (existsSync(SCREENSHOTS_DIR)) {
      const now = Date.now();
      const files = await fs.readdir(SCREENSHOTS_DIR);
      for (const file of files) {
        const filePath = path.join(SCREENSHOTS_DIR, file);
        const stats = await fs.stat(filePath);
        if (now - stats.mtimeMs > maxAgeMs) {
          await fs.unlink(filePath).catch(() => {});
        }
      }
    }
  } catch (err) {
    logError('Cleanup failed', err);
  }
}

let _shuttingDown = false;

function acceptingRuns() {
  return !_shuttingDown;
}

/**
 * Graceful shutdown — idempotent + signal-safe. Order:
 *   1. stop accepting new runs + jobs
 *   2. abort all active runs (cooperative cancellation)
 *   3. wait (bounded) for active runs to drain
 *   4. close SSE clients
 *   5. flush in-memory runs to SQLite
 *   6. close the database
 */
export async function shutdown() {
  if (_shuttingDown) {
    // Signal handlers can fire twice (SIGINT during SIGTERM) — second call is a no-op.
    return;
  }
  _shuttingDown = true;
  info('Shutting down run manager...');

  // Abort active runs — each execution path finalizes (status terminal,
  // __DONE__, save) through its normal catch/finally.
  for (const controller of activeAbortControllers.values()) {
    try {
      controller.abort();
    } catch { /* already destroyed */ }
  }

  // Wait (bounded) for the queue to drain
  const deadline = Date.now() + SHUTDOWN_DRAIN_TIMEOUT_MS;
  while (activeRuns > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (activeRuns > 0) {
    warn(`Shutdown: ${activeRuns} run(s) still active after ${SHUTDOWN_DRAIN_TIMEOUT_MS}ms — continuing`);
  }

  for (const [, clients] of sseClients.entries()) {
    for (const client of clients) {
      try {
        client.end();
      } catch { /* client already gone */ }
    }
  }
  sseClients.clear();

  // Flush any in-memory run state (e.g. final saves racing shutdown)
  for (const run of runs.values()) {
    try {
      dbSaveRun(run);
    } catch (err) {
      logError(`Shutdown flush failed for run ${run.runId}`, err);
    }
  }

  try {
    closeDatabase();
  } catch (err) {
    logError('Failed to close database during shutdown', err);
  }

  info('Run manager shutdown complete');
}

// ─── Phase 3: Matrix execution path ───────────────────────────────────
//
// The legacy `createRun` + `executeRun` functions run the v1 check_* modules
// against crawled pages. Phase 3 adds an alternative path that:
//   1. Builds a TestPlan via the Explorer (LLM-driven)
//   2. Runs the plan through the matrix (browser × viewport × role)
//   3. Aggregates + dedups findings across cells
//
// Usage:
//   const runId = await createRunWithMatrix({ url, options: { maxPages: 5 } });
//   // SSE events stream as usual; run completes with matrix findings

/**
 * Draft a test plan WITHOUT executing it (human-in-the-loop gate).
 *
 * Crawls the target, infers a TestPlan via the explorer, persists it as a
 * draft via planDraftStore, and returns { draftId, plan }. The draft must be
 * approved (planDraftStore.markApproved) before createRunWithMatrix will
 * execute it via { planDraftId }.
 *
 * @param {string} url — target URL (SSRF-validated)
 * @param {object} [options] — { maxPages, maxDepth }
 * @returns {Promise<{ draftId: string, plan: object }>}
 */
export async function draftPlan(url, options = {}) {
  if (!acceptingRuns()) throw new Error('Server is shutting down — not accepting new plan drafts');
  // Drafting gate: always block dangerous schemes. Full SSRF validation is
  // best-effort here — a host whose DNS isn't resolvable yet (or is private)
  // simply yields an EMPTY draft plan, because crawlSite re-validates every
  // URL it actually visits and will refuse to reach it. The strict gate
  // applies again at run start (createRunWithMatrix / executeRun).
  assertUrlSchemeAllowed(url, 'url');
  try {
    await ssrf.validateUrl(url);
  } catch (err) {
    warn(`draftPlan: target URL failed SSRF validation (${err.message}) — draft will be empty`);
  }

  const maxPages = Math.min(Math.max(options.maxPages || 3, 1), 10);
  const maxDepth = Math.min(Math.max(options.maxDepth ?? 1, 0), 3);

  let plan = null;
  let crawlFailure = null;

  const crawlResult = await crawlSite({
    url,
    options: { maxPages, maxDepth },
  });

  try {
    const { pages, siteOrigin } = crawlResult;
    if (pages && pages.length > 0) {
      const { buildTestPlan } = await import('../explorer/index.js');
      const result = await buildTestPlan({
        pages,
        targetUrl: url,
        siteOrigin,
        options: { summary: false, riskPriority: false },
      });
      plan = result.plan;
    } else {
      crawlFailure = crawlResult.errors?.[0]?.error || 'no pages could be reached';
    }
  } finally {
    for (const p of crawlResult.pages) {
      if (p.page) await p.page.close().catch(() => {});
    }
    await closeCrawlSession(crawlResult.browser, crawlResult.egressProxy);
  }

  if (!plan) {
    // Unreachable target: still produce a minimal reviewable draft (the
    // human-in-the-loop gate stays usable — the reviewer sees an empty plan
    // and the failure reason, instead of a dead endpoint).
    const { parseTestPlan } = await import('./testPlan.js');
    plan = parseTestPlan({
      schemaVersion: 1,
      id: `plan_${Date.now()}_${randomUUID().slice(0, 8)}`,
      targetUrl: url,
      status: 'proposed',
      notes: `Automatic exploration could not reach ${url} (${crawlFailure}). Empty plan — re-draft once the target is reachable, or add flows manually.`,
    });
    warn(`draftPlan: crawl of ${url} failed (${crawlFailure}) — returning an empty draft plan`);
  }

  const draftId = planDraftStore.saveDraft(url, plan);
  info(`Drafted plan ${draftId} for ${url} (${plan.flows.length} flows, ${plan.apiEndpoints.length} endpoints)`);
  return { draftId, plan };
}

/**
 * Create a run that uses the matrix execution path.
 *
 * @param {object} input
 * @param {string} input.url             — target URL
 * @param {object} [input.options]       — { maxPages, maxDepth, browsers, viewports, executors, roles, dedup, activeTesting, authorizedTarget, monitorId, previousRunId, onlyNewFindings, webhookUrl }
 * @param {object} [input.plan]          — pre-approved TestPlan (skips explorer)
 * @param {boolean} [input.approved]     — explicit human approval of `plan` (schema + SSRF validated)
 * @param {string} [input.planDraftId]   — id of an approved plan draft (planDraftStore)
 * @returns {Promise<string>}            — runId
 */
export async function createRunWithMatrix({ url, options = {}, plan: submittedPlan, approved, planDraftId } = {}) {
  if (!acceptingRuns()) throw new Error('Server is shutting down — not accepting new runs');

  let effectiveUrl = url;
  let effectivePlan = submittedPlan;

  // Human-approved draft path: load + verify approval before executing.
  if (planDraftId) {
    const draft = planDraftStore.getDraft(planDraftId);
    if (!draft) {
      throw new Error(`Plan draft not found: ${planDraftId}`);
    }
    if (draft.status !== 'approved') {
      throw new Error(`Plan draft ${planDraftId} is not approved — approve it before running`);
    }
    if (!effectivePlan) effectivePlan = draft.plan;
    if (!effectiveUrl) effectiveUrl = draft.url || draft.plan?.targetUrl;
  }

  if (!effectiveUrl) {
    throw new Error('url is required (or a planDraftId whose draft carries a target URL)');
  }

  // Validate URL up front
  await ssrf.validateUrl(effectiveUrl);
  if (options?.webhookUrl) {
    await ssrf.validateUrl(options.webhookUrl);
  }

  // Explicitly-approved plans are schema-validated + SSRF-validated now, so
  // bad URLs fail the request instead of the run.
  if (effectivePlan && (approved === true || planDraftId)) {
    const { validateTestPlan } = await import('./testPlan.js');
    const verdict = validateTestPlan(effectivePlan);
    if (!verdict.ok) {
      const detail = verdict.error.map(e => `${e.path}: ${e.message}`).join('; ');
      throw new Error(`Invalid test plan: ${detail}`);
    }
    effectivePlan = verdict.plan;
    await validatePlanUrls(effectivePlan, effectiveUrl);
  }

  const runId = `run_matrix_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const run = {
    runId,
    url: effectiveUrl,
    status: 'queued',
    startedAt: new Date().toISOString(),
    options: {
      maxPages: Math.min(Math.max(options.maxPages || 1, 1), 100),
      maxDepth: options.maxDepth || 2,
      concurrency: Math.min(Math.max(Number(options.concurrency) || 1, 1), 4),
      browsers: options.browsers || ['chromium'],
      viewports: options.viewports || null,    // null = infer from crawl
      executors: options.executors || null,    // null = use plan defaults
      roles: options.roles || null,             // null = infer from plan
      dedup: options.dedup !== false,
      activeTesting: options.activeTesting === true,
      authorizedTarget: options.authorizedTarget === true,
      // Monitoring metadata (Rung 3) — carried through to execution so the
      // publisher can filter regressions and notify the right webhook.
      ...(options.monitorId ? { monitorId: options.monitorId } : {}),
      // CLI `--login <recording>` (Phase 9): reuse a recorded login session.
      ...(options.loginRecording ? { loginRecording: options.loginRecording } : {}),
      ...(options.previousRunId ? { previousRunId: options.previousRunId } : {}),
      ...(options.onlyNewFindings != null ? { onlyNewFindings: options.onlyNewFindings } : {}),
      ...(options.webhookUrl ? { webhookUrl: options.webhookUrl } : {}),
    },
    events: [],
    findings: [],
    matrixStats: null,
    pages: [],
    score: null,
    summary: null,
    mode: 'matrix',
  };

  if (effectivePlan) {
    run.preApprovedPlan = effectivePlan;
  }
  if (planDraftId) {
    run.planDraftId = planDraftId;
  }

  runs.set(runId, run);
  await saveRun(run);

  jobQueue.enqueue({
    runId,
    payload: {
      mode: 'matrix',
      runId,
      url: effectiveUrl,
      options: run.options,
      preApprovedPlan: effectivePlan,
    },
  });

  processQueue();
  return runId;
}

/**
 * Execute a matrix run — crawl, build plan (or use pre-approved), run matrix.
 */
export async function executeRunWithMatrix(runId, payload) {
  const run = runs.get(runId) || await getRun(runId);
  if (!run) return;

  if (payload?.preApprovedPlan && !run.preApprovedPlan) {
    run.preApprovedPlan = payload.preApprovedPlan;
  }

  run.status = 'running';
  await saveRun(run);
  emitEvent(runId, 'Starting matrix run');

  const abortController = new AbortController();
  activeAbortControllers.set(runId, abortController);

  let browserPool = null;
  let crawlBrowser = null;
  let crawlEgressProxy = null;
  let crawlResult = null;

  const exec = (async () => {
    try {
      // Lazy-import matrix modules so the legacy path doesn't pay the cost
      const { createStateManager, BrowserPool, runMatrix } = await import('../matrix/index.js');
      const { buildTestPlan, approvePlan } = await import('../explorer/index.js');

      // Executors must be registered for ANY entry path (dashboard POST,
      // scheduler, monitor run-now, programmatic). Idempotent — safe to repeat.
      const { registerAllExecutors } = await import('../executors/index.js');
      registerAllExecutors();
      const { registerLegacyChecks } = await import('../checks/index.js');
      registerLegacyChecks();

      const createFinding = createFindingFactory();
      const onEvent = (msg) => emitEvent(runId, msg);
      const signal = abortController.signal;

      // ─── 0. Recorded login session (monitor runs) ─────────────────
      let recordedSession = null;
      const recordedSessions = {};
      let sessionCookie = null;
      // Recorded sessions come from monitors (run.options.monitorId) or the
      // CLI `--login <recording>` flag (Phase 9).
      const sessionKey = run.options.monitorId || run.options.loginRecording;
      if (sessionKey) {
        const { SessionStore } = await import('./sessionStore.js');
        const sessionStore = new SessionStore();
        const requestedRoles = Array.isArray(run.options.roles) && run.options.roles.length
          ? run.options.roles
          : ['default'];
        for (const role of requestedRoles) {
          const session = await sessionStore.loadSession(sessionKey, role).catch(err => {
            throw new Error(`Failed to load recorded session for role "${role}": ${err.message}`);
          });
          if (!session) {
            if (run.options.roles?.length) {
              throw new Error(`No recorded session exists for monitor role "${role}"`);
            }
            continue;
          }
          recordedSessions[role] = session;
        }
        const availableRoles = Object.keys(recordedSessions);
        if (availableRoles.length > 0) {
          run.options.roles = availableRoles;
          recordedSession = recordedSessions[availableRoles[0]];
        }
        if (recordedSession) {
          const cookieCount = recordedSession.cookies?.length || 0;
          emitEvent(runId, `Using recorded login session (${cookieCount} cookies) — testing the authenticated app`);
          run.options.sessionApplied = true;
          try {
            sessionCookie = sessionStore.cookieHeaderFor(new URL(run.url).host, recordedSession);
          } catch { /* non-parsing URL — skip API session */ }
        }
      }

      // ─── 0.5 Plan-level SSRF gate (BEFORE any browser launches) ────
      // Runs with an explicit plan validate every plan URL here; runs that
      // will infer a plan have their plan validated right after inference.
      if (run.preApprovedPlan) {
        emitEvent(runId, 'Validating plan URLs');
        const { validateTestPlan } = await import('./testPlan.js');
        const verdict = validateTestPlan(run.preApprovedPlan);
        if (!verdict.ok) {
          const detail = verdict.error.map(e => `${e.path}: ${e.message}`).join('; ');
          throw new Error(`Invalid test plan: ${detail}`);
        }
        run.preApprovedPlan = verdict.plan;
        await validatePlanUrls(run.preApprovedPlan, run.url);
      }
      await ssrf.validateUrl(run.url);
      const pinRules = await resolvePinRulesSafe(run.url);

      // ─── 1. Crawl ─────────────────────────────────────────────────
      emitEvent(runId, 'Crawling site');
      crawlResult = await crawlSite({
        url: run.url,
        options: {
          maxPages: run.options.maxPages,
          maxDepth: run.options.maxDepth,
          ...(recordedSession ? { storageState: recordedSession } : {}),
          ...(pinRules ? { hostResolverRules: pinRules } : {}),
        },
        onEvent, signal,
      });
      const { pages, siteOrigin } = crawlResult;
      crawlBrowser = crawlResult.browser;
      crawlEgressProxy = crawlResult.egressProxy;

      if (!pages || pages.length === 0) {
        const rootError = crawlResult.errors?.[0]?.error || 'Target URL could not be crawled (no pages reached)';
        throw new Error(`Target page failed to load (${run.url}): ${rootError}`);
      }

      // Recorded-session expiry detection: if every crawled page looks like a
      // login page despite the session, the session has probably expired.
      if (recordedSession && pages.length > 0) {
        const { looksLikeLoginUrl } = await import('./sessionStore.js');
        const allLogin = pages.every(p => looksLikeLoginUrl(p.url || '', p.title || ''));
        if (allLogin) {
          run.sessionExpired = true;
          emitEvent(runId, '⚠ Recorded session appears EXPIRED — every crawled page looks like a login page. Re-record the login for this monitor.');
        }
      }

      // ─── 2. Build or use plan ──────────────────────────────────────
      let plan = run.preApprovedPlan;
      if (!plan) {
        emitEvent(runId, 'Building test plan via explorer');
        const result = await buildTestPlan({
          pages, targetUrl: run.url, siteOrigin, onEvent: undefined, signal,
        });
        plan = approvePlan(result.plan);
        // The auto-approved inferred plan goes through the same URL gate.
        await validatePlanUrls(plan, run.url);
      }

      // ─── 2.5 OpenAPI import (Phase 9) — deterministic endpoint surface ───
      // Replaces the inferred apiEndpoints with the spec's. Runs after plan
      // approval so both inferred and pre-approved plans get the spec surface.
      if (run.options.openapiSpec) {
        try {
          const { openApiToEndpoints } = await import('../services/openapiImport.js');
          const imported = openApiToEndpoints(run.options.openapiSpec, { targetUrl: run.url });
          if (imported.endpoints.length > 0) {
            plan = { ...plan, apiEndpoints: imported.endpoints };
            emitEvent(runId, `OpenAPI import: ${imported.endpoints.length} endpoint(s) from ${imported.title || 'spec'} (v${imported.version || '?'})`);
          }
        } catch (err) {
          emitEvent(runId, `OpenAPI import failed: ${err.message}`);
        }
      }

      // Persist the approved plan so GET /api/runs/:id can show it.
      run.plan = plan;
      try {
        dbSavePlan(runId, plan);
      } catch (err) {
        warn(`Could not persist plan for ${runId}: ${err.message}`);
      }

      // Override plan options with run options
      if (run.options.browsers) plan.browsers = run.options.browsers;
      if (run.options.viewports) plan.viewports = run.options.viewports;
      if (run.options.executors) plan.executors = run.options.executors;

      emitEvent(runId, `Plan: ${plan.flows.length} flows, ${plan.apiEndpoints.length} endpoints, ` +
                       `${plan.fuzzTargets.length} fuzz targets, ${plan.a11yRules.length} a11y rules`);

      // ─── 3. Prime state manager ─────────────────────────────────────
      const stateManager = createStateManager({
        runStep: (await import('../executors/e2e.js')).runStep,
        onEvent: (msg) => emitEvent(runId, msg),
      });

      // Launch one browser (chromium by default) for state capture —
      // skipped when a recorded session exists (no AI login flows needed).
      if (crawlBrowser && !recordedSession) {
        try {
          await stateManager.prime({
            plan, browser: crawlBrowser, browserName: 'chromium',
            viewport: plan.viewports?.[0] || { width: 1280, height: 720 },
            signal,
          });
        } catch (err) {
          warn(`State manager prime failed: ${err.message}`);
        }
      }

      // Done with crawl browser — state has been primed
      if (crawlBrowser) {
        await closeCrawlSession(crawlBrowser, crawlResult?.egressProxy).catch(() => {});
      }

      // ─── 4. Build browser pool ───────────────────────────────────────
      browserPool = new BrowserPool({
        stateManager,
        options: {
          ...(Object.keys(recordedSessions).length ? { storageStates: recordedSessions } : {}),
          ...(pinRules ? { hostResolverRules: pinRules } : {}),
          // Plan option `bypassCsp` (defaults true inside the pool).
          ...(plan.bypassCsp != null ? { bypassCsp: plan.bypassCsp } : {}),
        },
      });
      // Hard-timeout emergency cleanup — closes every pooled browser.
      activeCleanups.set(runId, () => browserPool.shutdown());

      // ─── 5. Run the matrix ──────────────────────────────────────────
      emitEvent(runId, 'Running matrix');
      const matrixResult = await runMatrix({
        plan, browserPool, createFinding, onEvent, signal,
        options: {
          dedup: run.options.dedup,
          concurrency: run.options.concurrency || 1,
          screenshotsDir: SCREENSHOTS_DIR,
          evidenceDir: evidenceDirFor(runId),
          runId,
          roles: run.options.roles,
          // Phase D (BUILD_PLAN steps 2–4): matrix-level classification.
          coveredPages: (pages || []).map((p) => p.url),
          pageScopeAgreement: true,
          pageScopePromotion: true,
          crossCellAgreement: true,
          retryBeforeConfirm: true,
          allowActiveFuzz: run.options.activeTesting && run.options.authorizedTarget,
          // Visual executor keys baselines on this (baselineStore is
          // monitor-scoped; falls back to runId when absent).
          ...(run.options.monitorId ? { monitorId: run.options.monitorId } : {}),
          // Authenticated API contract probing with the recorded session
          ...(sessionCookie ? { sessionCookie } : {}),
        },
      });

      // ─── 6. Close all pages + finalize ──────────────────────────────
      for (const p of pages) {
        if (p.page) await p.page.close().catch(() => {});
      }

      run.findings = matrixResult.findings;
      run.matrixStats = matrixResult.stats;
      run.coverageFailures = matrixResult.coverageFailures || [];

      const pagesAttempted = pages.length;
      const failedUrls = new Set((run.coverageFailures || []).map(f => f.pageUrl));
      const pagesScanned = Math.max(0, pagesAttempted - failedUrls.size);
      const coverageRatio = pagesAttempted > 0 ? pagesScanned / pagesAttempted : 1.0;
      run.coverage = { pagesAttempted, pagesScanned, coverageRatio };

      const scoreOpts = {
        pagesAttempted,
        pagesScanned,
        coverageRatio,
        excludeUnauthenticated: run.options?.excludeUnauthenticated,
      };

      run.score = calculateScore(matrixResult.findings, scoreOpts);
      run.summary = summarizeFindings(matrixResult.findings, pages.length, scoreOpts);

      run.pages = pages.map(p => {
        const { page, consoleLogs, pageExceptions, networkFailures, networkErrors, ...rest } = p;
        return rest;
      });

      if (matrixResult.stats.failedCells > 0) {
        throw new Error(`Matrix incomplete: ${matrixResult.stats.failedCells} cell(s) failed`);
      }

      // Invariant check in non-production / test mode
      if (process.env.NODE_ENV !== 'production' || process.env.SQA_STRICT === 'true') {
        try {
          const { validateReport } = await import('../reporting/invariants.js');
          validateReport(run, { throwOnError: process.env.NODE_ENV === 'test' || process.env.SQA_STRICT === 'true' });
        } catch (invErr) {
          logError(`Invariant validation failure in matrix run ${runId}: ${invErr.message}`);
          if (process.env.NODE_ENV === 'test' || process.env.SQA_STRICT === 'true') throw invErr;
        }
      }
      if (isTerminal(run.status)) {
        // Hard timeout / cancel already finalized — don't overwrite.
        return;
      }
      if (abortController.signal.aborted) {
        run.status = 'cancelled';
        run.completedAt ||= new Date().toISOString();
        emitDone(runId);
        return;
      }
      run.status = 'completed';
      run.completedAt = new Date().toISOString();
      emitEvent(runId, `Completed — ${matrixResult.findings.length} findings, score ${run.score}`);
      emitDone(runId);

      // ─── 7. Auto-publish findings to issue tracker (if configured) ────
      const publishOpts = {};
      if (run.options.monitorId && run.options.onlyNewFindings && run.options.previousRunId) {
        try {
          const prev = await getRun(run.options.previousRunId);
          if (prev?.findings?.length) {
            const { findingSignature } = await import('../integrations/issueTracker.js');
            publishOpts.previousSignatures = new Set(
              prev.findings.map(f => `${findingSignature(f)}::${f.severity}`)
            );
            publishOpts.onlyNewFindings = true;
          }
        } catch (err) {
          warn(`Could not load previous run for regression filter: ${err.message}`);
        }
      }
      await publishFindingsIfConfigured(run, onEvent, publishOpts).catch(err => {
        warn(`Issue tracker publish failed: ${err.message}`);
      });

      // ─── 8. Notify webhook (if configured) ────────────────────────────
      await notifyWebhook(run).catch(err => {
        warn(`Webhook notification failed: ${err.message}`);
      });

    } catch (err) {
      if (isTerminal(run.status)) {
        return; // hard timeout already finalized the run
      }
      if (abortController.signal.aborted) {
        run.status = 'cancelled';
        run.completedAt ||= new Date().toISOString();
        emitDone(runId);
      } else {
        logError(`Matrix run ${runId} failed`, err);
        run.status = 'failed';
        run.completedAt = new Date().toISOString();
        run.error = err.message;
        emitEvent(runId, `Run failed: ${err.message}`);
        emitDone(runId);
      }
    } finally {
      activeCleanups.delete(runId);
      if (crawlBrowser) await closeCrawlSession(crawlBrowser, crawlEgressProxy).catch(() => {});
      if (browserPool) await browserPool.shutdown().catch(() => {});
      await saveRun(run);
      // Flaky tracking — record every terminal run.
      if (isTerminal(run.status)) {
        await recordFlakyRun(run);
      }
    }
  })();

  try {
    await raceWithHardTimeout(runId, run, abortController, exec);
  } catch (err) {
    logError(`Hard timeout supervision failed for ${runId}`, err);
  } finally {
    activeAbortControllers.delete(runId);
  }
}

/**
 * Record a terminal run into flaky history (best-effort — never fails a run).
 * Analysis uses the single shared algorithm in matrix/flakyTracker.js.
 */
async function recordFlakyRun(run) {
  try {
    const { FlakyTracker } = await import('../matrix/flakyTracker.js');
    const tracker = new FlakyTracker();
    await tracker.recordRun(run);
  } catch (err) {
    warn(`Flaky tracking failed for run ${run.runId}: ${err.message}`);
  }
}

/**
 * Auto-publish findings to an issue tracker if configured.
 * Reads config from env vars:
 *   SQA_ISSUE_TRACKER   = 'github' | 'jira' | 'console' | 'none'
 *
 * For GitHub:
 *   SQA_GITHUB_REPO     = 'owner/name'
 *   SQA_GITHUB_TOKEN    = Personal Access Token
 *
 * For Jira:
 *   SQA_JIRA_BASE_URL   = 'https://your-domain.atlassian.net'
 *   SQA_JIRA_EMAIL      = account email
 *   SQA_JIRA_API_TOKEN  = API token
 *   SQA_JIRA_PROJECT_KEY = 'SQA'
 *
 * Common options:
 *   SQA_TRACKER_MIN_SEVERITY = 'medium' | 'high' | 'critical'  (default 'medium')
 *   SQA_TRACKER_DRY_RUN     = 'true' to log actions without API calls
 */
async function publishFindingsIfConfigured(run, onEvent, opts = {}) {
  const trackerType = process.env.SQA_ISSUE_TRACKER || 'none';
  if (trackerType === 'none') return;

  let adapter = null;

  if (trackerType === 'github') {
    const { GitHubAdapter } = await import('../integrations/githubAdapter.js');
    const repo = process.env.SQA_GITHUB_REPO;
    if (!repo) {
      warn('SQA_ISSUE_TRACKER=github but SQA_GITHUB_REPO not set');
      return;
    }
    adapter = new GitHubAdapter({ repo });
  } else if (trackerType === 'jira') {
    const { JiraAdapter } = await import('../integrations/jiraAdapter.js');
    adapter = new JiraAdapter({
      baseUrl: process.env.SQA_JIRA_BASE_URL,
      email: process.env.SQA_JIRA_EMAIL,
      apiToken: process.env.SQA_JIRA_API_TOKEN,
      projectKey: process.env.SQA_JIRA_PROJECT_KEY,
    });
  } else if (trackerType === 'console') {
    // Console adapter — just logs what would be filed. Useful for CI logs.
    adapter = {
      name: 'console',
      search: async () => null,
      create: async ({ title, body, labels }) => {
        console.log('--- ISSUE CREATED ---');
        console.log('Title:', title);
        console.log('Labels:', labels.join(', '));
        console.log('Body:', body.slice(0, 500) + '...');
        return { id: 'console-' + Date.now(), url: '', state: 'open', title, labels };
      },
      update: async (issue, { comment }) => {
        if (comment) console.log('--- ISSUE UPDATED ---\n', issue.id, '\n', comment);
        return issue;
      },
    };
  } else {
    warn(`Unknown SQA_ISSUE_TRACKER: ${trackerType}`);
    return;
  }

  const { IssueTrackerPublisher } = await import('../integrations/issueTracker.js');
  const publisher = new IssueTrackerPublisher({
    adapter,
    options: {
      minSeverity: process.env.SQA_TRACKER_MIN_SEVERITY || 'medium',
      dryRun: process.env.SQA_TRACKER_DRY_RUN === 'true',
      closeResolved: process.env.SQA_TRACKER_AUTO_CLOSE === 'true',
    },
  });

  // Regression filter (Rung 3 monitoring): skip findings whose signature +
  // severity already existed in the previous run. Severity is part of the
  // key, so a bug that got worse is still reported.
  let findings = run.findings;
  if (opts.onlyNewFindings && opts.previousSignatures instanceof Set) {
    const { findingSignature } = await import('../integrations/issueTracker.js');
    const before = findings.length;
    findings = findings.filter(f => !opts.previousSignatures.has(`${findingSignature(f)}::${f.severity}`));
    if (findings.length < before) {
      onEvent?.(`Regression filter: ${before - findings.length} known finding(s) skipped, ${findings.length} new`);
    }
    if (findings.length === 0) {
      onEvent?.('No new findings to publish');
      return;
    }
  }

  onEvent?.(`Publishing ${findings.length} findings to ${trackerType}…`);

  const result = await publisher.publish(findings, {
    runId: run.runId,
    url: run.url,
    startedAt: run.startedAt,
    matrixCells: run.matrixStats?.cells?.map(c => c.cellId) || [],
    // Coverage info — the publisher skips auto-close without it.
    pages: run.pages,
  });

  onEvent?.(`Tracker: ${result.filed} filed, ${result.updated} updated, ${result.skipped} skipped, ${result.errors.length} errors`);

  run.trackerStats = result;
  await saveRun(run);
}

/**
 * POST a compact run summary to the configured webhook (Rung 3 monitoring).
 *
 * Webhook URL resolution: run.options.webhookUrl (per-monitor override)
 * → SQA_WEBHOOK_URL env. No URL configured = no-op.
 *
 * Non-blocking by design: errors are logged, never thrown into the run path.
 * Payload: { runId, url, monitorId, status, score, startedAt, completedAt,
 *            findings: [{ title, severity, confidence, ruleId, pageUrl }],
 *            reportUrl }
 */
async function notifyWebhook(run) {
  const url = run.options?.webhookUrl || process.env.SQA_WEBHOOK_URL;
  if (!url) return;

  const payload = {
    runId: run.runId,
    url: run.url,
    monitorId: run.options?.monitorId || null,
    status: run.status,
    score: run.score,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    findings: (run.findings || []).map(f => ({
      title: f.title,
      severity: f.severity,
      confidence: f.confidence,
      ruleId: f.ruleId,
      pageUrl: f.pageUrl,
    })),
  };
  // Public report link — best-effort from env (or localhost default), so the
  // receiver can open the full HTML report.
  payload.reportUrl = `${process.env.SQA_PUBLIC_URL || `http://localhost:${process.env.SQA_DASHBOARD_PORT || 8080}`}/api/runs/${run.runId}/report.html`;

  try {
    const res = await ssrf.safeFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, { maxRedirects: 0 });
    if (!res.ok) {
      warn(`Webhook responded ${res.status}`);
    }
  } catch (err) {
    warn(`Webhook notification failed: ${err.message}`);
  }
}

// ─── Retention: schedule cleanupOldRuns ───────────────────────────────
// Runs once shortly after boot and then every 6 hours. Timers are unref'd so
// they never keep the process alive. Disabled for tests via
// SQA_DISABLE_CLEANUP=1 or NODE_ENV=test (tests seed long-expired runs).
function scheduleCleanup() {
  if (process.env.SQA_DISABLE_CLEANUP === '1' || process.env.NODE_ENV === 'test') return;
  const initial = setTimeout(() => {
    cleanupOldRuns().catch(() => {});
  }, 30 * 1000);
  if (initial.unref) initial.unref();
  const interval = setInterval(() => {
    cleanupOldRuns().catch(() => {});
  }, CLEANUP_INTERVAL_MS);
  if (interval.unref) interval.unref();
}

// ─── Startup: recover interrupted runs and kick off worker loop ──────
try {
  // Single-process app: recover ALL jobs left 'running' by a previous
  // instance (regardless of age) and mark their run rows failed with a
  // clear "interrupted by server restart — re-run" event.
  const { totalStale, recovered } = jobQueue.recoverStaleJobs();
  if (totalStale > 0) {
    info(`JobQueue: recovered ${recovered}/${totalStale} interrupted job(s) from previous session`);
  }
  scheduleCleanup();
  processQueue();
} catch (err) {
  // Graceful fallback if database schema is initializing or running in isolation
  void err;
}
