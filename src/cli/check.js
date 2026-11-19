/**
 * src/cli/check.js — CI gate.
 *
 * Usage:
 *   qualitypilot check <url> [--fail-on critical|high|medium|low|info|none|critical,high]
 *                          [--min-score <n>] [--junit <file>] [--sarif <file>]
 *                          [--baseline <file|runId>]
 *                          [--format json|junit|sarif|markdown] [--json] [--strict]
 *
 *   --baseline <file|runId>  compare against a previous run: --fail-on then
 *                            applies to NEW findings only (regressions). The
 *                            baseline may be a JSON report from `--format json`
 *                            or a stored run id. Unreadable baselines exit 64.
 *   --concurrency <n>        matrix cells run in parallel (1–4, default 2).
 *                            Browser cells share one browser process via the
 *                            pool; no-browser cells fully parallelize.
 *
 * Runs a bounded scan of the given URL and exits non-zero if the gate fails:
 *   --fail-on <severities>  a single severity acts as a threshold ("at or above");
 *                           a comma list (e.g. critical,high) fails when any
 *                           CONFIRMED finding at exactly those severities exists.
 *   --min-score <n>         fails when the run score is below n.
 *   --junit <file>          writes a JUnit XML report for the CI test-result parser.
 *   --sarif <file>          writes a SARIF 2.1.0 JSON report for code scanning.
 *   --format <fmt>          stdout output format: json | junit | sarif
 *                           (default keeps the human-readable summary).
 *
 * Designed for CI/CD: quick, non-interactive, exit-code driven, and logged
 * for the CI system to parse. Exit codes: 0 pass, 1 gate failed, 64 usage,
 * 70 scan failure.
 *
 * Environment:
 *   SQA_ALLOW_PRIVATE — allow localhost/private URLs (default: off; or pass --allow-private)
 *   SQA_MAX_PAGES     — max pages to crawl (default: 10 for CI)
 *   SQA_MAX_DEPTH     — max crawl depth (default: 1 for CI)
 *   SQA_CI_TIMEOUT    — run timeout in ms (default: 120000)
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { toJUnitXml } from '../reporting/junit.js';
import { toSarif } from '../reporting/sarif.js';
import { toMarkdown } from '../reporting/markdown.js';
import { diffRuns } from '../services/runDiff.js';
import { parseWaiverFile, applyWaivers } from '../services/waivers.js';
import { extractJsonDocument, decodeCapturedOutput } from '../utils/jsonDocument.js';

const EXIT_OK = 0;
const EXIT_URL_MISSING = 64;
const EXIT_SCAN_FAILED = 70;
const EXIT_THRESHOLD_EXCEEDED = 1;

/** Severity ordering: lower index = more severe. */
const SEVERITY_RANK = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

const FAIL_ON_SINGLE_VALUES = ['info', 'low', 'medium', 'high', 'critical', 'none'];
const OUTPUT_FORMATS = ['text', 'json', 'junit', 'sarif', 'markdown'];

/**
 * Flags understood by `check`. Anything else is a usage error — a typo like
 * `--failon` used to be silently ignored, which ran the gate with defaults
 * and could turn a failing build green.
 */
const KNOWN_FLAGS = new Set([
  '--fail-on', '-f', '--timeout', '-t', '--max-pages', '-p', '--max-depth', '-d',
  '--min-score', '--junit', '--sarif', '--format', '--json', '--strict',
  '--baseline', '--concurrency', '--authorized-target', '--openapi',
  '--ignore-file', '--login', '--allow-private',
]);

const CHECK_USAGE = 'Usage: qualitypilot check <url> [--fail-on critical|high|medium|low|info|none] [--min-score <n>] [--junit <file>] [--sarif <file>] [--baseline <file|runId>] [--ignore-file <file>] [--concurrency <1-4>] [--allow-private] [--format json|junit|sarif|markdown]';

/**
 * Parse a --fail-on value: a single severity/none (threshold mode) or a
 * comma-separated list of severities (list mode → confirmed findings only).
 */
function parseFailOn(raw) {
  const value = String(raw || 'none');
  if (value.includes(',')) {
    const severities = value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (severities.length === 0) {
      throw new Error(`Invalid --fail-on value: ${value}. Must be one of: ${FAIL_ON_SINGLE_VALUES.join(', ')} or a comma list like critical,high`);
    }
    for (const s of severities) {
      if (!SEVERITY_RANK.hasOwnProperty(s)) {
        throw new Error(`Invalid --fail-on severity: ${s}. Must be one of: info, low, medium, high, critical`);
      }
    }
    return { mode: 'list', severities };
  }
  if (!FAIL_ON_SINGLE_VALUES.includes(value)) {
    throw new Error(`Invalid --fail-on value: ${value}. Must be one of: ${FAIL_ON_SINGLE_VALUES.join(', ')} or a comma list like critical,high`);
  }
  return { mode: 'threshold', value };
}

