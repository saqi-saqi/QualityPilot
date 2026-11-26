/**
 * src/cli/report.js — `testigator report <run.json>`: turn a saved run
 * report into a shareable artifact.
 *
 *   testigator report <run.json> --html report.html [--ignore-file f] [--fail-on <sev|list>]
 *
 * The HTML output is a single self-contained file (inline CSS, no scripts,
 * no external assets) — the thing you attach to a ticket or a release.
 * Waivers (--ignore-file) annotate suppressed findings in the report instead
 * of hiding them.
 */

import { writeFile } from 'node:fs/promises';
import { loadBaselineRun, evaluateBaselineGate } from './check.js';
import { toHtml } from '../reporting/html.js';
import { toMarkdown } from '../reporting/markdown.js';
import { parseWaiverFile, applyWaivers } from '../services/waivers.js';
import { decodeCapturedOutput } from '../utils/jsonDocument.js';

const EXIT_OK = 0;
const EXIT_USAGE = 64;

function parseArgs(argv) {
  const args = argv.slice(2);
  const runFile = args.find(a => !a.startsWith('--'));
  const opts = { html: null, markdown: null, ignoreFile: null, failOn: 'none' };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue; // positional: the run file (captured above)
    if (a === '--html') { opts.html = args[++i]; if (!opts.html) throw new Error('--html requires an output path'); }
    else if (a === '--markdown') { opts.markdown = args[++i]; if (!opts.markdown) throw new Error('--markdown requires an output path'); }
    else if (a === '--ignore-file') { opts.ignoreFile = args[++i]; if (!opts.ignoreFile) throw new Error('--ignore-file requires a path'); }
    else if (a === '--fail-on') { opts.failOn = args[++i]; if (!opts.failOn) throw new Error('--fail-on requires a severity or list'); }
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!runFile) throw new Error('Usage: testigator report <run.json> [--html <out.html>] [--markdown <out.md>] [--ignore-file <f>] [--fail-on <sev|list>]');
  return { runFile, ...opts };
}

export async function reportMain(argv = process.argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    return EXIT_USAGE;
  }

  try {
    // loadBaselineRun is the tolerant run-JSON loader (BOM, UTF-16, log noise).
    const run = await loadBaselineRun(parsed.runFile);
    if (!run || !Array.isArray(run.findings)) {
      console.error(`ERROR: no findings array in ${parsed.runFile}`);
      return EXIT_USAGE;
    }

    let waiverResult = null;
    if (parsed.ignoreFile) {
      const raw = decodeCapturedOutput(await import('node:fs/promises').then(fs => fs.readFile(parsed.ignoreFile)));
      const { waivers } = parseWaiverFile(raw);
      waiverResult = applyWaivers(run.findings, waivers);
      for (const w of waiverResult.warnings) console.error(w);
    }

    const gateFindings = waiverResult ? waiverResult.kept : run.findings;
    const gate = evaluateBaselineGate({ findings: gateFindings, score: run.score, failOn: parsed.failOn });

    if (parsed.html) {
      await writeFile(parsed.html, toHtml(run, { gate, waiverResult }), 'utf8');
      console.log(`Wrote ${parsed.html}`);
    }
    if (parsed.markdown) {
      await writeFile(parsed.markdown, toMarkdown(run, { gate }), 'utf8');
      console.log(`Wrote ${parsed.markdown}`);
    }
    if (!parsed.html && !parsed.markdown) {
      console.error('Nothing to do — pass --html <out.html> and/or --markdown <out.md>');
      return EXIT_USAGE;
    }
    return EXIT_OK;
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    return EXIT_USAGE;
  }
}
