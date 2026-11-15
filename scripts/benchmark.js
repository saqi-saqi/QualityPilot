#!/usr/bin/env node
/**
 * scripts/benchmark.js — Phase 0 Performance & Determinism Benchmarking Suite
 *
 * Runs a full QualityPilot matrix scan N times (default: 10) against a target URL
 * and records:
 *   1. Flaky Test Rate (%) & Alternations across runs
 *   2. Mean & Distribution of Total Run Time (s)
 *   3. LLM Tokens Consumed (Prompt & Completion Tokens)
 *   4. Selector Fallback / Healing Rate (%)
 *
 * Saves full baseline results to:
 *   benchmark/results/<YYYY-MM-DD>-<target>-baseline.json
 */

import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const toFileUrl = (p) => pathToFileURL(p).href;

// Parse CLI flags
function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    target: 'fixture',
    runs: 10,
    maxPages: 10,
    maxDepth: 2,
    output: null,
    provider: process.env.SQA_LLM_PROVIDER || 'mock',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--runs' || arg === '-n') {
      opts.runs = parseInt(args[++i], 10) || 10;
    } else if (arg === '--target' || arg === '-t') {
      opts.target = args[++i];
    } else if (arg === '--max-pages' || arg === '-p') {
      opts.maxPages = parseInt(args[++i], 10) || 10;
    } else if (arg === '--output' || arg === '-o') {
      opts.output = args[++i];
    } else if (arg === '--provider') {
      opts.provider = args[++i];
    } else if (!arg.startsWith('-')) {
      opts.target = arg;
    }
  }
  return opts;
}

// Minimal LLM Token Instrumentation via provider wrapper
function createInstrumentedProvider(baseProvider) {
  const tokenStats = {
    callCount: 0,
    promptChars: 0,
    completionChars: 0,
    estimatedPromptTokens: 0,
    estimatedCompletionTokens: 0,
    exactPromptTokens: 0,
    exactCompletionTokens: 0,
    calls: [],
  };

  const instrumented = {
    name: `instrumented-${baseProvider.name || 'custom'}`,
    tokenStats,
    async chat(params) {
      tokenStats.callCount++;
      const systemLen = (params.system || '').length;
      const userLen = (params.user || '').length;
      const promptChars = systemLen + userLen;
      tokenStats.promptChars += promptChars;

      // ~4 chars per token approximation for natural text / code
      const estPrompt = Math.ceil(promptChars / 4);
      tokenStats.estimatedPromptTokens += estPrompt;

      const res = await baseProvider.chat(params);

      const completionChars = (res.content || '').length;
      tokenStats.completionChars += completionChars;
      const estComp = Math.ceil(completionChars / 4);
      tokenStats.estimatedCompletionTokens += estComp;

      // Capture exact tokens if provided by the underlying SDK / API
      if (res.usage?.prompt_tokens) {
        tokenStats.exactPromptTokens += res.usage.prompt_tokens;
      }
      if (res.usage?.completion_tokens) {
        tokenStats.exactCompletionTokens += res.usage.completion_tokens;
      }

      tokenStats.calls.push({
        systemLength: systemLen,
        userLength: userLen,
        completionLength: completionChars,
        estimatedPromptTokens: estPrompt,
        estimatedCompletionTokens: estComp,
        ok: res.ok,
      });

      return res;
    },
    reset() {
      tokenStats.callCount = 0;
      tokenStats.promptChars = 0;
      tokenStats.completionChars = 0;
      tokenStats.estimatedPromptTokens = 0;
      tokenStats.estimatedCompletionTokens = 0;
      tokenStats.exactPromptTokens = 0;
      tokenStats.exactCompletionTokens = 0;
      tokenStats.calls = [];
    },
  };

  return instrumented;
}