/** Parse command-line arguments. The target URL is the single positional.
 *
 * Flag VALUES do not start with `--`, so the URL cannot be found by scanning
 * for the first non-flag token: `check --fail-on high <url>` used to take
 * "high" as the URL. Positional arguments are collected while every flag
 * consumes its own value, and flags may legally precede the URL.
 */
export function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    failOn: 'none',
    failOnParsed: parseFailOn('none'),
    timeout: 120000,
    concurrency: 2,
    maxPages: 10,
    maxDepth: 1,
    minScore: null,
    junitPath: null,
    sarifPath: null,
    format: null,  // null → default human-readable summary
    json: false,
    strict: false,
    baseline: null,
    authorizedTarget: false,
    openapi: null,
    loginRecording: null,
    ignoreFile: null,
    allowPrivate: false,
  };
  const positionals = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const isFlag = arg.startsWith('-') && arg.length > 1;
    if (!isFlag) {
      positionals.push(arg);
      continue;
    }
    if (!KNOWN_FLAGS.has(arg)) {
      throw new Error(`Unknown option: ${arg} — run "qualitypilot check" with no arguments for usage`);
    }
    if (arg === '--fail-on' || arg === '-f') {
      opts.failOn = args[++i] || 'none';
      opts.failOnParsed = parseFailOn(opts.failOn);
    } else if (arg === '--timeout' || arg === '-t') {
      const raw = args[++i];
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`Invalid --timeout value: ${raw}. Must be a positive number of milliseconds`);
      }
      opts.timeout = n;
    } else if (arg === '--max-pages' || arg === '-p') {
      const raw = args[++i];
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 1) {
        throw new Error(`Invalid --max-pages value: ${raw}. Must be a number >= 1`);
      }
      opts.maxPages = n;
    } else if (arg === '--max-depth' || arg === '-d') {
      const raw = args[++i];
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`Invalid --max-depth value: ${raw}. Must be a number >= 0`);
      }
      opts.maxDepth = n;
    } else if (arg === '--min-score') {
      const raw = args[++i];
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        throw new Error(`Invalid --min-score value: ${raw}. Must be a number between 0 and 100`);
      }
      opts.minScore = n;
    } else if (arg === '--junit') {
      opts.junitPath = args[++i];
      if (!opts.junitPath) throw new Error('--junit requires a file path');
    } else if (arg === '--sarif') {
      opts.sarifPath = args[++i];
      if (!opts.sarifPath) throw new Error('--sarif requires a file path');
    } else if (arg === '--format') {
      const fmt = String(args[++i] || '').toLowerCase();
      if (!OUTPUT_FORMATS.includes(fmt)) {
        throw new Error(`Invalid --format value: ${fmt}. Must be one of: ${OUTPUT_FORMATS.join(', ')}`);
      }
      opts.format = fmt;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--baseline') {
      opts.baseline = args[++i];
      if (!opts.baseline) throw new Error('--baseline requires a file path or a run id');
    } else if (arg === '--concurrency') {
      const n = Number(args[++i]);
      if (!Number.isFinite(n) || n < 1 || n > 4) {
        throw new Error('Invalid --concurrency value: must be a number between 1 and 4');
      }
      opts.concurrency = n;
    } else if (arg === '--authorized-target') {
      // Phase 8: authorizes ACTIVE injection probing (differential SQLi, DOM
      // XSS sink probes) on NON-loopback targets. Loopback targets are probed
      // by default. Deliberately does NOT enable API-fuzz mutations — that
      // stays behind the dashboard/API `--active-testing` combination.
      opts.authorizedTarget = true;
    } else if (arg === '--openapi') {
      opts.openapi = args[++i];
      if (!opts.openapi) throw new Error('--openapi requires a spec file path');
    } else if (arg === '--ignore-file') {
      opts.ignoreFile = args[++i];
      if (!opts.ignoreFile) throw new Error('--ignore-file requires a waiver file path');
    } else if (arg === '--login') {
      opts.loginRecording = args[++i];
      if (!opts.loginRecording) throw new Error('--login requires a recorded session name');
    } else if (arg === '--allow-private') {
      // Explicit opt-in to the developer-only private-target switch — the
      // same effect as SQA_ALLOW_PRIVATE=true, without editing the env.
      // Without it (and without the env var) the SSRF boundary stays on.
      opts.allowPrivate = true;
    } else if (arg === '--strict') {
      opts.strict = true;
    }
  }

  if (positionals.length === 0) {
    throw new Error(CHECK_USAGE);
  }
  if (positionals.length > 1) {
    throw new Error(`Unexpected argument: ${positionals[1]} — the target URL must be given exactly once (flags may precede it)`);
  }

  return { url: positionals[0], ...opts };
}

