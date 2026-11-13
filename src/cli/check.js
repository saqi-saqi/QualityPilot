/**
 * src/cli/check.js — CI gate.
 *
 * Usage:
 *   npx sqa-agent check <url> [--fail-on critical|high|medium|low|info|none|critical,high]
 *                          [--min-score <n>] [--junit <file>] [--sarif <file>]
 *                          [--format json|junit|sarif] [--json] [--strict]
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
 *   SQA_ALLOW_PRIVATE — allow localhost/private URLs (default: off)
 *   SQA_MAX_PAGES     — max pages to crawl (default: 10 for CI)
 *   SQA_MAX_DEPTH     — max crawl depth (default: 1 for CI)
 *   SQA_CI_TIMEOUT    — run timeout in ms (default: 120000)
 */

import { writeFile } from 'node:fs/promises';
import { toJUnitXml } from '../reporting/junit.js';
import { toSarif } from '../reporting/sarif.js';

const EXIT_OK = 0;
const EXIT_URL_MISSING = 64;
const EXIT_SCAN_FAILED = 70;
const EXIT_THRESHOLD_EXCEEDED = 1;

/** Severity ordering: lower index = more severe. */
const SEVERITY_RANK = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

const FAIL_ON_SINGLE_VALUES = ['info', 'low', 'medium', 'high', 'critical', 'none'];
const OUTPUT_FORMATS = ['text', 'json', 'junit', 'sarif'];

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

/** Parse command-line arguments. */
export function parseArgs(argv) {
  const args = argv.slice(2);
  const url = args.find((a) => !a.startsWith('--'));
  const opts = {
    failOn: 'none',
    failOnParsed: parseFailOn('none'),
    timeout: 120000,
    maxPages: 10,
    maxDepth: 1,
    minScore: null,
    junitPath: null,
    sarifPath: null,
    format: null,  // null → default human-readable summary
    json: false,
    strict: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--fail-on' || arg === '-f') {
      opts.failOn = args[++i] || 'none';
      opts.failOnParsed = parseFailOn(opts.failOn);
    } else if (arg === '--timeout' || arg === '-t') {
      opts.timeout = Number(args[++i]) || 120000;
    } else if (arg === '--max-pages' || arg === '-p') {
      opts.maxPages = Number(args[++i]) || 10;
    } else if (arg === '--max-depth' || arg === '-d') {
      opts.maxDepth = Number(args[++i]) || 1;
    } else if (arg === '--min-score') {
      const n = Number(args[++i]);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        throw new Error(`Invalid --min-score value: ${args[i]}. Must be a number between 0 and 100`);
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
    } else if (arg === '--strict') {
      opts.strict = true;
    }
  }

  if (!url) {
    throw new Error('Usage: npx sqa-agent check <url> [--fail-on critical|high|medium|low|info|none] [--min-score <n>] [--junit <file>] [--sarif <file>] [--format json|junit|sarif]');
  }

  return { url, ...opts };
}

/** Print a compact scan summary to stdout (CI-friendly). */
function printSummary({ url, score, findings, pages, compliance, json }) {
  console.log(`SQA Agent CI check`);
  console.log(`URL: ${url}`);
  console.log(`Pages: ${pages || 0} | Score: ${score || '?'}/100 | Findings: ${findings?.length || 0}`);

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
  return findings?.some((f) => (SEVERITY_RANK[f.severity] ?? 0) >= threshold);
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
async function runCheck({ url, timeout, maxPages, maxDepth }) {
  process.env.SQA_ALLOW_PRIVATE = process.env.SQA_ALLOW_PRIVATE || 'true';
  process.env.SQA_MAX_PAGES = process.env.SQA_MAX_PAGES || String(maxPages);
  process.env.SQA_MAX_DEPTH = process.env.SQA_MAX_DEPTH || String(maxDepth);

  const { createRunWithMatrix } = await import('../services/runManager.js');
  const { registerAllExecutors } = await import('../executors/index.js');
  const { registerLegacyChecks } = await import('../checks/index.js');

  registerAllExecutors();
  registerLegacyChecks();

  const { startRun } = await import('../matrix/runner.js');
  const { getRun } = await import('../services/runManager.js');

  const runId = await startRun({ url, options: { maxPages, maxDepth }, plan: null });
  console.log(`Scanning ${url} (run ${runId})...`);

  const deadline = Date.now() + timeout;
  let run;
  while (Date.now() < deadline) {
    run = await getRun(runId);
    if (run?.status === 'completed') break;
    if (run?.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!run) throw new Error('Run never completed within timeout');

  return run;
}

export async function checkMain(argv = process.argv) {
  try {
    const { url, failOn, timeout, maxPages, maxDepth, minScore, junitPath, sarifPath, format, json, strict } = parseArgs(argv);
    process.stdout.write(`SQA Agent CI check — ${url}\n`);

    const run = await runCheck({ url, timeout, maxPages, maxDepth });

    if (strict) {
      const { validateReport } = await import('../reporting/invariants.js');
      validateReport(run, { throwOnError: true });
    }
    const findings = run.findings || [];
    const compliance = await (async () => {
      try {
        const { computeCompliance } = await import('../services/compliance.js');
        return computeCompliance(run);
      } catch {
        return null;
      }
    })();

    // Write requested report artifacts (JUnit XML / SARIF JSON).
    await writeReportFiles(run, { junitPath, sarifPath });

    const outFormat = format || (json ? 'json' : 'text');
    if (outFormat === 'json') {
      const out = {
        url,
        runId: run.runId,
        score: run.score,
        status: run.status,
        findings,
        compliance,
        threshold: failOn,
        minScore,
        failed: evaluateGate({ findings, score: run.score, failOn, minScore }).failed,
        timestamp: new Date().toISOString(),
      };
      process.stdout.write(JSON.stringify(out, null, 2));
      process.stdout.write('\n');
    } else if (outFormat === 'junit') {
      process.stdout.write(toJUnitXml(run));
    } else if (outFormat === 'sarif') {
      process.stdout.write(JSON.stringify(toSarif(run), null, 2));
      process.stdout.write('\n');
    } else {
      printSummary({ url, score: run.score, findings, pages: run.pages?.length, compliance, json });
    }

    // CI gate: evaluate and print a one-line exit reason.
    const gate = evaluateGate({ findings, score: run.score, failOn, minScore });
    process.stdout.write(`${gate.reason}\n`);
    return gate.exitCode;
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.stderr.write(err.stack + '\n');
    return EXIT_SCAN_FAILED;
  }
}
