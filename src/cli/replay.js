/**
 * src/cli/replay.js — CI plan replay (Phase 3).
 *
 * Usage:
 *   qualitypilot replay <plan.json> [--url <target>] [--fail-on <sev|list>]
 *                       [--min-score <n>] [--timeout <ms>] [--max-pages <n>]
 *                       [--ignore-file <waivers.json>] [--authorized-target]
 *
 * Loads an exported plan JSON (qualitypilot/plan artifact — see
 * `qualitypilot export`), saves it as an approved draft, and executes it
 * through the full matrix runner with every classifier active. No LLM key
 * needed — replay is deterministic.
 *
 * Exit codes mirror the check CLI: 0 pass, 1 gate failed, 64 usage,
 * 70 run failure. When running inside GitHub Actions, a markdown job summary
 * is appended to $GITHUB_STEP_SUMMARY.
 */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { importPlanJson } from '../export/planJson.js';
import { transitionStatus } from '../services/testPlan.js';
import { runMatrix } from '../matrix/matrixRunner.js';
import { BrowserPool } from '../matrix/browserPool.js';
import { registerAllExecutors } from '../executors/index.js';
import { registerLegacyChecks } from '../checks/index.js';
import { clearExecutors } from '../services/executorRegistry.js';
import { createFindingFactory } from '../services/findingFactory.js';
import { calculateScore, summarizeFindings } from '../services/scoring.js';
import { evaluateGate } from './check.js';
import { parseWaiverFile, applyWaivers } from '../services/waivers.js';

const EXIT_OK = 0;
const EXIT_USAGE = 64;
const EXIT_FAILURE = 70;
const EXIT_THRESHOLD_EXCEEDED = 1;

