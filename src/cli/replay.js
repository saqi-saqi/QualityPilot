/**
 * src/cli/replay.js — CI plan replay (Phase 3).
 *
 * Usage:
 *   qualitypilot replay <plan.json> [--url <target>] [--fail-on <sev|list>]
 *                       [--min-score <n>] [--timeout <ms>] [--max-pages <n>]
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
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown option: ${a}`);
    } else {
      positional.push(a);
    }
  }

  if (positional.length !== 1) {
    throw new Error('Usage: qualitypilot replay <plan.json> [--url <target>] [--fail-on <sev|list>] [--min-score <n>] [--timeout <ms>] [--max-pages <n>]');
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

    console.log(`QualityPilot replay — plan '${plan.id}' against ${plan.targetUrl}`);

    const browserPool = new BrowserPool();
    const createFinding = createFindingFactory();
    try {
      const result = await runMatrix({
        plan,
        browserPool,
        createFinding,
        onEvent: (msg) => console.log(`  · ${msg}`),
        signal: undefined,
        options: {
          dedup: true,
          runId: `replay_${Date.now()}`,
          retryBeforeConfirm: true,
          crossCellAgreement: true,
          pageScopeAgreement: true,
        },
      });

      const findings = result.findings || [];
      const score = calculateScore(findings);
      const summary = summarizeFindings(findings, result.stats?.totalCells ?? 0);
      const gate = evaluateGate({ findings, score, failOn: opts.failOn, minScore: opts.minScore });

      console.log('');
      console.log(`Score: ${typeof score === 'number' ? score : '—'}/100 | Findings: ${findings.length}`);
      console.log(`Gate: ${gate.reason}`);
      if (process.env.GITHUB_STEP_SUMMARY) {
        const { appendFile } = await import('node:fs/promises');
        await appendFile(process.env.GITHUB_STEP_SUMMARY, markdownSummary(plan, { findings, score }, gate), 'utf8');
        console.log('Job summary appended to $GITHUB_STEP_SUMMARY');
      }
      return gate.exitCode;
    } finally {
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
