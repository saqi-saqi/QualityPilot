/**
 * src/cli/replay.js — CI plan replay (Phase 3) with matrix sharding (WS4.1).
 *
 * Usage:
 *   testigator replay <plan.json> [--url <target>] [--fail-on <sev|list>]
 *                       [--min-score <n>] [--timeout <ms>] [--max-pages <n>]
 *                       [--ignore-file <waivers.json>] [--authorized-target]
 *                       [--shard <i/N>] [--shard-out <file>] [--format text|json]
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { importPlanJson } from '../export/planJson.js';
import { transitionStatus } from '../services/testPlan.js';
import { runMatrix } from '../matrix/matrixRunner.js';
import { planMatrix } from '../matrix/matrixPlanner.js';
import { parseShardSpec, resolveShardStorage, partitionShardWorkload } from '../matrix/sharding.js';
import { BrowserPool } from '../matrix/browserPool.js';
import { registerAllExecutors } from '../executors/index.js';
import { registerLegacyChecks } from '../checks/index.js';
import { clearExecutors } from '../services/executorRegistry.js';
import { createFindingFactory } from '../services/findingFactory.js';
import { calculateScore, summarizeFindings } from '../services/scoring.js';
import { evaluateGate } from './check.js';
import { parseWaiverFile, applyWaivers } from '../services/waivers.js';
import { config } from '../utils/config.js';

const EXIT_OK = 0;
const EXIT_USAGE = 64;
const EXIT_FAILURE = 70;
const EXIT_THRESHOLD_EXCEEDED = 1;

export function parseReplayArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  const opts = {
    url: null,
    failOn: 'none',
    minScore: null,
    timeout: 600000,
    maxPages: null,
    ignoreFile: null,
    authorizedTarget: false,
    shard: null,
    shardOut: null,
    format: 'text',
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--url') {
      opts.url = args[++i];
      if (!opts.url) throw new Error('--url requires a target URL');
    } else if (a === '--fail-on') {
      opts.failOn = args[++i] || 'none';
    } else if (a === '--min-score') {
      const n = Number(args[++i]);
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error('Invalid --min-score value');
      opts.minScore = n;
    } else if (a === '--timeout') {
      opts.timeout = Number(args[++i]) || 600000;
    } else if (a === '--max-pages') {
      opts.maxPages = Number(args[++i]) || undefined;
    } else if (a === '--ignore-file') {
      opts.ignoreFile = args[++i];
      if (!opts.ignoreFile) throw new Error('--ignore-file requires a waiver file path');
    } else if (a === '--authorized-target') {
      opts.authorizedTarget = true;
    } else if (a === '--shard') {
      opts.shard = parseShardSpec(args[++i]);
    } else if (a === '--shard-out') {
      opts.shardOut = args[++i];
      if (!opts.shardOut) throw new Error('--shard-out requires a file path');
    } else if (a === '--format') {
      const fmt = String(args[++i] || '').toLowerCase();
      if (fmt !== 'text' && fmt !== 'json') {
        throw new Error(`Invalid --format value: ${fmt}. Must be one of: text, json`);
      }
      opts.format = fmt;
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown option: ${a}`);
    } else {
      positional.push(a);
    }
  }

  if (positional.length !== 1) {
    throw new Error('Usage: testigator replay <plan.json> [--url <target>] [--fail-on <sev|list>] [--min-score <n>] [--timeout <ms>] [--max-pages <n>] [--ignore-file <file>] [--authorized-target] [--shard <i/N>] [--shard-out <file>] [--format text|json]');
  }
  opts.planFile = positional[0];
  return opts;
}

function envVsApp(findings) {
  const confirmed = findings.filter((f) => f.confidence === 'confirmed' && f.findingType === 'bug');
  const suspected = findings.filter((f) => f.confidence === 'suspected' && (f.findingType === 'bug' || f.findingType === 'environmental'));
  const flaky = findings.filter((f) => f.flakyCandidate);
  const env = findings.filter((f) => f.findingType === 'environmental' && !f.pageScoped);
  return { confirmed, suspected, flaky, environmental: env };
}

export function retargetPlan(plan, newTargetUrl) {
  const from = new URL(plan.targetUrl);
  const to = new URL(newTargetUrl);
  const sameOrigin = (u) => { try { return new URL(u).origin === from.origin; } catch { return false; } };
  const rewrite = (u) => {
    if (typeof u !== 'string' || !sameOrigin(u)) return u;
    try {
      const url = new URL(u);
      const hadNoTrailingSlash = !u.endsWith('/');
      url.protocol = to.protocol;
      url.host = to.host;
      let out = url.toString();
      if (hadNoTrailingSlash && url.pathname === '/' && !url.search && out.endsWith('/')) {
        out = out.slice(0, -1);
      }
      return out;
    } catch {
      return u;
    }
  };

  plan.targetUrl = newTargetUrl;
  for (const flow of plan.flows || []) {
    flow.startUrl = rewrite(flow.startUrl);
    for (const step of flow.steps || []) {
      if (step.action === 'navigate') {
        if (step.value) step.value = rewrite(step.value);
        if (step.selector) step.selector = rewrite(step.selector);
      } else if (step.action === 'api-request') {
        step.url = rewrite(step.url);
      }
    }
  }
  for (const ep of plan.apiEndpoints || []) {
    if (ep.baseUrl) ep.baseUrl = rewrite(ep.baseUrl);
  }
  for (const p of plan.pages || []) {
    if (p.url) p.url = rewrite(p.url);
  }
  for (const a of plan.a11yRules || []) {
    if (a.pageUrl) a.pageUrl = rewrite(a.pageUrl);
  }
  for (const pb of plan.perfBudgets || []) {
    if (pb.pageUrl) pb.pageUrl = rewrite(pb.pageUrl);
  }
  for (const vb of plan.visualBaselines || []) {
    if (vb.pageUrl) vb.pageUrl = rewrite(vb.pageUrl);
  }
  for (const ft of plan.fuzzTargets || []) {
    if (ft.pageUrl) ft.pageUrl = rewrite(ft.pageUrl);
  }
  return plan;
}

export function limitPlanPages(plan, maxPages) {
  if (maxPages == null || !Array.isArray(plan?.pages) || plan.pages.length <= maxPages) return 0;
  const dropped = plan.pages.length - maxPages;
  plan.pages = plan.pages.slice(0, maxPages);
  return dropped;
}

export function replayCoverage(plan, result) {
  const urls = new Set((plan?.pages || []).map((p) => p?.url).filter(Boolean));
  if (urls.size === 0) return null;
  const failed = new Set((result?.coverageFailures || [])
    .map((f) => f?.pageUrl)
    .filter((u) => u && urls.has(u)));
  return { pagesAttempted: urls.size, pagesScanned: Math.max(0, urls.size - failed.size) };
}

function markdownSummary(plan, result, gate) {
  const findings = result.findings || [];
  const envApp = envVsApp(findings);
  const lines = [
    `## Testigator replay — ${plan.id}`,
    '',
    `| Metric | Value |`,
    `| --- | --- |`,
    `| Score | ${result.score ?? '—'} |`,
    `| Confirmed bugs | ${envApp.confirmed.length} |`,
    `| Suspected (env or unconfirmed) | ${envApp.suspected.length} |`,
    `| Flaky candidates (G1) | ${envApp.flaky.length} |`,
    `| Environmental (site-scoped) | ${envApp.environmental.length} |`,
    `| Gate | ${gate.failed ? '❌ FAIL' : '✅ PASS'} (${gate.reason}) |`,
    '',
  ];
  const interesting = [...envApp.confirmed, ...envApp.suspected].slice(0, 20);
  if (interesting.length > 0) {
    lines.push('| Severity | Finding | Page |', '| --- | --- | --- |');
    for (const f of interesting) {
      lines.push(`| ${f.severity} / ${f.confidence}${f.flakyCandidate ? ' · flaky?' : ''} | ${String(f.title || '').replace(/\|/g, '\\|')} | ${f.pageUrl || '—'} |`);
    }
  } else {
    lines.push('_No confirmed or suspected findings._');
  }
  return lines.join('\n') + '\n';
}

export async function replayMain(argv = process.argv) {
  let opts;
  try {
    opts = parseReplayArgs(argv);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    return EXIT_USAGE;
  }

  const prevDataDir = process.env.SQA_DATA_DIR;
  const prevScreensDir = process.env.SQA_SCREENSHOTS_DIR;
  const prevDbPath = process.env.TESTIGATOR_DB_PATH;
  const prevLegacyDbPath = process.env.QUALITYPILOT_DB_PATH;
  let shardIsolated = false;

  try {
    const raw = JSON.parse(await readFile(opts.planFile, 'utf8'));
    let plan = importPlanJson(raw);
    if (opts.url) plan = retargetPlan(plan, opts.url);
    if (plan.status === 'draft') plan = transitionStatus(plan, 'proposed');
    if (plan.status !== 'approved') plan = transitionStatus(plan, 'approved');

    let shardStorage = null;
    if (opts.shard) {
      shardStorage = resolveShardStorage(opts.shard, config.dataDir);
      await mkdir(shardStorage.dataDir, { recursive: true });
      await mkdir(shardStorage.screenshotsDir, { recursive: true });
      if (!process.env.TESTIGATOR_DB_PATH && !process.env.QUALITYPILOT_DB_PATH && !process.env.SQA_DB_PATH) {
        const { closeDatabase } = await import('../storage/db.js');
        closeDatabase();
        process.env.SQA_DATA_DIR = shardStorage.dataDir;
        process.env.SQA_SCREENSHOTS_DIR = shardStorage.screenshotsDir;
        process.env.TESTIGATOR_DB_PATH = shardStorage.dbPath;
        shardIsolated = true;
      }
    }

    registerAllExecutors();
    registerLegacyChecks();

    const droppedPages = limitPlanPages(plan, opts.maxPages);
    const machineOutput = opts.format === 'json';
    const logStream = machineOutput ? process.stderr : process.stdout;
    if (droppedPages > 0) {
      logStream.write(`Limited replay to ${opts.maxPages} page(s) — ${droppedPages} page(s) dropped by --max-pages\n`);
    }

    const fullPlan = plan;
    const fullCoveredPages = (plan.pages || []).map((p) => p?.url).filter(Boolean);
    let effectivePlan = plan;
    let shardCells = null;
    let totalMatrixCells = null;
    if (opts.shard) {
      const fullCells = planMatrix(plan);
      const partitioned = partitionShardWorkload({ plan, cells: fullCells, shard: opts.shard });
      effectivePlan = partitioned.plan;
      shardCells = partitioned.cells;
      totalMatrixCells = partitioned.totalMatrixCells;
      logStream.write(`Testigator replay shard ${opts.shard.spec} (${partitioned.mode}): ${shardCells.length}/${totalMatrixCells} cells\n`);
    } else {
      logStream.write(`Testigator replay — plan '${plan.id}' against ${plan.targetUrl}\n`);
    }

    const browserPool = new BrowserPool();
    const createFinding = createFindingFactory();
    const controller = new AbortController();
    let timedOut = false;
    const deadlineTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, opts.timeout);
    try {
      const runId = `replay_${Date.now()}${opts.shard ? `_s${opts.shard.index}` : ''}`;
      const result = await runMatrix({
        plan: effectivePlan,
        ...(shardCells ? { cells: shardCells } : {}),
        browserPool,
        createFinding,
        onEvent: (msg) => logStream.write(`  · ${msg}\n`),
        signal: controller.signal,
        options: {
          dedup: true,
          runId,
          screenshotsDir: shardStorage?.screenshotsDir || config.screenshotsDir,
          evidenceDir: shardStorage?.evidenceDir || '',
          coveredPages: fullCoveredPages,
          retryBeforeConfirm: true,
          crossCellAgreement: true,
          pageScopeAgreement: true,
          authorizedTarget: opts.authorizedTarget === true,
        },
      });

      if (timedOut) {
        console.error(`ERROR: replay timed out after ${opts.timeout}ms — the matrix was aborted`);
        return EXIT_FAILURE;
      }
      const failedCells = result.stats?.failedCells ?? 0;
      const abortedCells = result.stats?.abortedCells ?? 0;
      if (failedCells > 0 || abortedCells > 0) {
        const totalCells = result.stats?.totalCells ?? 0;
        console.error(`ERROR: replay matrix incomplete — ${failedCells} cell(s) failed, ${abortedCells} aborted (of ${totalCells}); no gate verdict is trustworthy`);
        for (const cell of (result.stats?.cells || []).filter((c) => c.status === 'error').slice(0, 5)) {
          const detail = cell.error
            || (cell.executors || []).find((e) => e.status === 'error')?.error
            || 'executor error';
          console.error(`  · cell ${cell.cellId}: ${detail}`);
        }
        return EXIT_FAILURE;
      }

      const findings = result.findings || [];

      let waiverResult = null;
      let gateFindings = findings;
      if (opts.ignoreFile) {
        const { waivers } = parseWaiverFile(await readFile(opts.ignoreFile, 'utf8'));
        waiverResult = applyWaivers(findings, waivers);
        gateFindings = waiverResult.kept;
        for (const f of waiverResult.waived) f.waived = true;
        for (const w of waiverResult.warnings) console.error(w);
      }

      const coverage = replayCoverage(fullPlan, result);
      const score = calculateScore(findings, coverage || {});
      const summary = summarizeFindings(findings, totalMatrixCells ?? result.stats?.totalCells ?? 0);
      const gate = evaluateGate({ findings: gateFindings, score, failOn: opts.failOn, minScore: opts.minScore });

      const jsonReport = {
        runId,
        planId: fullPlan.id,
        url: fullPlan.targetUrl,
        status: 'completed',
        score,
        summary,
        coverage: coverage || { pagesAttempted: fullCoveredPages.length, pagesScanned: fullCoveredPages.length },
        coveredPages: fullCoveredPages,
        pages: fullPlan.pages || [],
        findings,
        ...(opts.shard ? { shard: opts.shard } : {}),
        ...(totalMatrixCells != null ? { totalMatrixCells } : {}),
        matrixStats: result.stats,
        failed: gate.failed,
        timestamp: new Date().toISOString(),
      };

      if (opts.shardOut) {
        await mkdir(path.dirname(path.resolve(opts.shardOut)), { recursive: true });
        await writeFile(opts.shardOut, JSON.stringify(jsonReport, null, 2) + '\n', 'utf8');
        logStream.write(`Wrote shard report to ${opts.shardOut}\n`);
      }

      const waiverNote = waiverResult && waiverResult.waived.length > 0
        ? ` · waivers: ${waiverResult.waived.length} suppressed (--min-score still uses the unwaived run score)`
        : '';

      if (opts.format === 'json') {
        process.stdout.write(JSON.stringify(jsonReport, null, 2) + '\n');
        process.stderr.write(`Gate: ${gate.reason}${waiverNote}\n`);
      } else {
        console.log('');
        const shownScore = typeof score === 'number' ? Math.round(score * 10) / 10 : '—';
        console.log(`Score: ${shownScore}/100 | Findings: ${findings.length}`);
        console.log(`Gate: ${gate.reason}${waiverNote}`);
      }

      if (process.env.GITHUB_STEP_SUMMARY) {
        const { appendFile } = await import('node:fs/promises');
        await appendFile(process.env.GITHUB_STEP_SUMMARY, markdownSummary(fullPlan, { findings, score }, gate), 'utf8');
        logStream.write('Job summary appended to $GITHUB_STEP_SUMMARY\n');
      }
      return gate.exitCode;
    } finally {
      clearTimeout(deadlineTimer);
      await browserPool.shutdown?.().catch?.(() => {}) ?? browserPool.close?.().catch?.(() => {});
      clearExecutors();
    }
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    return EXIT_FAILURE;
  } finally {
    if (shardIsolated) {
      try {
        const { closeDatabase } = await import('../storage/db.js');
        closeDatabase();
      } catch { /* best effort */ }
      if (prevDataDir === undefined) delete process.env.SQA_DATA_DIR;
      else process.env.SQA_DATA_DIR = prevDataDir;
      if (prevScreensDir === undefined) delete process.env.SQA_SCREENSHOTS_DIR;
      else process.env.SQA_SCREENSHOTS_DIR = prevScreensDir;
      if (prevDbPath === undefined) delete process.env.TESTIGATOR_DB_PATH;
      else process.env.TESTIGATOR_DB_PATH = prevDbPath;
      if (prevLegacyDbPath === undefined) delete process.env.QUALITYPILOT_DB_PATH;
      else process.env.QUALITYPILOT_DB_PATH = prevLegacyDbPath;
    }
  }
}

const invokedDirectly = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  replayMain(process.argv)
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(err);
      process.exitCode = EXIT_FAILURE;
    });
}