// Math helpers
function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stdDev(arr) {
  if (arr.length < 2) return 0;
  const avg = mean(arr);
  const variance = arr.reduce((acc, val) => acc + Math.pow(val - avg, 2), 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

async function main() {
  const opts = parseArgs(process.argv);
  process.env.SQA_ALLOW_PRIVATE = 'true';
  process.env.SQA_LLM_PROVIDER = opts.provider;

  console.log('='.repeat(70));
  console.log(`QualityPilot — Baseline Benchmark (Phase 0)`);
  console.log(`Target: ${opts.target} | Runs: ${opts.runs} | Max Pages: ${opts.maxPages}`);
  console.log(`LLM Provider: ${opts.provider}`);
  console.log('='.repeat(70));

  let fixtureServer = null;
  let targetUrl = opts.target;

  if (opts.target === 'fixture' || opts.target.startsWith('http://127.0.0.1:3000')) {
    const { startFixtureServer } = await import(toFileUrl(path.join(REPO_ROOT, 'test/fixtures/site/server.js')));
    const port = opts.target.includes(':3000') ? 3000 : 0;
    try {
      fixtureServer = await startFixtureServer(port);
      targetUrl = fixtureServer.url + '/';
      console.log(`Started local fixture server at: ${targetUrl}`);
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        console.log(`Port ${port} in use, launching on ephemeral port...`);
        fixtureServer = await startFixtureServer(0);
        targetUrl = fixtureServer.url + '/';
        console.log(`Started local fixture server at: ${targetUrl}`);
      } else {
        throw err;
      }
    }
  }

  // Register all matrix executors and legacy checks
  const { registerAllExecutors } = await import(toFileUrl(path.join(REPO_ROOT, 'src/executors/index.js')));
  const { registerLegacyChecks } = await import(toFileUrl(path.join(REPO_ROOT, 'src/checks/index.js')));
  registerAllExecutors();
  registerLegacyChecks();

  const { createRunWithMatrix, getRun } = await import(toFileUrl(path.join(REPO_ROOT, 'src/services/runManager.js')));
  const { getDefaultProvider, setDefaultProvider } = await import(toFileUrl(path.join(REPO_ROOT, 'src/explorer/llmProvider.js')));
  const { detectFlakyFromRuns } = await import(toFileUrl(path.join(REPO_ROOT, 'src/matrix/flakyTracker.js')));

  // Instrument LLM provider
  const originalProvider = getDefaultProvider();
  const instrumentedProvider = createInstrumentedProvider(originalProvider);
  setDefaultProvider(instrumentedProvider);

  const completedRuns = [];
  const runDurations = [];
  const runTokens = [];
  const runHealedSelectors = [];

  console.log(`\nExecuting ${opts.runs} consecutive runs...`);

  for (let i = 1; i <= opts.runs; i++) {
    process.stdout.write(`  Run ${String(i).padStart(2)}/${opts.runs}... `);
    instrumentedProvider.reset();

    const startTime = performance.now();
    const runId = await createRunWithMatrix({
      url: targetUrl,
      options: {
        maxPages: opts.maxPages,
        maxDepth: opts.maxDepth,
      },
    });

    // Wait for run completion
    let run = null;
    while (true) {
      run = await getRun(runId);
      if (run && (run.status === 'completed' || run.status === 'failed')) {
        break;
      }
      await new Promise(r => setTimeout(r, 250));
    }

    const durationMs = performance.now() - startTime;
    const durationSec = durationMs / 1000;
    runDurations.push(durationSec);

    // Collect selector healing events
    const healedEvents = (run.events || []).filter(e =>
      typeof e.message === 'string' && e.message.includes('selector self-healed:')
    );
    runHealedSelectors.push(healedEvents.length);

    // Collect LLM tokens for this run
    const tokensThisRun = {
      callCount: instrumentedProvider.tokenStats.callCount,
      estimatedPromptTokens: instrumentedProvider.tokenStats.estimatedPromptTokens,
      estimatedCompletionTokens: instrumentedProvider.tokenStats.estimatedCompletionTokens,
      totalTokens: instrumentedProvider.tokenStats.estimatedPromptTokens + instrumentedProvider.tokenStats.estimatedCompletionTokens,
      exactPromptTokens: instrumentedProvider.tokenStats.exactPromptTokens,
      exactCompletionTokens: instrumentedProvider.tokenStats.exactCompletionTokens,
    };
    runTokens.push(tokensThisRun);

    completedRuns.push(run);

    process.stdout.write(
      `done in ${durationSec.toFixed(2)}s | status: ${run.status} | findings: ${run.findings?.length || 0} | healed: ${healedEvents.length}\n`
    );
  }

  // Close fixture server if started
  if (fixtureServer) {
    await fixtureServer.close().catch(() => {});
  }

  // Restore original LLM provider
  setDefaultProvider(originalProvider);

  // ─── Metric 1: Flaky Rate & Alternations ───────────────────────────
  const flakyResults = detectFlakyFromRuns(completedRuns);

  // Compute total unique rules and alternations across the runs
  const allRuleIds = new Set();
  for (const r of completedRuns) {
    for (const f of r.findings || []) {
      if (f.ruleId) allRuleIds.add(f.ruleId);
    }
  }

  let totalFlips = 0;
  let totalPossibleFlips = 0;
  for (const ruleId of allRuleIds) {
    let lastOutcome = null;
    for (const r of completedRuns) {
      const hasRule = (r.findings || []).some(f => f.ruleId === ruleId);
      if (lastOutcome !== null) {
        totalPossibleFlips++;
        if (hasRule !== lastOutcome) totalFlips++;
      }
      lastOutcome = hasRule;
    }
  }

  const flakyRulesCount = flakyResults.length;
  const totalUniqueRules = allRuleIds.size;
  const flakyRuleRatePct = totalUniqueRules > 0 ? (flakyRulesCount / totalUniqueRules) * 100 : 0;
  const alternationRatePct = totalPossibleFlips > 0 ? (totalFlips / totalPossibleFlips) * 100 : 0;

  // ─── Metric 2: Run Time Distribution ──────────────────────────────
  const meanSec = mean(runDurations);
  const medianSec = median(runDurations);
  const minSec = Math.min(...runDurations);
  const maxSec = Math.max(...runDurations);
  const stdDevSec = stdDev(runDurations);

  // ─── Metric 3: LLM Tokens ─────────────────────────────────────────
  const totalPromptTokens = runTokens.reduce((s, t) => s + t.estimatedPromptTokens, 0);
  const totalCompletionTokens = runTokens.reduce((s, t) => s + t.estimatedCompletionTokens, 0);
  const totalTokens = totalPromptTokens + totalCompletionTokens;
  const meanTokensPerRun = mean(runTokens.map(t => t.totalTokens));

  // ─── Metric 4: Selector Fallback / Healing Rate ────────────────────
  const totalHeals = runHealedSelectors.reduce((a, b) => a + b, 0);
  let totalFlowStepsAttempted = 0;
  for (const r of completedRuns) {
    for (const flow of r.plan?.flows || []) {
      totalFlowStepsAttempted += (flow.steps || []).length;
    }
  }
  const selectorFallbackRatePct = totalFlowStepsAttempted > 0
    ? (totalHeals / totalFlowStepsAttempted) * 100
    : 0;

  // Compile final benchmark report
  const targetTag = opts.target === 'fixture' ? 'target-a-fixture' : 'target-custom';
  const dateStr = new Date().toISOString().split('T')[0];
  const outFileName = opts.output || `${dateStr}-${targetTag}-baseline.json`;
  const outPath = path.isAbsolute(outFileName)
    ? outFileName
    : path.resolve(REPO_ROOT, outFileName.includes('benchmark') ? outFileName : path.join('benchmark', 'results', outFileName));
  const outDir = path.dirname(outPath);

  const benchmarkReport = {
    generatedAt: new Date().toISOString(),
    benchmarkTarget: opts.target,
    resolvedTargetUrl: targetUrl,
    totalRuns: opts.runs,
    options: {
      maxPages: opts.maxPages,
      maxDepth: opts.maxDepth,
      llmProvider: opts.provider,
    },
    metrics: {
      flakyRate: {
        flakyRulesDetected: flakyRulesCount,
        totalUniqueRulesObserved: totalUniqueRules,
        flakyRulesRatePct: Number(flakyRuleRatePct.toFixed(2)),
        alternationCount: totalFlips,
        totalPossibleAlternations: totalPossibleFlips,
        alternationRatePct: Number(alternationRatePct.toFixed(2)),
        flakyFindingsList: flakyResults,
      },
      runTime: {
        unit: 'seconds',
        mean: Number(meanSec.toFixed(3)),
        median: Number(medianSec.toFixed(3)),
        min: Number(minSec.toFixed(3)),
        max: Number(maxSec.toFixed(3)),
        stdDev: Number(stdDevSec.toFixed(3)),
        rawValues: runDurations.map(d => Number(d.toFixed(3))),
      },
      llmTokens: {
        provider: opts.provider,
        instrumentationMethod: 'In-memory provider wrapper via setDefaultProvider(); existing SQLite logging does not record tokens.',
        totalPromptTokens,
        totalCompletionTokens,
        totalTokens,
        meanTokensPerRun: Number(meanTokensPerRun.toFixed(1)),
        runsTokenSummary: runTokens,
      },
      selectorFallback: {
        totalSelectorsHealed: totalHeals,
        totalFlowStepsAttempted,
        selectorFallbackRatePct: Number(selectorFallbackRatePct.toFixed(2)),
      },
    },
    runsSummary: completedRuns.map((r, idx) => ({
      runIndex: idx + 1,
      runId: r.runId,
      status: r.status,
      durationSec: Number(runDurations[idx].toFixed(3)),
      score: r.score,
      findingsCount: r.findings?.length || 0,
      pagesScanned: r.pages?.length || 0,
      healedSelectors: runHealedSelectors[idx],
      tokens: runTokens[idx],
    })),
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(outPath, JSON.stringify(benchmarkReport, null, 2), 'utf-8');

  // Also mirror to root benchmark/results if running from parent
  const rootOutDir = path.resolve(REPO_ROOT, '..', 'benchmark', 'results');
  try {
    await mkdir(rootOutDir, { recursive: true });
    await writeFile(path.join(rootOutDir, path.basename(outPath)), JSON.stringify(benchmarkReport, null, 2), 'utf-8');
  } catch { /* optional mirror */ }

  console.log('\n' + '='.repeat(70));
  console.log('BASELINE BENCHMARK SUMMARY (TARGET A)');
  console.log('='.repeat(70));
  console.log(`Runs Completed:                 ${opts.runs}`);
  console.log(`Mean Run Time:                  ${meanSec.toFixed(2)}s (std dev: ${stdDevSec.toFixed(2)}s)`);
  console.log(`Run Time Range:                 ${minSec.toFixed(2)}s – ${maxSec.toFixed(2)}s`);
  console.log(`Flaky Rules Detected:           ${flakyRulesCount} of ${totalUniqueRules} (${flakyRuleRatePct.toFixed(1)}%)`);
  console.log(`Alternation Rate:               ${alternationRatePct.toFixed(1)}% (${totalFlips} flips / ${totalPossibleFlips} opportunities)`);
  console.log(`LLM Tokens Consumed:            ${totalTokens} total (${meanTokensPerRun.toFixed(0)} avg/run) [Provider: ${opts.provider}]`);
  console.log(`Selector Fallback / Heals:      ${totalHeals} heals / ${totalFlowStepsAttempted} steps (${selectorFallbackRatePct.toFixed(1)}%)`);
  console.log(`Results Saved To:               ${outPath}`);
  console.log('='.repeat(70));
}

main().catch(err => {
  console.error('\nBenchmark failed:', err);
  process.exit(1);
});