/** One-decimal normalization for scores as they cross a serialization boundary.
 *  The scorer keeps full precision (tests pin exact scaling); this only stops
 *  float noise like 5.800000000000011 from reaching machine output. */
function roundScore(score) {
  const n = Number(score);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : score;
}

/** Print a compact scan summary to stdout (CI-friendly). */
function printSummary({ url, score, findings, pages, compliance, json, diff }) {
  console.log(`QualityPilot CI check`);
  console.log(`URL: ${url}`);
  console.log(`Pages: ${pages || 0} | Score: ${score == null ? '?' : roundScore(score)}/100 | Findings: ${findings?.length || 0}`);
  if (diff) console.log(`Baseline ${diff.baselineRunId}: ${diff.summary}`);

  if (compliance) {
    console.log(`WCAG: ${compliance.conformancePct || '?'}% checked | ` +
                 `blocked: ${compliance.blockers?.length || 0}`);
  }

  if (findings?.length) {
    const bySeverity = {};
    for (const f of findings) {
      bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
    }
    console.log('Findings by severity: ' + Object.entries(bySeverity)
      .map(([s, c]) => `${s}=${c}`)
      .join(', '));

    if (!json) {
      for (const f of findings.slice(0, 20)) {
        console.log(`  [${f.severity}] ${f.title} (${f.pageUrl || '—'})`);
      }
      if (findings.length > 20) {
        console.log(`  ... and ${findings.length - 20} more`);
      }
    }
  }
}

/**
 * Determine whether to fail given findings and the fail-on setting.
 * Single severity → threshold semantics ("at or above", regardless of
 * confidence); comma list → handled by evaluateGate (confirmed findings only).
 */
export function shouldFail(findings, failOn) {
  const value = String(failOn || 'none');
  if (value === 'none') return false;
  if (value.includes(',')) {
    return evaluateGate({ findings, failOn: value }).failed;
  }
  const threshold = SEVERITY_RANK[value];
  if (threshold === undefined) return false;
  // Phase 0 Fix E3: environmental findings (timeouts / DNS / connection failures
  // that the executors classify suspected+environmental) are not app defects and
  // must not break a threshold gate on their own. List mode already counts only
  // confirmed findings via evaluateGate, so it is unchanged.
  return findings
    ?.filter((f) => f.findingType !== 'environmental')
    .some((f) => (SEVERITY_RANK[f.severity] ?? 0) >= threshold);
}

/**
 * Evaluate the CI gate against a finished run.
 *
 * @param {object} p
 * @param {Array}  p.findings — run findings
 * @param {number} [p.score]  — run score (0–100)
 * @param {string} [p.failOn] — single severity (threshold) or comma list
 * @param {number} [p.minScore]
 * @returns {{failed:boolean, exitCode:number, reason:string}} — reason is a
 *          one-line summary explaining the exit.
 */
export function evaluateGate({ findings = [], score, failOn = 'none', minScore = null } = {}) {
  const parsed = parseFailOn(failOn);

  if (parsed.mode === 'list') {
    const severities = parsed.severities;
    // List mode: only CONFIRMED findings count as gate breakers.
    const isConfirmed = (f) => f.confidence == null || f.confidence === 'confirmed';
    const hits = findings.filter((f) =>
      severities.includes(String(f.severity || '').toLowerCase()) && isConfirmed(f)
    );
    if (hits.length > 0) {
      return {
        failed: true,
        exitCode: EXIT_THRESHOLD_EXCEEDED,
        reason: `FAIL: ${hits.length} confirmed finding(s) at severity ${severities.join(', ')}`,
      };
    }
  } else if (parsed.value !== 'none') {
    if (shouldFail(findings, parsed.value)) {
      return {
        failed: true,
        exitCode: EXIT_THRESHOLD_EXCEEDED,
        reason: `FAIL: findings at or above ${parsed.value} severity threshold`,
      };
    }
  }

  if (minScore != null && Number.isFinite(Number(minScore))) {
    const min = Number(minScore);
    const effective = (score == null || Number.isNaN(Number(score))) ? 0 : Number(score);
    if (effective < min) {
      return {
        failed: true,
        exitCode: EXIT_THRESHOLD_EXCEEDED,
        reason: `FAIL: score ${effective} is below the minimum ${min}`,
      };
    }
  }

  return {
    failed: false,
    exitCode: EXIT_OK,
    reason: `PASS: gate satisfied (fail-on: ${failOn || 'none'}, min-score: ${minScore ?? 'none'}, score: ${score ?? '?'})`,
  };
}

