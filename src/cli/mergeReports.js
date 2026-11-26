/**
 * src/cli/mergeReports.js — `testigator merge-reports <shard1.json> <shard2.json> ...`
 *
 * Unifies shard JSON reports produced by `--shard i/N` (`check` or `replay`)
 * into a single deduplicated findings set, coverage computation, score,
 * optional baseline diff + waivers, JUnit/SARIF/HTML/Markdown exports, and one
 * consistent CI gate verdict.
 *
 * Exit codes mirror `check` and `replay`:
 *   0 = PASS, 1 = gate violated, 64 = usage/input error, 70 = shard failure
 */
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadBaselineRun, evaluateBaselineGate, writeReportFiles } from './check.js';
import { mergeShardReports } from '../matrix/sharding.js';
import { parseWaiverFile, applyWaivers } from '../services/waivers.js';
import { diffRuns } from '../services/runDiff.js';
import { toJUnitXml } from '../reporting/junit.js';
import { toSarif } from '../reporting/sarif.js';
import { toHtml } from '../reporting/html.js';
import { toMarkdown } from '../reporting/markdown.js';
import { decodeCapturedOutput } from '../utils/jsonDocument.js';

const EXIT_OK = 0;
const EXIT_THRESHOLD = 1;
const EXIT_USAGE = 64;
const EXIT_FAILURE = 70;

const OUTPUT_FORMATS = ['text', 'json', 'junit', 'sarif', 'markdown'];

export function parseMergeArgs(argv) {
  const args = argv.slice(2);
  const files = [];
  const opts = {
    expectShards: null,
    failOn: 'none',
    minScore: null,
    baseline: null,
    ignoreFile: null,
    junitPath: null,
    sarifPath: null,
    htmlPath: null,
    markdownPath: null,
    outPath: null,
    format: 'text',
    strict: false,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) {
      files.push(a);
      continue;
    }
    if (a === '--expect-shards') {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error('Invalid --expect-shards value: must be a positive integer');
      opts.expectShards = n;
    } else if (a === '--fail-on' || a === '-f') {
      opts.failOn = args[++i] || 'none';
    } else if (a === '--min-score') {
      const n = Number(args[++i]);
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error('Invalid --min-score value: must be 0..100');
      opts.minScore = n;
    } else if (a === '--baseline') {
      opts.baseline = args[++i];
      if (!opts.baseline) throw new Error('--baseline requires a file path or run id');
    } else if (a === '--ignore-file') {
      opts.ignoreFile = args[++i];
      if (!opts.ignoreFile) throw new Error('--ignore-file requires a waiver file path');
    } else if (a === '--junit') {
      opts.junitPath = args[++i];
      if (!opts.junitPath) throw new Error('--junit requires an output path');
    } else if (a === '--sarif') {
      opts.sarifPath = args[++i];
      if (!opts.sarifPath) throw new Error('--sarif requires an output path');
    } else if (a === '--html') {
      opts.htmlPath = args[++i];
      if (!opts.htmlPath) throw new Error('--html requires an output path');
    } else if (a === '--markdown') {
      opts.markdownPath = args[++i];
      if (!opts.markdownPath) throw new Error('--markdown requires an output path');
    } else if (a === '--out' || a === '-o') {
      opts.outPath = args[++i];
      if (!opts.outPath) throw new Error('--out requires an output file path');
    } else if (a === '--format') {
      const fmt = String(args[++i] || '').toLowerCase();
      if (!OUTPUT_FORMATS.includes(fmt)) {
        throw new Error(`Invalid --format value: ${fmt}. Must be one of: ${OUTPUT_FORMATS.join(', ')}`);
      }
      opts.format = fmt;
    } else if (a === '--json') {
      opts.format = 'json';
    } else if (a === '--strict') {
      opts.strict = true;
    } else {
      throw new Error(`Unknown option: ${a}`);
    }
  }

  if (files.length === 0) {
    throw new Error('Usage: testigator merge-reports <shard1.json> <shard2.json> [...] [--expect-shards <N>] [--fail-on <sev|list>] [--min-score <n>] [--baseline <file>] [--ignore-file <file>] [--junit <file>] [--sarif <file>] [--html <file>] [--markdown <file>] [--out <file>] [--format text|json|junit|sarif|markdown]');
  }

  return { files, ...opts };
}

