#!/usr/bin/env node
/**
 * qualitypilot — public CLI entry point.
 *
 * Subcommands:
 *   qualitypilot check <url> [options]   CI quality-gate scan (delegates to
 *                                    src/cli/check.js — parseArgs options:
 *                                    --fail-on, --min-score, --max-pages,
 *                                    --max-depth, --timeout, --junit, --sarif,
 *                                    --format, --json, --strict)
 *
 * The MCP server ships as the separate `qualitypilot-mcp` command
 * (src/mcp/stdio.js) so MCP clients can launch it directly.
 *
 * Exit codes mirror src/cli/check.js: 0 pass, 1 gate failed, 64 usage,
 * 70 scan failure.
 */
import { checkMain } from './check.js';

const args = process.argv.slice(2);
const command = args[0];

if (command === 'check') {
  // checkMain expects an argv shaped like [node, script, ...args].
  const result = await checkMain(['qualitypilot', 'check', ...args.slice(1)]);
  process.exitCode = result;
} else if (command === 'export') {
  const { exportMain } = await import('./export.js');
  process.exitCode = await exportMain(['qualitypilot', 'export', ...args.slice(1)]);
} else if (command === 'replay') {
  const { replayMain } = await import('./replay.js');
  process.exitCode = await replayMain(['qualitypilot', 'replay', ...args.slice(1)]);
} else if (command === 'report') {
  const { reportMain } = await import('./report.js');
  process.exitCode = await reportMain(['qualitypilot', 'report', ...args.slice(1)]);
} else {
  console.error('Usage: qualitypilot <command> [options]');
  console.error('');
  console.error('Commands:');
  console.error('  check <url> [options]      CI quality-gate scan');
  console.error('  export <plan.json>         export a plan for CI replay or standalone Playwright');
  console.error('                             [--format plan|specs|both] [--out <dir>]');
  console.error('                             [--storage-state <role>=<path>]');
  console.error('  replay <plan.json>         replay an exported plan against a target (--url)');
  console.error('                             with the full matrix + classifiers, no LLM needed');
  console.error('  report <run.json>          turn a saved run into a shareable HTML/markdown report');
  console.error('                             [--html <out.html>] [--markdown <out.md>] [--ignore-file <f>]');
  console.error('');
  console.error('Check options:');
  console.error('  --fail-on <sev|list>   single severity = threshold ("at or above");');
  console.error('                         comma list = confirmed findings at those severities');
  console.error('  --min-score <n>        fail when the score is below n (0-100)');
  console.error('  --max-pages <n>        max pages to crawl (default 10)');
  console.error('  --max-depth <n>        max crawl depth (default 1)');
  console.error('  --timeout <ms>         run timeout (default 120000)');
  console.error('  --junit <file>         write a JUnit XML report');
  console.error('  --sarif <file>         write a SARIF 2.1.0 report');
  console.error('  --format <fmt>         stdout format: json | junit | sarif');
  console.error('  --strict               fail on report invariant violations');
  console.error('');
  console.error('The MCP server is the separate `qualitypilot-mcp` command.');
  process.exitCode = 64;
}