/**
 * Load a baseline run for --baseline diffing.
 * Accepts a JSON report file (from `--format json`), a run record JSON, or a
 * stored run id. Throws on anything unreadable — the caller maps that to
 * exit 64 (usage), never a silent pass.
 */
export async function loadBaselineRun(spec) {
  const value = String(spec || '').trim();
  if (!value) return null;

  let data = null;
  if (existsSync(value)) {
    let raw;
    try {
      // Buffer + decodeCapturedOutput: baselines may be UTF-8, UTF-8-with-BOM
      // or UTF-16LE (PowerShell `>` redirection), possibly with log noise
      // around the JSON document (pre-Phase-6 captures).
      raw = decodeCapturedOutput(await readFile(value));
    } catch (err) {
      throw new Error(`Baseline file unreadable: ${err.message}`);
    }
    try {
      data = JSON.parse(raw);
    } catch {
      // Tolerate baselines captured the old way: `--format json` output used
      // to mix progress lines into stdout, so redirected files contain log
      // noise around the JSON document. Extract the document instead.
      try {
        data = extractJsonDocument(raw);
      } catch {
        throw new Error(`Baseline file is not valid JSON: ${value}`);
      }
    }
  } else {
    const { getRun } = await import('../services/runManager.js');
    data = await getRun(value);
    if (!data) throw new Error(`Baseline not found: no file at \"${value}\" and no run with that id`);
  }

  if (!data || !Array.isArray(data.findings)) {
    throw new Error(`Baseline has no findings array: ${value}`);
  }
  return data;
}

/**
 * Gate evaluation with an optional baseline diff: when a diff is present,
 * --fail-on applies to NEW findings only (regressions). --min-score stays an
 * absolute check on the current run's score.
 */
export function evaluateBaselineGate({ findings = [], score, failOn = 'none', minScore = null, diff = null } = {}) {
  const gateFindings = diff ? diff.newFindings : findings;
  const gate = evaluateGate({ findings: gateFindings, score, failOn, minScore });
  let reason = gate.reason;
  if (diff) {
    const baselineLabel = diff.baselineRunId || 'baseline';
    reason = (gate.failed && diff.newFindings.length > 0)
      ? `FAIL: ${diff.newFindings.length} new finding(s) vs baseline ${baselineLabel} (${diff.summary})`
      : `${gate.reason} · baseline ${baselineLabel}: ${diff.summary}`;
  }
  return { ...gate, reason };
}

/**
 * Write the JUnit/SARIF report artifacts requested on the command line.
 * Exported for tests; skips formats that were not requested.
 */
export async function writeReportFiles(run, { junitPath, sarifPath } = {}) {
  const written = [];
  if (junitPath) {
    await writeFile(junitPath, toJUnitXml(run), 'utf8');
    written.push(junitPath);
  }
  if (sarifPath) {
    await writeFile(sarifPath, JSON.stringify(toSarif(run), null, 2) + '\n', 'utf8');
    written.push(sarifPath);
  }
  return written;
}