function parseReplayArgs(argv) {
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
      // Same meaning as `check --authorized-target`: allow ACTIVE injection
      // probing on non-loopback targets. The GitHub Action replays plans
      // against preview deployments, so without this flag injection would be
      // silently skipped on every remote target (audit H-2).
      opts.authorizedTarget = true;
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown option: ${a}`);
    } else {
      positional.push(a);
    }
  }

  if (positional.length !== 1) {
    throw new Error('Usage: qualitypilot replay <plan.json> [--url <target>] [--fail-on <sev|list>] [--min-score <n>] [--timeout <ms>] [--max-pages <n>] [--ignore-file <file>] [--authorized-target]');
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

/**
 * Retarget an exported plan to a different target URL (--url). Absolute
 * same-origin URLs recorded at inference time (flow startUrls, navigate
 * steps, api-request calls, endpoint baseUrls) are rewritten to the new
 * origin — path + query preserved — so the recorded journey replays against
 * a preview deployment instead of the original site. Cross-origin URLs are
 * left untouched (they were deliberately allowed when the plan was built).
 */
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
      url.host = to.host; // host covers hostname + port
      let out = url.toString();
      // A bare-origin URL ('https://host') normalizes to 'https://host/' —
      // preserve the caller's original shape so assertions/storage keys match.
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
  return plan;
}

/**
 * Apply the `--max-pages` cap to a plan's page set (audit N-3).
 * Returns the number of dropped pages (0 when nothing changed).
 */
export function limitPlanPages(plan, maxPages) {
  if (maxPages == null || !Array.isArray(plan?.pages) || plan.pages.length <= maxPages) return 0;
  const dropped = plan.pages.length - maxPages;
  plan.pages = plan.pages.slice(0, maxPages);
  return dropped;
}

/**
 * Coverage-aware score options for a replay (audit N-2).
 *
 * The plan's page set is what the replay attempted; coverageFailures record
 * which of those pages could not be loaded. The check path scores coverage
 * this way (runManager) — without it a replay whose pages all failed still
 * reported 100/100.
 *
 * @returns {{pagesAttempted:number, pagesScanned:number}|null} null when the
 *          plan carries no page set (score falls back to findings only).
 */
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
    `## QualityPilot replay — ${plan.id}`,
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

  try {
    const raw = JSON.parse(await readFile(opts.planFile, 'utf8'));
    let plan = importPlanJson(raw);
    if (opts.url) plan = retargetPlan(plan, opts.url);
    // Walk the plan to 'approved' (draft → proposed → approved); exported
    // plans are drafts, and createRunWithMatrix requires an approved draft.
    // transitionStatus returns a new plan object (immutable style) — reassign.
    if (plan.status === 'draft') plan = transitionStatus(plan, 'proposed');
    if (plan.status !== 'approved') plan = transitionStatus(plan, 'approved');

    registerAllExecutors();
    registerLegacyChecks();

    // Audit N-3: --max-pages is an Action input; it was parsed and silently
    // ignored. Apply it to the plan's page set (flows are left untouched —
    // they are explicit user intent).
    const droppedPages = limitPlanPages(plan, opts.maxPages);
    if (droppedPages > 0) {
      console.log(`Limited replay to ${opts.maxPages} page(s) — ${droppedPages} page(s) dropped by --max-pages`);
    }

    console.log(`QualityPilot replay — plan '${plan.id}' against ${plan.targetUrl}`);

    const browserPool = new BrowserPool();
    const createFinding = createFindingFactory();
    // Audit M-5: --timeout was parsed and never used — a hung replay blocked
    // the Action until the job's own timeout. Abort the matrix at the
    // deadline and fail the replay.
    const controller = new AbortController();
    let timedOut = false;
    const deadlineTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, opts.timeout);
    try {
      const result = await runMatrix({
        plan,
        browserPool,
        createFinding,
        onEvent: (msg) => console.log(`  · ${msg}`),
        signal: controller.signal,
        options: {
          dedup: true,
          runId: `replay_${Date.now()}`,
          retryBeforeConfirm: true,
          crossCellAgreement: true,
          pageScopeAgreement: true,
          // Audit H-2: without this the injection executor's non-loopback
          // authorization gate never opens on the Action's preview targets.
          authorizedTarget: opts.authorizedTarget === true,
        },
      });

      // Audit H-1: the check path fails the run when cells fail
      // (runManager); replay scored the findings and exited 0 even when the
      // matrix executed nothing ("PASS ... EXIT=0" on 0/1 cells).
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

      // Waivers — parity with `check --ignore-file`. Without this the GitHub
      // Action gate (which runs replay) could never honour the team's
      // waiver file, so local CI and the PR gate disagreed (audit M-5).
      let waiverResult = null;
      let gateFindings = findings;
      if (opts.ignoreFile) {
        const { waivers } = parseWaiverFile(await readFile(opts.ignoreFile, 'utf8'));
        waiverResult = applyWaivers(findings, waivers);
        gateFindings = waiverResult.kept;
        for (const f of waiverResult.waived) f.waived = true;
        for (const w of waiverResult.warnings) console.error(w);
      }

      const score = calculateScore(findings, replayCoverage(plan, result) || {});
      const summary = summarizeFindings(findings, result.stats?.totalCells ?? 0);
      const gate = evaluateGate({ findings: gateFindings, score, failOn: opts.failOn, minScore: opts.minScore });

      console.log('');
      const shownScore = typeof score === 'number' ? Math.round(score * 10) / 10 : '—';
      console.log(`Score: ${shownScore}/100 | Findings: ${findings.length}`);
      const waiverNote = waiverResult && waiverResult.waived.length > 0
        ? ` · waivers: ${waiverResult.waived.length} suppressed (--min-score still uses the unwaived run score)`
        : '';
      console.log(`Gate: ${gate.reason}${waiverNote}`);
      if (process.env.GITHUB_STEP_SUMMARY) {
        const { appendFile } = await import('node:fs/promises');
        await appendFile(process.env.GITHUB_STEP_SUMMARY, markdownSummary(plan, { findings, score }, gate), 'utf8');
        console.log('Job summary appended to $GITHUB_STEP_SUMMARY');
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
  }
}

// ─── direct CLI entry (same pattern as check.js) ─────────────────────
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