export async function mergeReportsMain(argv = process.argv) {
  let opts;
  try {
    opts = parseMergeArgs(argv);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    return EXIT_USAGE;
  }

  try {
    const reports = [];
    for (const file of opts.files) {
      reports.push(await loadBaselineRun(file));
    }

    const merged = mergeShardReports(reports, { expectShards: opts.expectShards });
    if (merged.status === 'failed') {
      console.error(`ERROR: merged shard run failed — ${merged.error}`);
      return EXIT_FAILURE;
    }

    if (opts.strict) {
      const { validateReport } = await import('../reporting/invariants.js');
      validateReport(merged, { throwOnError: true });
    }

    let waiverResult = null;
    let effectiveFindings = merged.findings;
    if (opts.ignoreFile) {
      const { readFile } = await import('node:fs/promises');
      const raw = decodeCapturedOutput(await readFile(opts.ignoreFile));
      const { waivers } = parseWaiverFile(raw);
      waiverResult = applyWaivers(merged.findings, waivers);
      effectiveFindings = waiverResult.kept;
      for (const f of waiverResult.waived) f.waived = true;
      for (const w of waiverResult.warnings) console.error(w);
    }

    let diff = null;
    if (opts.baseline) {
      const baselineRun = await loadBaselineRun(opts.baseline);
      diff = diffRuns(baselineRun, { ...merged, findings: effectiveFindings });
      diff.baselineRunId = baselineRun.runId || String(opts.baseline);
    }

    const gate = evaluateBaselineGate({
      findings: effectiveFindings,
      score: merged.score,
      failOn: opts.failOn,
      minScore: opts.minScore,
      diff,
    });

    const outPayload = {
      ...merged,
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
      threshold: opts.failOn,
      minScore: opts.minScore,
      failed: gate.failed,
    };

    await writeReportFiles(merged, { junitPath: opts.junitPath, sarifPath: opts.sarifPath });
    if (opts.htmlPath) {
      await mkdir(path.dirname(path.resolve(opts.htmlPath)), { recursive: true });
      await writeFile(opts.htmlPath, toHtml(merged, { gate, waiverResult }), 'utf8');
    }
    if (opts.markdownPath) {
      await mkdir(path.dirname(path.resolve(opts.markdownPath)), { recursive: true });
      await writeFile(opts.markdownPath, toMarkdown(merged, { diff, gate }), 'utf8');
    }
    if (opts.outPath) {
      await mkdir(path.dirname(path.resolve(opts.outPath)), { recursive: true });
      await writeFile(opts.outPath, JSON.stringify(outPayload, null, 2) + '\n', 'utf8');
    }

    const machineOutput = opts.format !== 'text';
    if (opts.format === 'json') {
      process.stdout.write(JSON.stringify(outPayload, null, 2) + '\n');
    } else if (opts.format === 'junit') {
      process.stdout.write(toJUnitXml(merged));
    } else if (opts.format === 'sarif') {
      process.stdout.write(JSON.stringify(toSarif(merged), null, 2) + '\n');
    } else if (opts.format === 'markdown') {
      process.stdout.write(toMarkdown(merged, { diff, gate }));
    } else {
      const shownScore = merged.score == null ? '?' : Math.round(Number(merged.score) * 10) / 10;
      console.log(`QualityPilot merged report (${reports.length} shard(s))`);
      console.log(`URL: ${merged.url || '—'} | Pages: ${merged.coverage?.pagesScanned ?? merged.pages?.length ?? 0} | Score: ${shownScore}/100 | Findings: ${merged.findings.length}`);
      if (diff) console.log(`Baseline ${diff.baselineRunId}: ${diff.summary}`);
    }

    const waiverNote = waiverResult && waiverResult.waived.length > 0
      ? ` · waivers: ${waiverResult.waived.length} suppressed (--min-score still uses the unwaived run score)`
      : '';
    (machineOutput ? process.stderr : process.stdout).write(`${gate.reason}${waiverNote}\n`);

    if (process.env.GITHUB_STEP_SUMMARY) {
      const { appendFile } = await import('node:fs/promises');
      await appendFile(process.env.GITHUB_STEP_SUMMARY, toMarkdown(merged, { diff, gate }), 'utf8');
    }

    return gate.exitCode === EXIT_OK ? EXIT_OK : EXIT_THRESHOLD;
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    return EXIT_USAGE;
  }
}

const invokedDirectly = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  mergeReportsMain(process.argv)
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(err);
      process.exitCode = EXIT_FAILURE;
    });
}