/** Run a bounded scan of the URL using the matrix. */
async function runCheck({ url, timeout, maxPages, maxDepth, concurrency, authorizedTarget, openapiSpec, loginRecording, allowPrivate }) {
  // The SSRF boundary is ON by default, exactly as documented. The operator
  // opts in per invocation (--allow-private) or via the environment
  // (SQA_ALLOW_PRIVATE=true). This used to be forced on unconditionally,
  // which silently disabled the boundary for every CLI scan (audit H-2).
  if (allowPrivate) {
    process.env.SQA_ALLOW_PRIVATE = process.env.SQA_ALLOW_PRIVATE || 'true';
  }
  process.env.SQA_MAX_PAGES = process.env.SQA_MAX_PAGES || String(maxPages);
  process.env.SQA_MAX_DEPTH = process.env.SQA_MAX_DEPTH || String(maxDepth);

  const { registerAllExecutors } = await import('../executors/index.js');
  const { registerLegacyChecks } = await import('../checks/index.js');
  registerAllExecutors();
  registerLegacyChecks();

  // The run manager owns the whole pipeline: createRun validates the URL
  // (SSRF), enqueues the job and starts the in-process queue worker; the CLI
  // then polls getRun() until the run reaches a terminal status. The old
  // code imported a nonexistent '../matrix/runner.js' startRun API, so the
  // CLI could never scan anything (dormant-entry finding, 2026-11-14).
  //
  // 2026-11-16 (recall-benchmark finding): createRun() is the LEGACY pipeline
  // — it executes only run.options.checks, and the CLI passes none, so every
  // `qualitypilot check` run crawled the site, ran ZERO detectors and reported
  // score 100 with zero findings (5 verifiably-missing security headers on
  // Juice Shop, 0 reported). Route the CI gate through the matrix path, which
  // crawls → builds an explorer plan → runs the plan's executors → dedups →
  // scores. createRunWithMatrix validates the URL up front, same as createRun.
  const { createRunWithMatrix, getRun, cancelRun } = await import('../services/runManager.js');

  const runId = await createRunWithMatrix({ url, options: { maxPages, maxDepth, concurrency, authorizedTarget, openapiSpec, loginRecording } });
  process.stderr.write(`Scanning ${url} (run ${runId})...\n`);

  const deadline = Date.now() + timeout;
  let run;
  while (Date.now() < deadline) {
    run = await getRun(runId);
    if (run?.status === 'completed') break;
    if (run?.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!run) throw new Error('Run never completed within timeout');

  // Deadline expired while the run was still in flight: cancel it and fail
  // the CLI (exit 70). Previously the in-flight run was returned and printed
  // as if it were a finished report — status:"running", score:null,
  // findings:[] — a scan that "found nothing" because it stopped before the
  // matrix finished (2026-11-16 Juice Shop verification scan).
  if (run.status !== 'completed' && run.status !== 'failed') {
    try { await cancelRun(runId); } catch { /* best effort — CLI exits next */ }
    throw new Error(`Run did not finish within ${timeout}ms (last status: ${run.status}) — increase --timeout or reduce --max-pages/--max-depth`);
  }

  return run;
}

export async function checkMain(argv = process.argv) {
  let parsedArgs;
  try {
    parsedArgs = parseArgs(argv);
  } catch (err) {
    // Argument/usage errors use the documented exit code 64 (usage), not 70
    // (scan failure) — verified by the CLI entry-point regression test.
    console.error(`ERROR: ${err.message}`);
    return EXIT_URL_MISSING;
  }
  try {
    const { url, failOn, timeout, maxPages, maxDepth, minScore, junitPath, sarifPath, format, json, strict, baseline, concurrency, authorizedTarget, openapi, loginRecording, ignoreFile, allowPrivate } = parsedArgs;

    // Phase 9: parse the OpenAPI spec at CLI time — unreadable specs are
    // usage errors (exit 64), not silent run failures.
    let openapiSpec = null;
    if (openapi) {
      try {
        const { parseOpenApiSpecText } = await import('../services/openapiImport.js');
        openapiSpec = parseOpenApiSpecText(await readFile(openapi, 'utf8'));
      } catch (err) {
        console.error(`ERROR: ${err.message}`);
        return EXIT_URL_MISSING;
      }
    }
    // Machine formats (json/junit/sarif/markdown) keep stdout PURE — progress
    // lines and the gate reason go to stderr, so `check --format json > out.json`
    // produces a file that is directly machine-readable (Phase 6 `--baseline`
    // reads these files). Text mode keeps the historical stdout layout.
    const outFormat = format || (json ? 'json' : 'text');
    const machineOutput = outFormat !== 'text';
    const progress = machineOutput ? process.stderr : process.stdout;
    progress.write(`QualityPilot CI check — ${url}\n`);

    const run = await runCheck({ url, timeout, maxPages, maxDepth, concurrency, authorizedTarget, openapiSpec, loginRecording, allowPrivate });

    // A failed scan must never exit 0: without this check a broken scan
    // (e.g. Playwright browsers not installed, target unreachable) reported
    // "PASS: gate satisfied" and exit code 0 in CI. The run record carries
    // the underlying reason — surface it verbatim (first-run finding,
    // 2026-11-14: missing Playwright browsers exited 0).
    if (run.status === 'failed') {
      console.error(`ERROR: scan failed — ${run.error || 'unknown error (see run events)'}`);
      return EXIT_SCAN_FAILED;
    }

    if (strict) {
      const { validateReport } = await import('../reporting/invariants.js');
      validateReport(run, { throwOnError: true });
    }
    const findings = run.findings || [];

    // Waivers (Phase 10): suppressed findings stay in the report (annotated)
    // but do not fail the gate. Expired waivers warn loudly and surface the
    // finding again.
    let waiverResult = null;
    let effectiveFindings = findings;
    if (ignoreFile) {
      try {
        const waiverText = decodeCapturedOutput(await readFile(ignoreFile));
        const { waivers } = parseWaiverFile(waiverText);
        waiverResult = applyWaivers(findings, waivers);
        effectiveFindings = waiverResult.kept;
        for (const f of waiverResult.waived) f.waived = true;
        for (const w of waiverResult.warnings) console.error(w);
      } catch (err) {
        console.error(`ERROR: ${err.message}`);
        return EXIT_URL_MISSING; // 64 — a broken waiver file is a usage error
      }
    }

    const compliance = await (async () => {
      try {
        const { computeCompliance } = await import('../services/compliance.js');
        return computeCompliance(run);
      } catch {
        return null;
      }
    })();

    // Baseline diff (Phase 6): --fail-on applies to NEW findings only.
    let diff = null;
    if (baseline) {
      let baselineRun;
      try {
        baselineRun = await loadBaselineRun(baseline);
      } catch (err) {
        console.error(`ERROR: ${err.message}`);
        return EXIT_URL_MISSING; // 64 — a bad baseline is a usage error, never a silent pass
      }
      diff = diffRuns(baselineRun, { ...run, findings: effectiveFindings });
      diff.baselineRunId = baselineRun.runId || String(baseline);
    }

    // CI gate: evaluate BEFORE output so json/markdown carry the verdict.
    const gate = evaluateBaselineGate({ findings: effectiveFindings, score: run.score, failOn, minScore, diff });

    // Write requested report artifacts (JUnit XML / SARIF JSON).
    await writeReportFiles(run, { junitPath, sarifPath });

    if (outFormat === 'json') {
      const out = {
        url,
        runId: run.runId,
        score: roundScore(run.score),
        status: run.status,
        findings,
        ...(diff ? {
          baseline: {
            runId: diff.baselineRunId,
            summary: diff.summary,
            scoreDelta: diff.scoreDelta,
            newFindings: diff.newFindings,
            resolvedFindings: diff.resolvedFindings,
            persistentCount: diff.persistentFindings.length,
          },
        } : {}),
        ...(waiverResult ? { waivedCount: waiverResult.waived.length } : {}),
        compliance,
        threshold: failOn,
        minScore,
        failed: gate.failed,
        timestamp: new Date().toISOString(),
      };
      process.stdout.write(JSON.stringify(out, null, 2));
      process.stdout.write('\n');
    } else if (outFormat === 'junit') {
      process.stdout.write(toJUnitXml(run));
    } else if (outFormat === 'sarif') {
      process.stdout.write(JSON.stringify(toSarif(run), null, 2));
      process.stdout.write('\n');
    } else if (outFormat === 'markdown') {
      process.stdout.write(toMarkdown(run, { diff, gate }));
    } else {
      printSummary({ url, score: run.score, findings, pages: run.pages?.length, compliance, json, diff });
    }

    const waiverNote = waiverResult && waiverResult.waived.length > 0
      ? ` · waivers: ${waiverResult.waived.length} suppressed (--min-score still uses the unwaived run score)`
      : '';
    (machineOutput ? process.stderr : process.stdout).write(`${gate.reason}${waiverNote}\n`);
    return gate.exitCode;
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.stderr.write(err.stack + '\n');
    return EXIT_SCAN_FAILED;
  }
}

// ─── direct CLI entry ────────────────────────────────────────────────
// `node src/cli/check.js <url> …` (and the package.json "check" script) must
// actually execute the scan. Before this block the module only exported its
// helpers and exited 0 without doing anything — the documented CLI usage
// never ran at all (found by the 2026-11-14 Juice Shop smoke run).
// pathToFileURL is required for the comparison to work on Windows paths.
const invokedDirectly = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  // exitCode (not exit) so stdout drains fully; the scan closes its own handles.
  checkMain(process.argv)
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(err);
      process.exitCode = EXIT_SCAN_FAILED;
    });
}
